#!/usr/bin/env python3
"""Opt-in authenticated Codex smoke; starts one real model turn.

This file is intentionally named ``smoke-*`` rather than ``test-*`` so normal
test batteries never consume subscription usage.
"""
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "server"))

from nth_codex_runtime import CodexRuntimeManager


tmp = Path(tempfile.mkdtemp(prefix="trio-real-codex-"))
db_path = tmp / "nth.db"
db = sqlite3.connect(str(db_path))
db.executescript("""
CREATE TABLE agents (
 id TEXT PRIMARY KEY, name TEXT, model TEXT DEFAULT '', base_prompt TEXT DEFAULT '',
 state TEXT DEFAULT 'stopped', managed INTEGER DEFAULT 1, session_id TEXT, pid INTEGER,
 effort TEXT DEFAULT '', runtime_provider TEXT DEFAULT 'codex', runtime_ref TEXT,
 cwd TEXT DEFAULT '', permission_profile TEXT DEFAULT 'balanced', wake_mode TEXT DEFAULT 'at',
 created_at TEXT, last_active_at TEXT);
CREATE TABLE messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, member_id TEXT,
 member_name TEXT, content TEXT, mentions TEXT DEFAULT '', recipients TEXT DEFAULT '[]',
 created_at TEXT);
CREATE TABLE members (
 id TEXT, channel TEXT, name TEXT, kind TEXT, active INTEGER, joined_at TEXT,
 last_seen TEXT, PRIMARY KEY(id,channel));
""")
now = "2026-08-01T00:00:00+00:00"
db.execute("INSERT INTO agents (id,name,runtime_provider,cwd,created_at) "
           "VALUES ('real1','RealCodex','codex',?,?)", (str(ROOT), now))
db.execute("INSERT INTO members VALUES "
           "('real1','smoke','RealCodex','agent',1,?,?)", (now, now))
db.commit(); db.close()

manager = CodexRuntimeManager(
    db_path, nth_server_path=str(ROOT / "server" / "nth_server.py"))
try:
    models = manager.list_models()
    selected = next((model for model in models if model.get("default")), models[0])
    manager.spawn(
        "real1", model=selected["id"], cwd=str(ROOT),
        permission_profile="balanced",
        system_prompt="This is an integration smoke test. Do not call tools.")
    if not manager.feed(
            "real1", "smoke",
            "Reply with exactly: TRIO_CODEX_SMOKE_OK. Do not call any tools."):
        raise RuntimeError("turn did not start")
    deadline = time.time() + 120
    reply = ""
    while time.time() < deadline:
        with sqlite3.connect(str(db_path)) as check_db:
            row = check_db.execute(
                "SELECT content FROM messages WHERE member_id='real1' "
                "ORDER BY id DESC LIMIT 1").fetchone()
        reply = row[0] if row else ""
        if reply:
            break
        time.sleep(0.1)
    if "TRIO_CODEX_SMOKE_OK" not in reply:
        raise RuntimeError(f"unexpected or missing reply: {reply!r}")
    print(f"PASS: real Codex App Server turn via {selected['id']}")
finally:
    try:
        manager.delete("real1")
    except Exception:
        pass
    manager.shutdown()
