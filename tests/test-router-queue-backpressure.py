#!/usr/bin/env python3
"""AgentRouter queue-backpressure regression.

The old tick() used put_nowait, so a transient full queue (the common case
under a burst) permanently lost the message AND advanced last_id past it —
no retry path. The fix uses a bounded blocking put (timeout=1s): a transient
spike becomes a brief wait. This test deterministically reproduces the race
by filling a tiny queue, sending a targeted message, draining one item mid-
put, and asserting the message was queued (not lost). With put_nowait the
message is dropped immediately.
"""
import json
import os
import queue
import sqlite3
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"

import nth_server as srv  # noqa: E402
import nth_web as web      # noqa: E402

failures = []


def check(label, cond):
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures.append(label)


tmp = Path(__import__("tempfile").mkdtemp(prefix="nth_routerq_"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
web._DB_PATH_GLOBAL = srv.DB_PATH

host = json.loads(srv.nth_connect(summary="t", name="Host", channel="rq"))
aid = "ag_rq"
now = srv.now_iso()
db = srv.get_db()
db.execute("INSERT INTO agents (id, name, model, state, managed, created_at, wake_mode) "
           "VALUES (?, 'RQ', 'sonnet', 'stopped', 1, ?, 'all')", (aid, now))
db.execute("INSERT INTO members (id, channel, name, summary, skills, last_seen, "
           "joined_at, active, kind) VALUES (?, 'rq', 'RQ', '', '', ?, ?, 1, 'agent')",
           (aid, now, now))
db.execute("INSERT INTO agent_channels (agent_id, channel, member_id, joined_at) "
           "VALUES (?, 'rq', ?, ?)", (aid, aid, now))
db.commit()
db.close()

# Build a router but DON'T start its threads — drive tick() by hand so we
# control the queue and the drain timing.
router = web.AgentRouter(srv.DB_PATH, supervisor=None, interval=0.2)
# Tiny queue so we can fill it with one item.
router._q = queue.Queue(maxsize=1)
# Prime last_id to the current max so tick only sees messages we insert after.
db0 = sqlite3.connect(str(srv.DB_PATH))
db0.row_factory = sqlite3.Row
router.last_id = db0.execute("SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0]

# Fill the queue with a placeholder item (simulating a prior queued message).
router._q.put_nowait(("placeholder", "rq", "x", [], 0, ""))
assert router._q.full()

# Insert a targeted message (wake_mode=all routes ambient) AFTER last_id.
mid = json.loads(srv.nth_send(channel="rq", member_id=host["member_id"],
                              message="routed while full"))["message_id"]

# Run tick() in a thread — with the bounded put it should BLOCK waiting for
# space; with put_nowait it would drop immediately. The DB connection must
# be created INSIDE the tick thread (SQLite forbids cross-thread use).
tick_done = threading.Event()


def run_tick():
    try:
        tdb = sqlite3.connect(str(srv.DB_PATH), timeout=5)
        tdb.row_factory = sqlite3.Row
        router.tick(tdb)
        tdb.close()
    except Exception as e:
        sys.stderr.write(f"tick raised: {e}\n")
    finally:
        tick_done.set()


t = threading.Thread(target=run_tick)
t.start()
time.sleep(0.3)  # let tick reach the put; it should be blocking (not done)
check("tick blocks on a full queue (bounded put, not immediate drop)",
      not tick_done.is_set())

# Drain the placeholder — the bounded put should now succeed and queue the
# real message.
drained = router._q.get_nowait()
check("drained the placeholder item", drained[0] == "placeholder")
tick_done.wait(3.0)
check("tick completed after the drain (message queued, not lost)",
      tick_done.is_set())

# The real message should now be in the queue.
try:
    item = router._q.get_nowait()
    check("routed message was queued despite transient full queue",
          item[0] == aid and "routed while full" in item[2])
except queue.Empty:
    check("routed message was queued despite transient full queue", False)

db0.close()

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
