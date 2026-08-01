#!/usr/bin/env python3
"""Plain Claude stdout is bridged unless the agent already posted via MCP."""
import collections
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"

import nth_server as srv  # noqa: E402
import nth_supervisor as sup  # noqa: E402
from nth_constants import AGENT_INBOX_CHANNEL  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + ": " + name)
    if not condition:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth_output_bridge_"))
db_path = tmp / "nth.db"
agent_id = "ag_bridge"
operator_id = "_op_l_bridge"
manager = None
try:
    db = srv.get_db(db_path)
    now = srv.now_iso()
    db.execute("INSERT INTO channels (code,status,created_at,updated_at) VALUES (?,'active',?,?)",
               (AGENT_INBOX_CHANNEL, now, now))
    db.execute("INSERT INTO agents (id,name,model,state,managed,created_at) "
               "VALUES (?, 'Bridge Agent', 'sonnet', 'stopped', 1, ?)", (agent_id, now))
    for mid, name, kind in ((agent_id, "Bridge Agent", "agent"),
                            (operator_id, "Operator", "human")):
        db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,joined_at,active,kind) "
                   "VALUES (?,?,?,'','',?,?,1,?)",
                   (mid, AGENT_INBOX_CHANNEL, name, now, now, kind))
    db.execute("INSERT INTO messages (channel,member_id,member_name,content,recipients,created_at) "
               "VALUES (?,?,?,?,?,?)",
               (AGENT_INBOX_CHANNEL, operator_id, "Operator", "private question",
                json.dumps([agent_id]), now))
    db.commit()
    db.close()

    manager = sup.AgentSupervisor(db_path=db_path)
    manager.spawn(agent_id, model="sonnet")
    check("feed reaches the fake headless agent",
          manager.feed(agent_id, AGENT_INBOX_CHANNEL, "Operator: answer me"))
    deadline = time.monotonic() + 3
    reply = None
    while time.monotonic() < deadline:
        db = sqlite3.connect(str(db_path)); db.row_factory = sqlite3.Row
        reply = db.execute(
            "SELECT * FROM messages WHERE channel=? AND member_id=? ORDER BY id DESC LIMIT 1",
            (AGENT_INBOX_CHANNEL, agent_id)).fetchone()
        db.close()
        if reply:
            break
        time.sleep(0.02)
    check("plain result is published into the originating conversation",
          reply is not None and "answer me" in reply["content"])
    check("bridged inbox result remains private to the operator",
          reply is not None and json.loads(reply["recipients"]) == [operator_id])

    db = sqlite3.connect(str(db_path))
    baseline = db.execute("SELECT MAX(id) FROM messages").fetchone()[0]
    db.execute("INSERT INTO messages (channel,member_id,member_name,content,recipients,created_at) "
               "VALUES (?,?,?,?,?,?)",
               (AGENT_INBOX_CHANNEL, agent_id, "Bridge Agent", "posted via MCP",
                json.dumps([operator_id]), srv.now_iso()))
    db.commit()
    before = db.execute("SELECT COUNT(*) FROM messages WHERE member_id=?", (agent_id,)).fetchone()[0]
    db.close()
    manager._pending[agent_id] = collections.deque([
        {"channel": AGENT_INBOX_CHANNEL, "baseline": baseline}])
    manager._bridge_result(agent_id, {
        "type": "result", "is_error": False, "result": "duplicate stdout"})
    db = sqlite3.connect(str(db_path))
    after = db.execute("SELECT COUNT(*) FROM messages WHERE member_id=?", (agent_id,)).fetchone()[0]
    db.close()
    check("an MCP-authored reply suppresses the stdout bridge", after == before)
finally:
    if manager is not None:
        manager.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
