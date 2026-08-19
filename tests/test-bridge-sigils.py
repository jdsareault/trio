#!/usr/bin/env python3
"""Bridged final responses resolve @/#/! sigils the same way nth_send does.

Before the fix, `_bridge_result` (both the Codex and Claude runtimes) wrote
`mentions` as the recipients list — empty on a public channel — and never
wrote `refs` or `bangs` at all. So a bridged reply ending in "@peer over to
you" never woke peer, human-side @-mention highlighting was suppressed for
every bridged message, and !bang was unreachable from a bridged reply.

This is the regression the audit's measurement plan calls out explicitly:
"Two agents in one channel. Agent A ends a turn with '@B please take this'
WITHOUT calling trio_send. Assert that B is woken."

It also covers the DM (agent-inbox) case: parsed sigils and DM recipients
must coexist (recipients drive visibility; sigils drive wake), and a sigil
naming a non-recipient must be narrowed away — the wake-vs-visibility
invariant.

Usage: python tests/test-bridge-sigils.py
"""
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server"
sys.path.insert(0, str(SERVER))

_tmp = Path(tempfile.mkdtemp(prefix="nth_bridge_sigils_"))
os.environ["NTH_HOME"] = str(_tmp)

import nth_server as srv          # noqa: E402
import nth_supervisor as sup      # noqa: E402
import nth_codex_runtime as codex # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


# Build the real schema by pointing nth_server at the temp DB and calling
# get_db() (which runs the full CREATE/ALTER migration ladder).
srv.DB_DIR = _tmp
srv.DB_PATH = _tmp / "nth.db"
DB_PATH = srv.DB_PATH
srv.get_db().close()


def fresh_roster():
    """Wipe messages/members for a clean channel, then plant two agents + a
    human. Returns the member ids."""
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    db.execute("DELETE FROM messages WHERE channel = 'room'")
    db.execute("DELETE FROM members WHERE channel = 'room'")
    now = srv.now_iso()
    # agents registry supplies the global display name the sigil parser also
    # matches against.
    db.execute("DELETE FROM agents WHERE id IN ('agA','agB')")
    db.execute("INSERT INTO agents (id, name, model, managed, created_at) "
               "VALUES ('agA','Archer','',1,?)", (now,))
    db.execute("INSERT INTO agents (id, name, model, managed, created_at) "
               "VALUES ('agB','Bellamy','',1,?)", (now,))
    db.execute("INSERT INTO members (id, channel, name, joined_at, last_seen, "
               "last_read, active, kind) VALUES "
               "('agA','room','Archer',?,?,0,1,'agent')", (now, now))
    db.execute("INSERT INTO members (id, channel, name, joined_at, last_seen, "
               "last_read, active, kind) VALUES "
               "('agB','room','Bellamy',?,?,0,1,'agent')", (now, now))
    db.execute("INSERT INTO members (id, channel, name, joined_at, last_seen, "
               "last_read, active, kind) VALUES "
               "('_op_t_jd','room','JD',?,?,0,1,'human')", (now, now))
    db.commit()
    db.close()
    return "agA", "agB", "_op_t_jd"


def last_msg(channel):
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    row = db.execute(
        "SELECT id, content, mentions, refs, bangs, recipients "
        "FROM messages WHERE channel=? ORDER BY id DESC LIMIT 1",
        (channel,)).fetchone()
    db.close()
    return row


def _decode(raw):
    try:
        return json.loads(raw) if raw else []
    except (json.JSONDecodeError, TypeError):
        return []


# ── Codex runtime bridge ──────────────────────────────────────────────
# Construct without starting the App Server: __init__ only builds the
# client object (proc is None until ensure_started). Pass a no-op command
# so build_app_server_argv is never consulted.
cr = codex.CodexRuntimeManager(DB_PATH, command=["true"])


def run_codex_bridge(channel, text, *, source_sender=None):
    agA, _, _ = fresh_roster()
    # baseline = current max id in this channel, so already_posted is False.
    db = sqlite3.connect(str(DB_PATH))
    base = db.execute(
        "SELECT COALESCE(MAX(id),0) FROM messages WHERE channel=?", (channel,)
    ).fetchone()[0]
    db.close()
    ctx = {"channel": channel, "baseline": base,
           "source_message_id": base + 1, "source_sender": source_sender}
    cr._bridge_result(agA, ctx, text)


# Public channel: @B and #B both resolve; !B too.
run_codex_bridge("room", "Done. @Bellamy over to you. Also #Bellamy fyi. !Bellamy urgent.")
m = last_msg("room")
agA, agB, _ = "agA", "agB", "_op_t_jd"
check("codex public: mentions includes agB (peer wakes)",
      agB in _decode(m["mentions"]))
check("codex public: refs includes agB",
      agB in _decode(m["refs"]))
check("codex public: bangs includes agB (!bang reachable from bridge)",
      agB in _decode(m["bangs"]))
check("codex public: recipients empty (broadcast, not a DM)",
      _decode(m["recipients"]) == [])
check("codex public: content preserved verbatim",
      m["content"] == "Done. @Bellamy over to you. Also #Bellamy fyi. !Bellamy urgent.")

# Public channel: a sigil naming a NON-member is inert (no phantom wake).
run_codex_bridge("room", "@Nobody here.")
m = last_msg("room")
check("codex public: unknown name resolves to no mentions",
      _decode(m["mentions"]) == [])
