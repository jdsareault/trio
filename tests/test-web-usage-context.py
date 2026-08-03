#!/usr/bin/env python3
"""Tests for the two newest Atrium indicators:

  * Context-fullness: nth_supervisor now reads the `usage` object off each
    Claude Code stream-json `assistant` event (a single request's own
    prompt size — NOT the turn-level `result` event, whose usage is
    accumulated across every internal API call the turn made) and persists
    a context_pct / context_tokens reading on the agents row
    (server/nth_supervisor.py _handle_event -> _set_context), sized against
    a per-model context window (context_window_for: 1M for Sonnet/Opus,
    200k for Haiku). /api/agents and the channel roster (_fetch_roster)
    both surface it.
  * /api/usage: reads Claude Code's own ~/.claude/statusline-state.json
    (five_hour/seven_day used_percentage) for the home-screen quota
    display. Codex has no equivalent source and always reports
    unavailable rather than guessing at an undocumented format.

Usage: python tests/test-web-usage-context.py
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
import nth_supervisor as sup  # noqa: E402
import nth_web as web       # noqa: E402
from nth_constants import AGENT_INBOX_CHANNEL  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


# ── context_window_for: per-model window lookup ──────────────────────────
# LOTC/jdsareault (post-review question): the original hardcoded 200k was
# stale internal-knowledge, not a verified figure — Sonnet/Opus default to
# a 1M window as of the 4.6/5 model generation (no beta header required),
# only Haiku stays at 200k. Verify the lookup and its safe-fallback
# direction (unrecognized model -> the SMALLER window, so a genuinely-full
# context is never silently under-reported as merely high).
check("context_window_for: haiku tier alias -> 200k", sup.context_window_for("haiku") == 200_000)
check("context_window_for: versioned haiku model id -> 200k",
      sup.context_window_for("claude-haiku-4-5-20251001") == 200_000)
check("context_window_for: sonnet tier alias -> 1M", sup.context_window_for("sonnet") == 1_000_000)
check("context_window_for: opus tier alias -> 1M", sup.context_window_for("opus") == 1_000_000)
check("context_window_for: case-insensitive", sup.context_window_for("HAIKU") == 200_000)
check("context_window_for: a genuinely empty/unset model string conservatively "
      "assumes the smaller window (we truly know nothing)",
      sup.context_window_for("") == 200_000)
check("context_window_for: an unrecognized-but-present model id assumes the "
      "current-generation default (1M), not the legacy 200k",
      sup.context_window_for("some-future-model") == 1_000_000)


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


_tmp = tempfile.mkdtemp(prefix="nth_usage_ctx_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"

# ── Part A: nth_supervisor captures context usage off a result event ────────
agent_id = "ag_ctx_test"
manager = None
try:
    db = srv.get_db(srv.DB_PATH)
    now = srv.now_iso()
    db.execute("INSERT INTO channels (code,status,created_at,updated_at) VALUES (?,'active',?,?)",
               (AGENT_INBOX_CHANNEL, now, now))
    db.execute("INSERT INTO agents (id,name,model,state,managed,created_at) "
               "VALUES (?, 'Ctx Agent', 'sonnet', 'stopped', 1, ?)", (agent_id, now))
    db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,joined_at,active,kind) "
               "VALUES (?,?,?,'','',?,?,1,'agent')",
               (agent_id, AGENT_INBOX_CHANNEL, "Ctx Agent", now, now))
    db.commit()
    db.close()

    # Haiku is the one current tier still on a 200k window (Sonnet/Opus
    # default to 1M as of the 4.6/5 generation) — spawn as haiku so this
    # first check's math is a round, easy-to-read number.
    os.environ["FAKE_AGENT_USAGE_TOKENS"] = "40000,0,20000"  # 60,000 / 200,000 = 30%
    manager = sup.AgentSupervisor(db_path=srv.DB_PATH)
    manager.spawn(agent_id, model="haiku")
    check("feed reaches the fake headless agent",
          manager.feed(agent_id, AGENT_INBOX_CHANNEL, "hello"))

    deadline = time.monotonic() + 3
    r = None
    while time.monotonic() < deadline:
        db = sqlite3.connect(str(srv.DB_PATH)); db.row_factory = sqlite3.Row
        r = db.execute("SELECT context_pct, context_tokens FROM agents WHERE id=?",
                        (agent_id,)).fetchone()
        db.close()
        if r and r["context_pct"] is not None:
            break
        time.sleep(0.02)
    check("context_tokens sums input+cache_creation+cache_read",
          r is not None and r["context_tokens"] == 60000)
    check("context_pct is tokens / haiku's 200k context window",
          r is not None and abs((r["context_pct"] or 0) - 30.0) < 0.01)
finally:
    if manager is not None:
        manager.stop(agent_id)
    os.environ.pop("FAKE_AGENT_USAGE_TOKENS", None)

# ── Part A2: a multi-tool-call turn must read the LAST assistant event's own
# usage, not accumulate across the turn's internal API calls. LOTC/Sauron:
# `result.usage` sums every internal request in the turn (each tool
# round-trip re-reports the same cached history), so deriving context size
# from it overcounts by ~N× for an N-tool-call turn — a turn that only
# actually grew context to 40k tokens would read as ~200k (100%) if it made
# 5 internal API calls. Exercise _handle_event directly (same pattern as
# test-supervisor-output-bridge.py's manager._bridge_result) since a fake
# multi-step turn isn't something fake_agent.py's protocol shape covers.
db = srv.get_db(srv.DB_PATH)
db.execute("UPDATE agents SET context_pct=NULL, context_tokens=NULL WHERE id=?", (agent_id,))
db.commit()
db.close()
manager2 = sup.AgentSupervisor(db_path=srv.DB_PATH)
manager2._handle_event(agent_id, {
    "type": "assistant",
    "message": {"usage": {"input_tokens": 5000, "cache_creation_input_tokens": 0,
                           "cache_read_input_tokens": 0}}})
manager2._handle_event(agent_id, {
    "type": "assistant",
    "message": {"usage": {"input_tokens": 5000, "cache_creation_input_tokens": 0,
                           "cache_read_input_tokens": 35000}}})
manager2._handle_event(agent_id, {
    "type": "result", "is_error": False, "result": "done",
    # A real result event's usage is the SUM across every internal request
    # this turn made (5000+35000 twice over here) — if this were mistakenly
    # read as context size it would report ~90k/45%, not the true ~40k/20%.
    "usage": {"input_tokens": 10000, "cache_creation_input_tokens": 0,
              "cache_read_input_tokens": 70000}})
db = sqlite3.connect(str(srv.DB_PATH)); db.row_factory = sqlite3.Row
r2 = db.execute("SELECT context_pct, context_tokens FROM agents WHERE id=?", (agent_id,)).fetchone()
db.close()
check("context reflects the LAST assistant event's own usage (40k/20%), "
      "not the result event's turn-accumulated usage (80k/40%)",
      r2 is not None and r2["context_tokens"] == 40000
      and abs((r2["context_pct"] or 0) - 20.0) < 0.01)

# Negative/malformed usage fields must clamp to 0, never a negative percentage.
db = srv.get_db(srv.DB_PATH)
db.execute("UPDATE agents SET context_pct=NULL, context_tokens=NULL WHERE id=?", (agent_id,))
db.commit()
db.close()
manager2._handle_event(agent_id, {
    "type": "assistant",
    "message": {"usage": {"input_tokens": -50000, "cache_creation_input_tokens": 0,
                           "cache_read_input_tokens": 0}}})
db = sqlite3.connect(str(srv.DB_PATH)); db.row_factory = sqlite3.Row
r3 = db.execute("SELECT context_pct, context_tokens FROM agents WHERE id=?", (agent_id,)).fetchone()
db.close()
check("a negative usage field clamps to 0, never stores a negative percentage",
      r3 is not None and r3["context_tokens"] == 0 and r3["context_pct"] == 0.0)

# Restore a known reading for Part B, which tests the serialization plumbing
# (endpoint/roster field wiring), not the capture math exercised above.
db = srv.get_db(srv.DB_PATH)
db.execute("UPDATE agents SET context_pct=30.0, context_tokens=60000 WHERE id=?", (agent_id,))
db.commit()
db.close()

# ── Part B: /api/agents + channel roster surface the fields ─────────────────
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

    st, d = http(port, "/api/agents")
    ids = {a["id"]: a for a in d.get("agents", [])}
    check("/api/agents: 200", st == 200)
    check("/api/agents: context_pct surfaced", ids.get(agent_id, {}).get("context_pct") == 30.0)
    check("/api/agents: context_tokens surfaced", ids.get(agent_id, {}).get("context_tokens") == 60000)

    # A channel member with no matching `agents` row (e.g. a human, or a
    # freshly-connected trio member never spawned via the supervisor) must
    # not crash the join — context_pct simply comes back null.
    r2 = json.loads(srv.nth_connect(summary="t", name="Plain", channel="ctx-chan"))
    hub = web.EventHub(srv.DB_PATH, "ctx-chan")
    c = sqlite3.connect(str(srv.DB_PATH)); c.row_factory = sqlite3.Row
    try:
        roster = hub._fetch_roster(c)
    finally:
        c.close()
    plain = next((m for m in roster if m["id"] == r2["member_id"]), None)
    check("_fetch_roster: plain trio member has no context_pct crash, reads None",
          plain is not None and plain.get("context_pct") is None)

    # Now exercise the actual join path: same id present in the agents table.
    db = sqlite3.connect(str(srv.DB_PATH))
    db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,joined_at,active,kind) "
               "VALUES (?,?,?,'','',?,?,1,'agent')",
               (agent_id, "ctx-chan", "Ctx Agent", srv.now_iso(), srv.now_iso()))
    db.commit(); db.close()
    hub2 = web.EventHub(srv.DB_PATH, "ctx-chan")
    c = sqlite3.connect(str(srv.DB_PATH)); c.row_factory = sqlite3.Row
    try:
        roster2 = hub2._fetch_roster(c)
    finally:
        c.close()
    ctx_member = next((m for m in roster2 if m["id"] == agent_id), None)
    check("_fetch_roster: agents-table member surfaces context_pct",
          ctx_member is not None and ctx_member.get("context_pct") == 30.0)
    check("_fetch_roster: agents-table member surfaces context_tokens",
          ctx_member is not None and ctx_member.get("context_tokens") == 60000)

    # ── Part C: /api/usage ──
    fixture = Path(_tmp) / "statusline-state.json"
    fixture.write_text(json.dumps({
        "_cached_rate_limits": {
            "five_hour": {"used_percentage": 70, "resets_at": 1785706800},
            "seven_day": {"used_percentage": 40, "resets_at": 1786039200},
        }
    }))
    web.STATUSLINE_STATE_PATH = fixture
    st, d = http(port, "/api/usage")
    check("/api/usage: 200", st == 200)
    check("/api/usage: claude available with five_hour/seven_day",
          d.get("claude", {}).get("available") is True
          and d["claude"]["five_hour"]["used_percentage"] == 70
          and d["claude"]["seven_day"]["used_percentage"] == 40)
    check("/api/usage: codex reports unavailable (no documented source)",
          d.get("codex", {}) == {"available": False})

    web.STATUSLINE_STATE_PATH = Path(_tmp) / "does-not-exist.json"
    st, d = http(port, "/api/usage")
    check("/api/usage: missing statusline file -> claude unavailable, still 200",
          st == 200 and d.get("claude", {}).get("available") is False)

    # Guests never get account-level usage data.
    _orig = web.is_all_seeing
    web.is_all_seeing = lambda mid: False
    web.NthWebHandler._default_channel = "ctx-chan"
    try:
        st, _ = http(port, "/api/usage")
        check("/api/usage: guest -> 403", st == 403)
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
