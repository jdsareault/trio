"""Tests for the agent control-plane endpoints (supervisor-backed):
POST /api/agents (create+spawn), GET /api/agents (roster),
POST /api/agents/<id>/{stop,delete}. Operator-only. Driven against the fake
stream-json agent (tests/fake_agent.py) — NO real billed Claude session.

Usage: python tests/test-web-agents.py
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server"
sys.path.insert(0, str(SERVER))
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"

import nth_server as srv    # noqa: E402
import nth_web as web       # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_agents_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def http(port, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def row(agent_id):
    db = sqlite3.connect(str(srv.DB_PATH)); db.row_factory = sqlite3.Row
    try:
        return db.execute("SELECT * FROM agents WHERE id=?", (agent_id,)).fetchone()
    finally:
        db.close()


json.loads(srv.nth_connect(summary="t", name="Host", channel="chan-x"))

web.NthWebHandler._default_channel = ""
web.NthWebHandler.db_path = srv.DB_PATH
web._DB_PATH_GLOBAL = srv.DB_PATH
web._SUPERVISOR = None  # fresh supervisor bound to the temp DB

server = None
try:
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    # ── create + spawn ──
    st, d = http(port, "/api/agents", "POST",
                 {"model": "sonnet", "channels": ["chan-x"], "prompt": "be helpful"})
    agent = d.get("agent", {})
    aid = agent.get("id", "")
    check("create: 200 + live", st == 200 and agent.get("live"))
    check("create: auto themed name assigned", bool(agent.get("name")))
    check("create: placed in chan-x", agent.get("channels") == ["chan-x"])
    r = row(aid)
    check("create: agents row running", r and r["state"] == "running")
    check("create: session_id captured", r and r["session_id"] == "sess-fake-sonnet-001")
    db = sqlite3.connect(str(srv.DB_PATH))
    ac = db.execute("SELECT COUNT(*) FROM agent_channels WHERE agent_id=?", (aid,)).fetchone()[0]
    mem = db.execute("SELECT kind FROM members WHERE id=? AND channel='chan-x'", (aid,)).fetchone()
    db.close()
    check("create: agent_channels placement row", ac == 1)
    check("create: members row is kind=agent", mem and mem[0] == "agent")

    # ── roster ──
    st, d = http(port, "/api/agents")
    ids = {a["id"]: a for a in d.get("agents", [])}
    check("list: 200 + includes agent, live, channels", st == 200
          and aid in ids and ids[aid]["live"] and ids[aid]["channels"] == ["chan-x"]
          and ids[aid]["abandoned"] is False)

    # ── bogus channel rejected ──
    st, _ = http(port, "/api/agents", "POST", {"model": "sonnet", "channels": ["ghost"]})
    check("create with unknown channel -> 400", st == 400)

    # ── stop ──
    st, _ = http(port, f"/api/agents/{aid}/stop", "POST")
    time.sleep(0.2)
    check("stop: 200 + row stopped + not live", st == 200
          and row(aid)["state"] == "stopped"
          and not web.get_supervisor().is_running(aid))

    # ── delete ──
    st, _ = http(port, f"/api/agents/{aid}/delete", "POST")
    check("delete: 200 + agents row gone", st == 200 and row(aid) is None)
    db = sqlite3.connect(str(srv.DB_PATH))
    left = db.execute("SELECT COUNT(*) FROM agent_channels WHERE agent_id=?", (aid,)).fetchone()[0]
    active = db.execute("SELECT active FROM members WHERE id=?", (aid,)).fetchone()
    db.close()
    check("delete: placements removed, member deactivated", left == 0 and active and active[0] == 0)

    # ── operator-only ──
    _orig = web.is_all_seeing
    web.is_all_seeing = lambda mid: False
    try:
        st, _ = http(port, "/api/agents")
        check("guest: GET /api/agents -> 403", st == 403)
        st, _ = http(port, "/api/agents", "POST", {"model": "sonnet"})
        check("guest: POST /api/agents -> 403", st == 403)
    finally:
        web.is_all_seeing = _orig
finally:
    if server is not None:
        server.shutdown()
    if web._SUPERVISOR is not None:
        web._SUPERVISOR.shutdown()
    web.stop_all_runtimes()

shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
