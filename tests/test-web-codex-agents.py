#!/usr/bin/env python3
"""Codex agent HTTP lifecycle through the provider-neutral control plane."""
import http.client
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"
os.environ["TRIO_CODEX_CMD"] = f"{sys.executable} {HERE / 'fake_codex_app_server.py'}"

import nth_server as srv
import nth_web as web


failures = 0


def check(label, condition):
    global failures
    print(("PASS" if condition else "FAIL") + ": " + label)
    if not condition:
        failures += 1


def request(port, path, method="GET", body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    headers = {}
    payload = None
    if body is not None:
        payload = json.dumps(body)
        headers["Content-Type"] = "application/json"
    conn.request(method, path, payload, headers)
    response = conn.getresponse()
    raw = response.read()
    conn.close()
    return response.status, json.loads(raw or b"{}")


tmp = Path(tempfile.mkdtemp(prefix="trio-web-codex-"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
web._DB_PATH_GLOBAL = srv.DB_PATH
web.NthWebHandler.db_path = srv.DB_PATH
web.NthWebHandler._default_channel = ""
web.NthWebHandler._agent_control_enabled = True
web._SUPERVISOR = None
web._RUNTIME_HEALTH = {}
json.loads(srv.nth_connect(summary="test", name="Host", channel="codex-room"))

server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
server.daemon_threads = True
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    status, payload = request(port, "/api/agent-models?provider=codex")
    check("Codex models are discovered from App Server",
          status == 200 and payload["models"][0]["id"] == "fake-codex")

    status, payload = request(port, "/api/agents", "POST", {
        "provider": "codex", "model": "fake-codex", "effort": "high",
        "channels": ["codex-room"], "cwd": str(tmp),
        "permission_profile": "balanced", "wake_mode": "about",
        "name": "CodeFriend", "prompt": "Keep changes small.",
    })
    agent = payload.get("agent", {})
    agent_id = agent.get("id", "")
    check("Codex create starts a managed thread", status == 200 and agent.get("live"))
    check("Codex create returns provider controls",
          agent.get("provider") == "codex"
          and agent.get("permission_profile") == "balanced"
          and agent.get("wake_mode") == "about")

    status, payload = request(port, "/api/agents")
    found = next((a for a in payload.get("agents", []) if a["id"] == agent_id), {})
    check("roster exposes thread continuity without a per-agent PID",
          status == 200 and found.get("provider") == "codex"
          and str(found.get("runtime_ref", "")).startswith("thr_fake_")
          and found.get("pid") is None and found.get("queued") == 0)

    status, _ = request(port, f"/api/agents/{agent_id}/wake-mode", "POST", {"mode": "all"})
    with sqlite3.connect(str(srv.DB_PATH)) as db:
        mode = db.execute("SELECT wake_mode FROM agents WHERE id=?", (agent_id,)).fetchone()[0]
    check("wake policy can be changed after creation", status == 200 and mode == "all")

    status, _ = request(port, f"/api/agents/{agent_id}/compact", "POST")
    check("Codex compact maps through the common action", status == 200)
    with sqlite3.connect(str(srv.DB_PATH)) as db:
        old_ref = db.execute("SELECT runtime_ref FROM agents WHERE id=?", (agent_id,)).fetchone()[0]
    status, _ = request(port, f"/api/agents/{agent_id}/clear", "POST")
    with sqlite3.connect(str(srv.DB_PATH)) as db:
        new_ref = db.execute("SELECT runtime_ref FROM agents WHERE id=?", (agent_id,)).fetchone()[0]
        archived = db.execute(
            "SELECT runtime_ref FROM agent_runtime_history WHERE agent_id=? AND disposition='cleared'",
            (agent_id,)).fetchone()
    check("Codex clear replaces and archives context",
          status == 200 and new_ref != old_ref and archived == (old_ref,))

    status, _ = request(port, f"/api/agents/{agent_id}/hibernate", "POST")
    check("Codex hibernate unloads its thread",
          status == 200 and not web.get_supervisor().is_running(agent_id))
    status, _ = request(port, f"/api/agents/{agent_id}/wake", "POST")
    check("Codex wake resumes the same durable thread",
          status == 200 and web.get_supervisor().is_running(agent_id))

    status, _ = request(port, "/api/agents", "POST", {
        "provider": "codex", "model": "missing", "cwd": str(tmp)})
    check("unknown Codex models fail before durable creation", status == 400)

    status, _ = request(port, f"/api/agents/{agent_id}/delete", "POST")
    with sqlite3.connect(str(srv.DB_PATH)) as db:
        remaining = db.execute("SELECT COUNT(*) FROM agents WHERE id=?", (agent_id,)).fetchone()[0]
    check("Codex delete removes provider thread and Trio identity",
          status == 200 and remaining == 0)
finally:
    server.shutdown()
    if web._SUPERVISOR is not None:
        web._SUPERVISOR.shutdown()
    web.stop_all_runtimes()
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
raise SystemExit(1 if failures else 0)
