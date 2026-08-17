#!/usr/bin/env bash
# Spin up the integration dashboard in a throwaway sandbox.
#
# INTEGRATION BRANCH ONLY — this script is a local test harness and must never
# land on a feature branch headed upstream.
#
# Everything lives under one scratch directory: its own database, its own
# attachments tree, its own port. Your real ~/.claude/nth is never opened for
# writing. That matters here specifically: attachments.path stores ABSOLUTE
# paths, and the attachment GC deletes files it believes are orphans, so
# pointing a server at a copy of the real database used to delete the real
# files. nth_web.py now derives its attachment root from --db, and this script
# leans on that — it seeds a fresh database rather than copying yours.
#
#   bash try-integration.sh          # build sandbox + run
#   bash try-integration.sh --reset  # discard the sandbox and rebuild
#   bash try-integration.sh --port N # pick a port (default 8899)
#
# Ctrl-C stops the server. The sandbox persists between runs so your typing,
# themes and settings survive; --reset wipes it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="${NTH_TRY_DIR:-${TMPDIR:-/tmp}/nth-integration-try}"
PORT=8899
RESET=0
CHANNEL=demo

while [ $# -gt 0 ]; do
    case "$1" in
        --reset) RESET=1; shift ;;
        --port)  PORT="${2:?--port needs a number}"; shift 2 ;;
        --help|-h) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

REAL_DB="$HOME/.claude/nth/nth.db"
DB="$SANDBOX/nth.db"

[ "$RESET" = 1 ] && rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"

# Refuse to run if the sandbox somehow resolves inside the real data directory.
case "$(cd "$SANDBOX" && pwd -P)/" in
    "$(cd "$HOME/.claude/nth" 2>/dev/null && pwd -P)/"*)
        echo "refusing to run: sandbox is inside your real ~/.claude/nth" >&2; exit 1 ;;
esac

PY="${PY:-python3}"

if [ ! -f "$DB" ]; then
    echo "building sandbox at $SANDBOX"
    "$PY" - "$REAL_DB" "$DB" "$CHANNEL" <<'PYEOF'
"""Create an EMPTY database with the real schema, then seed demo content.

The schema is copied from the installed database rather than hardcoded, so
this cannot drift as migrations land. It is opened read-only; not one byte is
written to it. No rows are copied — the seed below is entirely synthetic.
"""
import sqlite3, sys, time
from datetime import datetime, timedelta, timezone

real, dest, chan = sys.argv[1], sys.argv[2], sys.argv[3]

