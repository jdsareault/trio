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

    # ── non-dict JSON robustness (Uruk-Hai): reader must skip junk + still
    #    capture session_id, not crash the thread ──
    os.environ["FAKE_AGENT_PREJUNK"] = "1"
    db2 = sqlite3.connect(str(db_path))
    db2.execute("INSERT INTO agents (id, name, model, created_at) "
                "VALUES ('agjunk', 'Junk', 'sonnet', ?)", (sup.now_iso(),))
    db2.commit(); db2.close()
    pj = s.spawn("agjunk", model="sonnet")
    check("non-dict JSON lines skipped, session still captured",
          pj.session_id == "sess-fake-sonnet-001" and pj.alive())
    s.stop("agjunk")
    del os.environ["FAKE_AGENT_PREJUNK"]

    # ── errored spawn (Ents): process dies before init → state=errored, popped ──
    os.environ["FAKE_AGENT_CRASH"] = "1"
    db3 = sqlite3.connect(str(db_path))
    db3.execute("INSERT INTO agents (id, name, model, created_at) "
                "VALUES ('agbad', 'Bad', 'sonnet', ?)", (sup.now_iso(),))
    db3.commit(); db3.close()
    bad = s.spawn("agbad", model="sonnet", session_timeout=1.0)
    check("errored spawn: process not alive", not bad.alive())
    check("errored spawn: db state=errored", _row(db_path, "agbad")["state"] == "errored")
    check("errored spawn: dropped from registry (no zombie)", "agbad" not in s.live_ids())
    del os.environ["FAKE_AGENT_CRASH"]

    # ── concurrent spawn of same agent → exactly one process (Ents) ──
    db4 = sqlite3.connect(str(db_path))
    db4.execute("INSERT INTO agents (id, name, model, created_at) "
                "VALUES ('agconc', 'Conc', 'sonnet', ?)", (sup.now_iso(),))
    db4.commit(); db4.close()
    results = {}

    def race(n):
        results[n] = s.spawn("agconc", model="sonnet")
    t1 = threading.Thread(target=race, args=(1,))
    t2 = threading.Thread(target=race, args=(2,))
    t1.start(); t2.start(); t1.join(); t2.join()
    check("concurrent spawn dedup: both callers get the SAME proc",
          results[1] is results[2] and results[1].pid is not None)

    # ── feed to a process that died out-of-band → False, and reconcile flips
    #    the stale 'running' row (Ents/Legolas) ──
    s._procs["agconc"].proc.kill()
    time.sleep(0.2)
    check("feed to dead process returns False", s.feed("agconc", "alpha", "x") is False)
    reaped = s.reconcile()
    check("reconcile reaps the dead agent", "agconc" in reaped)
    check("reconcile flips stale running→errored", _row(db_path, "agconc")["state"] == "errored")

    # ── wake an agent that never spawned (no session_id) → cold start ──
    db5 = sqlite3.connect(str(db_path))
    db5.execute("INSERT INTO agents (id, name, model, created_at) "
                "VALUES ('agcold', 'Cold', 'haiku', ?)", (sup.now_iso(),))
    db5.commit(); db5.close()
    cold = s.wake("agcold")
    check("wake with no session_id: cold-starts a fresh session",
          cold is not None and cold.session_id == "sess-fake-haiku-001")
    check("wake nonexistent agent returns None", s.wake("nope") is None)
    s.stop("agcold")

    # ── shutdown with a LIVE agent actually stops it (Ents: prior test popped
    #    everything before shutdown, so its body never ran) ──
    db6 = sqlite3.connect(str(db_path))
    db6.execute("INSERT INTO agents (id, name, model, created_at) "
                "VALUES ('aglive', 'Live', 'sonnet', ?)", (sup.now_iso(),))
    db6.commit(); db6.close()
    live = s.spawn("aglive", model="sonnet")
    check("shutdown precondition: agent live", live.alive())
    s.shutdown()
    time.sleep(0.2)
    check("shutdown stops a live agent", not live.alive())
    check("shutdown marks it stopped", _row(db_path, "aglive")["state"] == "stopped")

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
