#!/usr/bin/env python3
"""Provider dispatch and shared lifecycle behavior without real model calls."""
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

import nth_supervisor as nsup
from nth_agent_manager import UnifiedAgentSupervisor
from nth_codex_runtime import CodexRuntimeManager


failures = 0


def check(label, condition):
    global failures
    print(("PASS" if condition else "FAIL") + ": " + label)
    if not condition:
        failures += 1


tmp = Path(tempfile.mkdtemp(prefix="trio-runtime-manager-"))
db_path = tmp / "nth.db"
db = sqlite3.connect(str(db_path))
db.executescript("""
CREATE TABLE agents (
 id TEXT PRIMARY KEY, name TEXT, model TEXT DEFAULT '', base_prompt TEXT DEFAULT '',
 state TEXT DEFAULT 'stopped', managed INTEGER DEFAULT 1, session_id TEXT, pid INTEGER,
 effort TEXT DEFAULT '', runtime_provider TEXT DEFAULT 'claude', runtime_ref TEXT,
 cwd TEXT DEFAULT '', permission_profile TEXT DEFAULT 'balanced', wake_mode TEXT DEFAULT 'at',
 created_at TEXT, last_active_at TEXT);
CREATE TABLE agent_runtime_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, provider TEXT,
 runtime_ref TEXT, disposition TEXT, created_at TEXT);
CREATE TABLE messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, member_id TEXT,
 member_name TEXT, content TEXT, mentions TEXT DEFAULT '', recipients TEXT DEFAULT '[]',
 created_at TEXT);
CREATE TABLE members (
 id TEXT, channel TEXT, name TEXT, kind TEXT, active INTEGER, joined_at TEXT,
 last_seen TEXT, PRIMARY KEY(id, channel));
""")
now = "2026-08-01T00:00:00+00:00"
db.execute("INSERT INTO agents (id,name,model,runtime_provider,cwd,created_at) "
           "VALUES ('cl1','Claude','sonnet','claude',?,?)", (str(tmp), now))
db.execute("INSERT INTO agents (id,name,model,runtime_provider,cwd,created_at) "
           "VALUES ('cx1','Codex','fake-codex','codex',?,?)", (str(tmp), now))
db.commit(); db.close()

claude = nsup.AgentSupervisor(db_path=db_path)
codex = CodexRuntimeManager(
    db_path, command=[sys.executable, str(HERE / "fake_codex_app_server.py")])
manager = UnifiedAgentSupervisor(db_path, claude=claude, codex=codex)
try:
    check("provider lookup dispatches Claude", manager.manager_for("cl1") is claude)
    check("provider lookup dispatches Codex", manager.manager_for("cx1") is codex)
    handle = manager.spawn("cx1", model="fake-codex", cwd=str(tmp))
    check("unified spawn creates a Codex thread", handle.thread_id.startswith("thr_fake_"))
    check("unified live roster includes Codex", manager.live_ids() == ["cx1"])
    check("provider model discovery delegates", manager.list_models("codex")[0]["id"] == "fake-codex")
    codex._client.request("fake/request-approval", {"threadId": handle.thread_id})
    deadline = time.time() + 2
    pending = []
    while not pending and time.time() < deadline:
        pending = manager.pending_approvals()
        time.sleep(0.01)
    check("Codex approval requests enter the operator inbox",
          pending and pending[0]["agent_id"] == "cx1"
          and pending[0]["command"] == "git status")
    check("operator can resolve a pending approval",
          manager.resolve_approval(pending[0]["id"], "accept"))
    deadline = time.time() + 2
    decision = ""
    while not decision and time.time() < deadline:
        decision = codex._client.request("fake/approval-result").get("decision") or ""
        if not decision:
            time.sleep(0.01)
    check("approval decision returns asynchronously to App Server", decision == "accept")
    check("structured runtime activity stays available outside chat",
          any(row["method"] == "approval/pending" for row in manager.activity("cx1")))
    fresh = manager.clear("cx1", cwd=str(tmp))
    check("unified clear replaces Codex context", fresh.thread_id != handle.thread_id)
    db = sqlite3.connect(str(db_path))
    history = db.execute(
        "SELECT provider,runtime_ref,disposition FROM agent_runtime_history").fetchall()
    db.close()
    check("clear archives provider-neutral runtime history",
          history == [("codex", handle.thread_id, "cleared")])
    check("unified delete reaches the provider", manager.delete("cx1"))
    check("backward Claude process accessor remains available", manager._procs is claude._procs)
finally:
    manager.shutdown()

print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
raise SystemExit(1 if failures else 0)
