"""Tests for the observability bundle — tool-use (#1), sub-agents (#2), blocked (#6).

The activity hook (nth_activity_hook.py) now, on PreToolUse, also records a SHORT
privacy-safe tool summary (sessions.last_tool_* + a capped tool_events ring) and
flips sessions.blocked_since for interactive host prompts; PostToolUse /
UserPromptSubmit / any non-blocking tool clear it. member_status() renders a
`blocked` state; _fetch_roster surfaces the chip fields + blocked flag.

Covers:
  * summary capture is privacy-safe: Bash keeps the program name ONLY (args/
    secrets stripped), file tools keep a basename, Task keeps type+description
  * tool_events is capped/pruned per session and never records orphan sessions
  * blocked_since is set by blocking tools and cleared by PostToolUse, a new
    prompt, and any non-blocking tool (self-heal)
  * member_status blocked ordering: blocked beats stale, dead beats blocked
  * _fetch_roster ships the chip fields and computes the blocked status
  * the last_seen stamp is never regressed by the added writes

Usage: python tests/test-observability-bundle.py
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv    # noqa: E402
import nth_web as web       # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def iso(delta=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta)).isoformat()


_tmp = tempfile.mkdtemp(prefix="nth_obs_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"
DB = str(srv.DB_PATH)

os.environ["CLAUDE_CODE_SESSION_ID"] = "obs-sid-1"
r = json.loads(srv.nth_connect(summary="t", name="Worker", channel="obs1"))
CH, agent = r["channel"], r["member_id"]


def raw():
    c = sqlite3.connect(DB, isolation_level=None)
    c.row_factory = sqlite3.Row
    return c


def fire(payload):
    env = {**os.environ, "NTH_DB_PATH": DB}
    p = subprocess.run([sys.executable, str(SERVER / "nth_activity_hook.py")],
                       input=json.dumps(payload), text=True, capture_output=True, env=env)
    return p.returncode == 0


def sess(field, session_id="obs-sid-1"):
    c = raw()
    try:
        row = c.execute(f"SELECT {field} AS v FROM sessions WHERE fingerprint=?",
                        (session_id,)).fetchone()
    finally:
        c.close()
    return row["v"] if row else None


def events(session_id="obs-sid-1"):
    c = raw()
    try:
        return [dict(x) for x in c.execute(
            "SELECT tool_name, target FROM tool_events WHERE session_id=? ORDER BY id",
            (session_id,)).fetchall()]
    finally:
        c.close()


# ── #1 privacy-safe summary capture ──────────────────────────────────────────
fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
      "tool_name": "Bash",
      "tool_input": {"command": "mysql -pSUPERSECRET -e 'select 1'"}})
check("Bash keeps program name only", sess("last_tool_name") == "Bash"
      and sess("last_tool_target") == "mysql")
check("Bash target does NOT leak the password",
      "SUPERSECRET" not in (sess("last_tool_target") or ""))

fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
      "tool_name": "Read", "tool_input": {"file_path": "/home/x/.env"}})
check("Read keeps a basename", sess("last_tool_target") == ".env")

fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
      "tool_name": "Task",
      "tool_input": {"subagent_type": "legolas", "description": "perf pass",
                     "prompt": "SECRET PROMPT BODY"}})
check("Task keeps type + description", sess("last_tool_name") == "Task"
      and sess("last_tool_target") == "legolas: perf pass")
check("Task does NOT store the prompt body",
      "SECRET" not in (sess("last_tool_target") or ""))

# ── #2 tool_events ring: contents + cap + no orphans ─────────────────────────
ev = events()
check("tool_events recorded the calls in order",
      [e["tool_name"] for e in ev] == ["Bash", "Read", "Task"])
check("Task spawn is in the ring (sub-agent surface)",
      any(e["tool_name"] == "Task" for e in ev))

for i in range(30):
    fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
          "tool_name": "Bash", "tool_input": {"command": f"echo {i}"}})
c = raw()
try:
    n = c.execute("SELECT COUNT(*) c FROM tool_events WHERE session_id='obs-sid-1'").fetchone()["c"]
finally:
    c.close()
check("tool_events is capped per session (<= 20)", n <= 20)

fire({"session_id": "obs-nobody", "hook_event_name": "PreToolUse",
      "tool_name": "Bash", "tool_input": {"command": "ls"}})
check("orphan/untracked session records no events", events("obs-nobody") == [])

# ── #1 last_seen is never regressed by the added writes ──────────────────────
c = raw()
try:
    c.execute("UPDATE sessions SET last_seen=? WHERE fingerprint=?", (iso(-60), "obs-sid-1"))
finally:
    c.close()
before = sess("last_seen")
fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
      "tool_name": "Grep", "tool_input": {"pattern": "foo"}})
check("PreToolUse still advances last_seen", sess("last_seen") > before)

# ── #6 blocked set/clear paths ───────────────────────────────────────────────
fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
      "tool_name": "AskUserQuestion", "tool_input": {"questions": []}})
check("AskUserQuestion sets blocked_since", sess("blocked_since") is not None)

fire({"session_id": "obs-sid-1", "hook_event_name": "PostToolUse",
      "tool_name": "AskUserQuestion"})
check("PostToolUse clears blocked_since", sess("blocked_since") is None)

fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
      "tool_name": "ExitPlanMode", "tool_input": {"plan": "..."}})
check("ExitPlanMode sets blocked_since", sess("blocked_since") is not None)
fire({"session_id": "obs-sid-1", "hook_event_name": "UserPromptSubmit"})
check("UserPromptSubmit clears blocked_since", sess("blocked_since") is None)

fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
      "tool_name": "AskUserQuestion", "tool_input": {}})
fire({"session_id": "obs-sid-1", "hook_event_name": "PreToolUse",
      "tool_name": "Bash", "tool_input": {"command": "ls"}})
check("a non-blocking tool self-heals a stale block", sess("blocked_since") is None)

# ── #6 member_status ordering ────────────────────────────────────────────────
check("blocked beats stale",
      web.member_status(iso(-400), "", session_activity_iso=iso(-400),
                        last_turn_end_iso=iso(-500), blocked_since_iso=iso(-400)) == "blocked")
check("dead beats blocked",
      web.member_status(iso(-1000), "", blocked_since_iso=iso(-1000)) == "dead")
check("no block, aged -> stale (not blocked)",
      web.member_status(iso(-400), "", session_activity_iso=iso(-400),
                        last_turn_end_iso=iso(-500)) == "stale")

# ── roster surfaces the chip fields + blocked status ─────────────────────────
hub = web.EventHub(srv.DB_PATH, CH)


def member_row():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    try:
        roster = hub._fetch_roster(c)
    finally:
        c.close()
    for m in roster:
        if m["id"] == agent:
            return m
    return None


c = raw()
try:
    c.execute("UPDATE sessions SET last_tool_name='Bash', last_tool_target='git', "
              "last_seen=?, last_turn_end=?, blocked_since=NULL WHERE fingerprint=?",
              (iso(0), iso(-30), "obs-sid-1"))
    c.execute("UPDATE members SET last_seen=? WHERE channel=? AND id=?", (iso(0), CH, agent))
finally:
    c.close()
m = member_row()
check("roster ships last_tool_name", m and m.get("last_tool_name") == "Bash")
check("roster ships last_tool_target", m and m.get("last_tool_target") == "git")
check("acting member reads working (chip-visible)", m and m["status"] == "working")

c = raw()
try:
    c.execute("UPDATE sessions SET blocked_since=? WHERE fingerprint=?", (iso(0), "obs-sid-1"))
finally:
    c.close()
m = member_row()
check("roster computes blocked status", m and m["status"] == "blocked")

os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