src = sqlite3.connect(f"file:{real}?mode=ro", uri=True)
schema = [r[0] for r in src.execute(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")]
src.close()

db = sqlite3.connect(dest)
db.execute("PRAGMA journal_mode=WAL")
for stmt in schema:
    try:
        db.execute(stmt)
    except sqlite3.Error:
        pass          # indexes on tables this build doesn't have

def cols(t):
    return {r[1] for r in db.execute(f"PRAGMA table_info({t})")}

# The schema above comes from the INSTALLED database, which can be older than
# the branch under test. A missing column is not a loud failure: the roster
# query catches OperationalError and falls back to a variant without turn data,
# so the working/idle dot silently degrades to a plain green "active" and the
# feature looks broken when it is only unqueryable. Add what this build needs.
for table, column, decl in [
    ("members", "context_json", "TEXT"),
    ("sessions", "last_turn_end", "TEXT"),
    ("sessions", "last_tool_name", "TEXT"),
    ("sessions", "last_tool_target", "TEXT"),
    ("sessions", "last_tool_at", "TEXT"),
    ("sessions", "blocked_since", "TEXT"),
]:
    if column not in cols(table):
        try:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
            print(f"  added missing column {table}.{column}")
        except sqlite3.Error:
            pass

def insert(table, **vals):
    have = cols(table)
    vals = {k: v for k, v in vals.items() if k in have}
    q = ",".join(vals)
    db.execute(f"INSERT OR REPLACE INTO {table} ({q}) VALUES ({','.join('?'*len(vals))})",
               tuple(vals.values()))

now = datetime.now(timezone.utc)
def ts(minutes_ago):
    return (now - timedelta(minutes=minutes_ago)).isoformat()

insert("channels", code=chan, status="active",
       created_at=ts(120), updated_at=ts(0))

# One live agent, one idle, one long-dead — so the working/idle dot and the
# cull button both have something real to act on.
people = [
    ("agent-scout",  "Scout",   0,   "working: indexing the repo"),
    ("agent-smith",  "Smith",   3,   "idle"),
    ("agent-ghost",  "Ghost",   180, "standing by"),
]
for mid, name, stale_min, status in people:
    insert("members", id=mid, channel=chan, name=name, active=1, kind="agent",
           joined_at=ts(120), last_seen=ts(stale_min), last_read=0,
           filter_mode="all", status_text=status, status_changed_at=ts(stale_min),
           messenger_heartbeat=ts(stale_min), watchdog_heartbeat=ts(stale_min),
           model="claude-opus-5")

msgs = [
    ("agent-scout", "Scout", "[joined] Scout", 118, "", ""),
    ("agent-smith", "Smith", "[joined] Smith", 117, "", ""),
    ("agent-scout", "Scout",
     "Starting the sweep. Findings will land in this channel.", 116, "", ""),
    ("agent-smith", "Smith",
     "Config lives at " + __import__("os").path.expanduser("~/.claude/nth/nth.db")
     + " and the server is at ./server/nth_web.py — both should linkify.", 92, "", ""),
    ("agent-scout", "Scout",
     "A path that does NOT exist: /nope/not/here.txt — this one must stay plain text.",
     91, "", ""),
    ("agent-smith", "Smith",
     "@Scout can you confirm the checksum? Also #Ghost for the record.", 74,
     "agent-scout", "agent-ghost"),
    ("agent-scout", "Scout",
     "Confirmed. Here is a **markdown** list:\n\n- one\n- two\n- [x] done", 73, "", ""),
    ("agent-ghost", "Ghost", "Acknowledged, going quiet.", 70, "", ""),
    ("agent-smith", "Smith",
     "@all heads up — rotating credentials in ten minutes.", 41, "all", ""),
    ("agent-scout", "Scout",
     "Search for the word GRAPEFRUIT to test full-history search.", 40, "", ""),
]
import json
def ids(s):
    """mentions/refs/bangs are JSON arrays on the wire — parse_mentions_json
    returns [] for anything else, so a bare 'agent-scout' silently renders as
    no mention at all."""
    return json.dumps([x for x in s.split(",") if x])

for i, (mid, mname, content, ago, mentions, refs) in enumerate(msgs, start=1):
    insert("messages", id=i, channel=chan, member_id=mid, member_name=mname,
           content=content, created_at=ts(ago), mentions=ids(mentions),
           refs=ids(refs), bangs=ids(""))

# Enough filler to make the unread divider and the #N gutter worth looking at.
n = len(msgs)
for k in range(1, 26):
    n += 1
    insert("messages", id=n, channel=chan, member_id="agent-scout", member_name="Scout",
           content=f"progress tick {k} — scanning module {k}", created_at=ts(38 - k),
           mentions=ids(""), refs=ids(""), bangs=ids(""))

db.commit(); db.close()
print(f"  seeded channel '{chan}' with {n} messages and {len(people)} members")
PYEOF
else
    echo "reusing sandbox at $SANDBOX  (--reset to rebuild)"
fi

# Fail loudly rather than let nth_web.py scan to another port: the banner would
# name a port the server never bound, and a second sandbox would quietly serve a
# different database on a port nobody was told about.
if "$PY" - "$PORT" <<'PYEOF'
import socket, sys
s = socket.socket()
# SO_REUSEADDR because ThreadingHTTPServer sets allow_reuse_address: without it
# a socket still in TIME_WAIT from a server we just stopped reads as "in use"
# and this check blocks a start that would actually have succeeded.
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[1]))); sys.exit(1)   # free
except OSError:
    sys.exit(0)                                            # in use
finally:
    s.close()
PYEOF
then
    echo "port $PORT is already in use — something is serving there already." >&2
    echo "Stop it, or pass --port with a free one. Refusing to start a second" >&2
    echo "server on a different port than this banner would advertise." >&2
    exit 1
fi

cat <<BANNER

  sandbox   $SANDBOX
  database  $DB
  attach    $SANDBOX/attachments   (derived from --db; your real files are untouched)

  Opening http://127.0.0.1:$PORT/?channel=$CHANNEL

  What to try — one line per feature going upstream:

    dictation        mic button in the composer. Settings -> Dictation -> "Test >"
                     reports whether the local engine is installed.
    image attach     the picture button, or paste/drop an image into the box
    file path links  the paths in Smith's message linkify; /nope/not/here.txt does not
    search           the magnifier; look for GRAPEFRUIT
    jump to unread   scroll up, then use the unread divider / jump control
    #N gutter        toggle message numbers in Settings
    @mentions        Smith's "@Scout" renders as a chip; "@all" shimmers
    chimes           Settings -> Sound; @all and mentions chime differently
    working/idle     roster dots: Scout live, Smith idle, Ghost stale (3h)
    cull             remove Ghost from the roster via the roster's x
    agents           the Agents page — create one, pick provider/model/effort.
                     Claude is always offered; Codex needs `codex` on PATH and
                     an authenticated App Server.

  Ctrl-C to stop.

BANNER

# LANDING MODE (no channel argument) on purpose. Managed agent control is
# gated on it — nth_web sets _agent_control_enabled = (args.channel is None),
# because creating and stopping agents is a fleet-level act, not something a
# single channel's dashboard should own. Passing "$CHANNEL" here turned the
# whole Agents page into "managed agents are off on this server", which is the
# opposite of what a sandbox meant for exercising every feature wants.
# The channel dashboard is still one click (or one URL) away: /?channel=<code>
# serves the app, and the landing page links every channel.
exec "$PY" "$HERE/server/nth_web.py" --db "$DB" --port "$PORT"
