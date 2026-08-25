"""A displaced monitor must stop, not wake a muted process forever.

Revoking the loser's session token (see test-agent-reclaim.py) stops it from
SPEAKING, but the monitor holds no session — it reads the DB directly, keyed on
the members row. So without this check the displaced half of a duplicate
identity keeps waking on every mention, burning a billed turn per wake to
discover it cannot answer, and cannot recover: reconnecting needs a
reclaim_secret the winner already rotated away.

The check is opt-in via --session-token. Absent one the monitor cannot tell
which session is its own, and any guess would eventually kill a healthy agent
that merely reconnected mid-run — so no token means no opinion, which is also
what keeps old launch commands working.

Usage: python tests/test-monitor-session-revoked.py
"""
import json
import sqlite3
import sys
import tempfile
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
import nth_monitor as mon  # noqa: E402
import nth_server as srv  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth-mon-revoke-"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"

srv.nth_connect(summary="host", name="Host", channel="room")
db = sqlite3.connect(str(srv.DB_PATH))
db.execute("INSERT INTO agents (id, name, model, state, managed, created_at, "
           "reclaim_secret) VALUES ('ag_ayla','Ayla','sonnet','spawning',1,?,?)",
           (srv.now_iso(), "SECRET"))
db.commit()
db.close()

first = json.loads(srv.nth_connect(summary="a", name="Ayla", channel="room",
                                   resume_member_id="ag_ayla",
                                   reclaim_secret="SECRET"))
first_token = first["session_token"]


def run_monitor(token, seconds=6.0):
    """Run the monitor in a thread; return the events it emitted.

    It exits on its own when displaced. If it does not, the thread is left
    behind as a daemon and the empty/eventless result is the failure signal.
    """
    events = []
    original_emit = mon.emit
    mon.emit = lambda payload: events.append(payload)
    mon.DB_PATH = srv.DB_PATH

    def target():
        try:
            mon.monitor("room", "ag_ayla", filter_mode="all",
                        _db_path=srv.DB_PATH, session_token=token)
        except SystemExit:
            pass
        except Exception as e:               # surfaced via the empty result
            events.append({"event": "crash", "msg": str(e)})

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout=seconds)
    mon.emit = original_emit
    return events, t.is_alive()


# ── the displaced monitor exits ─────────────────────────────────────────────
# The twin reclaims, which revokes first_token.
second = json.loads(srv.nth_connect(summary="a", name="Ayla", channel="room",
                                    resume_member_id="ag_ayla",
                                    reclaim_secret="SECRET"))
check("the twin's reclaim produced a new token",
      second["session_token"] != first_token)

events, still_running = run_monitor(first_token)
check("a monitor holding a revoked token exits", not still_running)
check("...and says why, in one terminal event",
      any(e.get("event") == "session_revoked" for e in events))
check("...naming the member and channel",
      any(e.get("event") == "session_revoked"
          and e.get("member_id") == "ag_ayla" and e.get("channel") == "room"
          for e in events))
check("...and does not leak the token into the event",
      first_token not in json.dumps(events))


# ── the surviving monitor keeps running ─────────────────────────────────────
events, still_running = run_monitor(second["session_token"], seconds=3.0)
check("the CURRENT session's monitor keeps running", still_running)
check("...and does not report itself revoked",
      not any(e.get("event") == "session_revoked" for e in events))


# ── opt-in: no token, no opinion ────────────────────────────────────────────
# Same revoked state as the first case, but launched the old way.
events, still_running = run_monitor("", seconds=3.0)
check("a monitor launched WITHOUT a token is unaffected by revocation",
      still_running
      and not any(e.get("event") == "session_revoked" for e in events))


# ── an unknown token is treated as revoked ──────────────────────────────────
# Rows are deleted only a week after revocation, so an id absent from the
# table can never become valid again — waiting on it would idle forever.
events, still_running = run_monitor("s_never_existed")
check("a token absent from the table also stops the monitor",
      not still_running
      and any(e.get("event") == "session_revoked" for e in events))


# ── the CLI flag parses ─────────────────────────────────────────────────────
check("--session-token is read from argv",
      mon.parse_session_token_arg(
          ["--filter", "about", "--session-token", "s_abc"]) == "s_abc")
check("...and is absent-safe",
      mon.parse_session_token_arg(["--filter", "about"]) == "")
check("...and does not disturb --filter parsing",
      mon.parse_filter_arg(["--session-token", "s_abc", "--filter", "at"])
      == "at")
try:
    mon.parse_session_token_arg(["--session-token"])
    check("a valueless --session-token is rejected", False)
except ValueError:
    check("a valueless --session-token is rejected", True)

# The hint the server hands back must actually carry the flag, or nothing
# above ever runs in production.
hint = first.get("monitor_hint", "")
check("connect's monitor_hint passes the session token",
      "--session-token" in hint and first_token in hint)

print()
if failures:
    print(f"FAILED — {len(failures)} failure(s)")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("OK — 0 failure(s)")
