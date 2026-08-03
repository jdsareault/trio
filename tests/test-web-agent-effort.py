#!/usr/bin/env python3
"""Tests for the reasoning-effort attribute: settable at agent creation and
editable afterward, validated against the SPECIFIC model's supported
effort levels (not just the generic cross-provider allowlist).

Covers:
  * POST /api/agents: Claude creation now gets the same per-model effort
    check Codex already had (a Haiku agent can't be created with an effort
    Haiku doesn't support).
  * POST /api/agents/<id>/effort: new action, mirrors the existing
    wake-mode action pattern — persists to the agents row, validated
    against the agent's own model's efforts (via the live-discovered
    Codex model list, or the static CLAUDE_MODELS table).
  * Guest/unknown-agent/malformed-value error paths.

Usage: python tests/test-web-agent-effort.py
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
os.environ["TRIO_CODEX_CMD"] = f"{sys.executable} {HERE / 'fake_codex_app_server.py'}"

import nth_server as srv    # noqa: E402
import nth_web as web       # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


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


_tmp = tempfile.mkdtemp(prefix="nth_effort_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"

json.loads(srv.nth_connect(summary="t", name="Host", channel="chan-x"))

web.NthWebHandler._default_channel = ""
web.NthWebHandler.db_path = srv.DB_PATH
web._DB_PATH_GLOBAL = srv.DB_PATH
web._SUPERVISOR = None

server = None
try:
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    # ── Claude creation now validates effort against the SPECIFIC model,
    # not just the generic cross-provider allowlist. Haiku's CLAUDE_MODELS
    # entry caps at "high" — "max" is valid Sonnet/Opus effort but not Haiku.
    st, d = http(port, "/api/agents", "POST",
                 {"model": "haiku", "channels": ["chan-x"], "effort": "max"})
    check("create: haiku + unsupported effort 'max' -> 400", st == 400)

    st, d = http(port, "/api/agents", "POST",
                 {"model": "haiku", "channels": ["chan-x"], "effort": "high"})
    aid = d.get("agent", {}).get("id", "")
    check("create: haiku + supported effort 'high' -> 200", st == 200 and aid)
    check("create: effort persisted on the agents row", row(aid) and row(aid)["effort"] == "high")

    # ── POST /api/agents/<id>/effort: post-creation edit, same action-route
    # pattern as wake-mode.
    st, d = http(port, f"/api/agents/{aid}/effort", "POST", {"effort": "low"})
    check("effort action: valid change -> 200", st == 200 and d.get("ok"))
    check("effort action: DB updated", row(aid)["effort"] == "low")

    st, d = http(port, f"/api/agents/{aid}/effort", "POST", {"effort": "max"})
    check("effort action: haiku + unsupported 'max' -> 400", st == 400)
    check("effort action: rejected change did not touch the DB", row(aid)["effort"] == "low")

    st, d = http(port, f"/api/agents/{aid}/effort", "POST", {"effort": ""})
    check("effort action: empty clears back to provider default -> 200",
          st == 200 and row(aid)["effort"] == "")

    st, d = http(port, f"/api/agents/{aid}/effort", "POST", {"effort": "not-a-real-level"})
    check("effort action: value outside the global allowlist -> 400", st == 400)

    st, d = http(port, "/api/agents/ag_does_not_exist/effort", "POST", {"effort": "high"})
    check("effort action: unknown agent -> 404", st == 404)

    # ── Codex: same action, validated against the LIVE-discovered model
    # list (fake_codex_app_server.py's "fake-codex" model supports only
    # low/high — confirms this isn't hardcoded to Claude's static table).
    st, d = http(port, "/api/agents", "POST",
                 {"provider": "codex", "model": "fake-codex", "channels": ["chan-x"],
                  "effort": "high"})
    cid = d.get("agent", {}).get("id", "")
    check("create: codex agent with a codex-supported effort -> 200", st == 200 and cid)

    st, d = http(port, f"/api/agents/{cid}/effort", "POST", {"effort": "medium"})
    check("effort action: codex model doesn't support 'medium' -> 400", st == 400)

    st, d = http(port, f"/api/agents/{cid}/effort", "POST", {"effort": "low"})
    check("effort action: codex-supported effort -> 200", st == 200 and row(cid)["effort"] == "low")

    # ── Guest gating: same operator-only gate as every other agent action.
    _orig = web.is_all_seeing
    web.is_all_seeing = lambda mid: False
    web.NthWebHandler._default_channel = "chan-x"
    try:
        st, _ = http(port, f"/api/agents/{aid}/effort", "POST", {"effort": "low"})
        check("effort action: guest -> 403", st == 403)
    finally:
        web.is_all_seeing = _orig
        web.NthWebHandler._default_channel = ""
finally:
    if server is not None:
        server.shutdown()
    web.stop_all_runtimes()

shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