check("codex public: unknown name resolves to no bangs",
      _decode(m["bangs"]) == [])

# DM (agent-inbox): recipient drives visibility; sigils narrowed to
# participants. The human JD is the source_sender/recipient; agB is NOT a
# recipient, so an @Bellamy in the DM must be narrowed away — it can
# neither wake nor expose agB.
run_codex_bridge(srv.AGENT_INBOX_CHANNEL,
                 "Got it @Bellamy — handling this now.",
                 source_sender="_op_t_jd")
m = last_msg(srv.AGENT_INBOX_CHANNEL)
check("codex DM: recipient is the source sender (visibility)",
      _decode(m["recipients"]) == ["_op_t_jd"])
check("codex DM: recipient auto-added to mentions so the DM wakes them",
      "_op_t_jd" in _decode(m["mentions"]))
check("codex DM: @non-recipient narrowed away (wake-vs-visibility)",
      agB not in _decode(m["mentions"]))
check("codex DM: @non-recipient narrowed out of refs too",
      agB not in _decode(m["refs"]))
check("codex DM: @non-recipient narrowed out of bangs too",
      agB not in _decode(m["bangs"]))


# ── Claude supervisor bridge ──────────────────────────────────────────
# Same matrix against the Claude runtime. The supervisor constructor does
# not spawn anything either; _bridge_result only touches the DB.
cs = sup.AgentSupervisor(db_path=DB_PATH)


def run_claude_bridge(channel, text, *, source_sender=None):
    agA, _, _ = fresh_roster()
    db = sqlite3.connect(str(DB_PATH))
    base = db.execute(
        "SELECT COALESCE(MAX(id),0) FROM messages WHERE channel=?", (channel,)
    ).fetchone()[0]
    db.close()
    # _bridge_result pops one context off _pending; plant exactly one.
    import collections
    cs._pending["agA"] = collections.deque([
        {"channel": channel, "baseline": base,
         "source_message_id": base + 1, "source_sender": source_sender}])
    evt = {"type": "result", "result": text, "is_error": False}
    cs._bridge_result("agA", evt)


run_claude_bridge("room", "Done. @Bellamy over to you. Also #Bellamy fyi. !Bellamy urgent.")
m = last_msg("room")
check("claude public: mentions includes agB (peer wakes)",
      agB in _decode(m["mentions"]))
check("claude public: refs includes agB",
      agB in _decode(m["refs"]))
check("claude public: bangs includes agB (!bang reachable from bridge)",
      agB in _decode(m["bangs"]))
check("claude public: recipients empty (broadcast, not a DM)",
      _decode(m["recipients"]) == [])

run_claude_bridge("room", "@Nobody here.")
m = last_msg("room")
check("claude public: unknown name resolves to no mentions",
      _decode(m["mentions"]) == [])

run_claude_bridge(srv.AGENT_INBOX_CHANNEL,
                  "Got it @Bellamy — handling this now.",
                  source_sender="_op_t_jd")
m = last_msg(srv.AGENT_INBOX_CHANNEL)
check("claude DM: recipient is the source sender (visibility)",
      _decode(m["recipients"]) == ["_op_t_jd"])
check("claude DM: recipient auto-added to mentions so the DM wakes them",
      "_op_t_jd" in _decode(m["mentions"]))
check("claude DM: @non-recipient narrowed away (wake-vs-visibility)",
      agB not in _decode(m["mentions"]))
check("claude DM: @non-recipient narrowed out of bangs too",
      agB not in _decode(m["bangs"]))


# ── already_posted suppression still works (regression guard) ─────────
# If the agent posted in-channel after baseline, the bridge must no-op so
# MCP-authored replies win. Plant a post- baseline message, then bridge.
agA, _, _ = fresh_roster()
db = sqlite3.connect(str(DB_PATH))
base = db.execute(
    "SELECT COALESCE(MAX(id),0) FROM messages WHERE channel='room'").fetchone()[0]
db.execute(
    "INSERT INTO messages (channel, member_id, member_name, content, created_at) "
    "VALUES ('room','agA','Archer','I already said this',?)", (srv.now_iso(),))
db.commit()
db.close()
import collections
cs._pending["agA"] = collections.deque([
    {"channel": "room", "baseline": base,
     "source_message_id": base + 1, "source_sender": None}])
cs._bridge_result("agA", {"type": "result",
                          "result": "This should be suppressed.",
                          "is_error": False})
m = last_msg("room")
check("already_posted: bridge suppressed when agent posted after baseline",
      m["content"] == "I already said this")


# ── empty / error results still no-op ────────────────────────────────
agA, _, _ = fresh_roster()
db = sqlite3.connect(str(DB_PATH))
base = db.execute(
    "SELECT COALESCE(MAX(id),0) FROM messages WHERE channel='room'").fetchone()[0]
db.close()
cs._pending["agA"] = collections.deque([
    {"channel": "room", "baseline": base,
     "source_message_id": base + 1, "source_sender": None}])
cs._bridge_result("agA", {"type": "result", "result": "   ", "is_error": False})
m = last_msg("room")
check("empty result: bridge no-ops on whitespace-only content",
      m is None or m["content"] != "   ")


print()
if failures:
    print(f"{len(failures)} FAILED:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("all bridge-sigil checks passed")
