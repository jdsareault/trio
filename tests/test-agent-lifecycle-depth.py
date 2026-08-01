#!/usr/bin/env python3
"""Resume-on-restart and automatic idle hibernation, against fake_agent."""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server"
sys.path.insert(0, str(SERVER))
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"

import nth_server as srv  # noqa: E402
import nth_supervisor as sup  # noqa: E402
import nth_web as web  # noqa: E402

failed = []


def check(label, ok):
    print(("PASS" if ok else "FAIL") + ": " + label)
    if not ok:
        failed.append(label)


tmp = Path(tempfile.mkdtemp(prefix="nth_lifecycle_depth_"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
web._DB_PATH_GLOBAL = srv.DB_PATH
json.loads(srv.nth_connect(summary="host", name="Host", channel="life"))

aid = "ag_lifecycle"
now = srv.now_iso()
db = srv.get_db()
db.execute("INSERT INTO agents (id,name,model,state,managed,created_at) "
           "VALUES (?, 'Lifecycle', 'sonnet', 'stopped', 1, ?)", (aid, now))
db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,joined_at,active,kind) "
           "VALUES (?, 'life', 'Lifecycle','','',?,?,1,'agent')", (aid, now, now))
db.execute("INSERT INTO agent_channels (agent_id,channel,member_id,joined_at) "
           "VALUES (?, 'life', ?, ?)", (aid, aid, now))
db.commit(); db.close()

first = sup.AgentSupervisor(db_path=srv.DB_PATH)
first.spawn(aid, model="sonnet")
first.shutdown(preserve_sessions=True)
db = sqlite3.connect(str(srv.DB_PATH)); db.row_factory = sqlite3.Row
row = db.execute("SELECT state,session_id,pid FROM agents WHERE id=?", (aid,)).fetchone()
db.close()
check("graceful hub shutdown preserves a resumable sleeping row",
      row["state"] == "sleeping" and bool(row["session_id"]) and row["pid"] is None)

second = sup.AgentSupervisor(db_path=srv.DB_PATH)
resumed = web.resume_managed_agents(srv.DB_PATH, second)
check("daemon restart resumes previously-live managed agent",
      resumed == [aid] and second.is_running(aid))

old = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
db = sqlite3.connect(str(srv.DB_PATH))
db.execute("UPDATE agents SET state='idle', last_active_at=? WHERE id=?", (old, aid))
db.commit(); db.close()
reaper = web.AgentIdleReaper(srv.DB_PATH, second, idle_seconds=60)
slept = reaper.tick()
db = sqlite3.connect(str(srv.DB_PATH)); state = db.execute(
    "SELECT state FROM agents WHERE id=?", (aid,)).fetchone()[0]; db.close()
check("idle reaper hibernates stale live agent", slept == [aid] and state == "sleeping")

second.shutdown()
shutil.rmtree(tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failed else 'OK'} — {len(failed)} failure(s)")
raise SystemExit(1 if failed else 0)
