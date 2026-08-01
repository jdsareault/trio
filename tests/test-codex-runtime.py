#!/usr/bin/env python3
"""Managed Codex lifecycle tests using the fake App Server."""
import json
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

from nth_codex_runtime import CodexRuntimeManager
from nth_constants import AGENT_INBOX_CHANNEL

failures = 0


def check(label, condition):
    global failures
    print(("PASS" if condition else "FAIL") + ": " + label)
    if not condition:
        failures += 1


tmp = Path(tempfile.mkdtemp(prefix="trio-codex-runtime-"))
db_path = tmp / "nth.db"
db = sqlite3.connect(str(db_path))
db.executescript("""
CREATE TABLE agents (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
 base_prompt TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'stopped',
 managed INTEGER NOT NULL DEFAULT 1, session_id TEXT, pid INTEGER, owner TEXT,
 effort TEXT NOT NULL DEFAULT '', runtime_provider TEXT NOT NULL DEFAULT 'claude',
 runtime_ref TEXT, cwd TEXT NOT NULL DEFAULT '',
 permission_profile TEXT NOT NULL DEFAULT 'balanced',
 created_at TEXT NOT NULL, last_active_at TEXT);
CREATE TABLE channels (code TEXT PRIMARY KEY);
CREATE TABLE members (
 id TEXT, channel TEXT, name TEXT, kind TEXT DEFAULT 'agent', active INTEGER DEFAULT 1,
 joined_at TEXT, last_seen TEXT, PRIMARY KEY(id,channel));
CREATE TABLE messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, member_id TEXT,
 member_name TEXT, content TEXT, mentions TEXT DEFAULT '',
 recipients TEXT DEFAULT '[]', created_at TEXT);
""")
now = "2026-08-01T00:00:00+00:00"
db.execute("INSERT INTO agents (id,name,model,state,effort,runtime_provider,cwd,created_at) "
           "VALUES ('ag1','Codexer','fake-codex','stopped','high','codex',?,?)",
           (str(tmp), now))
for channel in ("alpha", AGENT_INBOX_CHANNEL):
    db.execute("INSERT INTO channels(code) VALUES (?)", (channel,))
    db.execute("INSERT INTO members(id,channel,name,kind,active,joined_at,last_seen) "
               "VALUES ('ag1',?,'Codexer','agent',1,?,?)", (channel, now, now))
db.commit(); db.close()

command = [sys.executable, str(HERE / "fake_codex_app_server.py"), "--hold"]
manager = CodexRuntimeManager(db_path, command=command)
try:
    manager.ensure_started()
    models = manager.list_models()
    check("model discovery includes effort capabilities",
          models and models[0]["id"] == "fake-codex"
          and models[0]["efforts"] == ["low", "high"])

    handle = manager.spawn(
        "ag1", model="fake-codex", effort="high", cwd=str(tmp),
        system_prompt="You are Codexer")
    check("spawn creates a persistent Codex thread", handle.thread_id.startswith("thr_fake_"))
    check("shared runtime reports agent live without a per-agent pid",
          handle.alive() and handle.pid is None)
    with sqlite3.connect(str(db_path)) as check_db:
        row = check_db.execute(
            "SELECT state,runtime_ref,session_id,pid FROM agents WHERE id='ag1'").fetchone()
    check("spawn persists provider session reference", row[0] == "running"
          and row[1] == handle.thread_id and row[2] == handle.thread_id and row[3] is None)

    check("first directed message starts a turn", manager.feed("ag1", "alpha", "hello"))
    time.sleep(0.1)
    check("second message queues behind the active turn",
          manager.feed("ag1", "alpha", "second") and manager.queued_count("ag1") == 1)
    manager._client.request("fake/complete")
    deadline = time.time() + 2
    while (manager.queued_count("ag1") or not manager.is_busy("ag1")) \
            and time.time() < deadline:
        time.sleep(0.02)
    check("turn completion drains the next queued message",
          manager.queued_count("ag1") == 0 and manager.is_busy("ag1"))
    manager._client.request("fake/complete")
    time.sleep(0.1)
    with sqlite3.connect(str(db_path)) as check_db:
        replies = [r[0] for r in check_db.execute(
            "SELECT content FROM messages WHERE member_id='ag1' ORDER BY id")]
    check("final agent messages bridge into the source channel",
          len(replies) == 2 and "hello" in replies[0] and "second" in replies[1])

    check("compact maps to the native thread operation", manager.compact("ag1"))
    check("hibernate unloads but retains the thread", manager.hibernate("ag1")
          and not manager.is_running("ag1"))
    with sqlite3.connect(str(db_path)) as check_db:
        sleeping = check_db.execute(
            "SELECT state,runtime_ref FROM agents WHERE id='ag1'").fetchone()
    check("hibernate persists sleeping continuity", sleeping[0] == "sleeping"
          and sleeping[1] == handle.thread_id)

    woke = manager.wake("ag1")
    check("wake resumes the same Codex thread",
          woke is not None and woke.thread_id == handle.thread_id and woke.alive())
    fresh = manager.clear("ag1", system_prompt="fresh")
    check("clear archives old context and starts a fresh thread",
          fresh is not None and fresh.thread_id != handle.thread_id)
    check("stop unloads the thread without deleting continuity",
          manager.stop("ag1") and not manager.is_running("ag1"))
    check("delete removes the provider thread", manager.delete("ag1"))
finally:
    manager.shutdown()

print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
raise SystemExit(1 if failures else 0)
