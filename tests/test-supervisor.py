#!/usr/bin/env python3
"""nth_supervisor lifecycle test — spawn / session-capture / feed / hibernate /
wake(resume) / stop — driven against tests/fake_agent.py so NO real billed
Claude session is ever launched.
"""
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

# Point the supervisor at the fake stream-json agent BEFORE importing it isn't
# necessary (agent_binary reads the env at call time), but set it up front.
import os  # noqa: E402
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"

import nth_supervisor as sup  # noqa: E402

failures = 0


def check(label, cond):
    global failures
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures += 1


AGENTS_DDL = """
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
  base_prompt TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'stopped',
  managed INTEGER NOT NULL DEFAULT 1, session_id TEXT, pid INTEGER, owner TEXT,
  created_at TEXT NOT NULL, last_active_at TEXT);
"""


def main() -> int:
    import sqlite3
    tmp = Path(tempfile.mkdtemp(prefix="nth-sup-test-"))
    db_path = tmp / "nth.db"
    db = sqlite3.connect(str(db_path))
    db.executescript(AGENTS_DDL)
    db.execute("INSERT INTO agents (id, name, model, created_at) "
               "VALUES ('ag1', 'Aragorn', 'sonnet', ?)", (sup.now_iso(),))
    db.commit()
    db.close()

    # Collect assistant echoes off the reader thread.
    echoes = []
    got_echo = threading.Event()

    def on_event(agent_id, evt):
        if evt.get("type") == "assistant":
            echoes.append(evt["message"]["content"])
            got_echo.set()

    s = sup.AgentSupervisor(db_path=db_path, on_event=on_event)

    # ── spawn ──
    proc = s.spawn("ag1", model="sonnet")
    check("spawn captures session_id from init", proc.session_id == "sess-fake-sonnet-001")
    check("spawn: process alive", proc.alive())
    row = _row(db_path, "ag1")
    check("spawn: db state=running", row["state"] == "running")
    check("spawn: db pid set", row["pid"] == proc.pid and proc.pid is not None)
    check("spawn: db session_id persisted", row["session_id"] == "sess-fake-sonnet-001")

    # ── feed (inbound routing, channel-tagged) ──
    ok = s.feed("ag1", "alpha", "hello there")
    got_echo.wait(3.0)
    check("feed: returns True", ok)
    check("feed: agent echoed the channel-tagged message",
          any("[#alpha] hello there" in e for e in echoes))

    # ── hibernate: process dies, session_id retained ──
    s.hibernate("ag1")
    time.sleep(0.2)
    row = _row(db_path, "ag1")
    check("hibernate: db state=sleeping", row["state"] == "sleeping")
    check("hibernate: pid cleared", row["pid"] is None)
    check("hibernate: session_id retained for resume", row["session_id"] == "sess-fake-sonnet-001")
    check("hibernate: process not alive", not proc.alive())
    check("hibernate: supervisor no longer lists it live", "ag1" not in s.live_ids())

    # ── wake: resume from the SAME session_id ──
    woke = s.wake("ag1")
    check("wake: returns a proc", woke is not None)
    check("wake: resumed the SAME session_id", woke and woke.session_id == "sess-fake-sonnet-001")
    row = _row(db_path, "ag1")
    check("wake: db state=running again", row["state"] == "running")

    # ── stop: terminal ──
    s.stop("ag1")
    time.sleep(0.2)
    row = _row(db_path, "ag1")
    check("stop: db state=stopped", row["state"] == "stopped")
    check("stop: pid cleared", row["pid"] is None)
    check("stop: not running", not s.is_running("ag1"))

    s.shutdown()
    print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
    return 1 if failures else 0


def _row(db_path, agent_id):
    import sqlite3
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    try:
        return db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
