"""Tests for the agent working/idle indicator (feat/working-indicator).

Covers member_status()'s working/idle/active split, the nth_turn_hook stamping
sessions.last_turn_end, and the roster integration end to end:
  working — alive AND acted since its last turn end (mid-turn)
  idle    — alive AND its last turn ended (waiting) / sleeping status_text
  active  — alive but no turn data (hook not installed) — legacy, no regression

Usage: python tests/test-working-indicator.py
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


# ── member_status() unit cases ───────────────────────────────────────────────
check("dead: no last_seen", web.member_status(None, "") == "dead")
check("dead: heartbeat > DEAD_SECONDS", web.member_status(iso(-1000), "") == "dead")
check("stale: heartbeat aging", web.member_status(iso(-400), "") == "stale")
check("idle: sleeping status_text wins", web.member_status(iso(-5), "idle — standing by") == "idle")
check("active: alive, no turn data (hook not installed)", web.member_status(iso(-5), "") == "active")
check("working: acted since last turn end",
      web.member_status(iso(-5), "", session_activity_iso=iso(-3), last_turn_end_iso=iso(-30)) == "working")
check("idle: last turn ended after last activity",
      web.member_status(iso(-5), "", session_activity_iso=iso(-30), last_turn_end_iso=iso(-3)) == "idle")
check("idle: turn ended but no activity recorded",
      web.member_status(iso(-5), "", session_activity_iso=None, last_turn_end_iso=iso(-3)) == "idle")
check("dead precedence over turn data",
      web.member_status(iso(-1000), "", session_activity_iso=iso(-1), last_turn_end_iso=iso(-30)) == "dead")
check("blocked: activity has not advanced past blocked_since",
      web.member_status(iso(-5), "", session_activity_iso=iso(-30),
                        last_turn_end_iso=iso(-30), blocked_since_iso=iso(-30)) == "blocked")
check("blocked self-heals: activity advanced past blocked_since -> working",
      web.member_status(iso(-5), "", session_activity_iso=iso(-2),
                        last_turn_end_iso=iso(-30), blocked_since_iso=iso(-30)) == "working")

# ── _agent_is_live(): the /api/agents state gate ─────────────────────────────
check("_agent_is_live: in-process handle wins regardless of heartbeat/state",
      web._agent_is_live(True, False, "sleeping") is True)
check("_agent_is_live: fresh heartbeat + running state -> live",
      web._agent_is_live(False, True, "running") is True)
check("_agent_is_live: fresh heartbeat but sleeping -> NOT live (no hibernate flash)",
      web._agent_is_live(False, True, "sleeping") is False)
check("_agent_is_live: fresh heartbeat but stopped/errored -> NOT live",
      web._agent_is_live(False, True, "stopped") is False
      and web._agent_is_live(False, True, "errored") is False)
check("_agent_is_live: stale heartbeat + running -> NOT live",
      web._agent_is_live(False, False, "running") is False)


# ── the turn hook stamps sessions.last_turn_end ──────────────────────────────
_tmp = tempfile.mkdtemp(prefix="nth_wi_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"
DB = str(srv.DB_PATH)

os.environ["CLAUDE_CODE_SESSION_ID"] = "wi-sid-1"
r = json.loads(srv.nth_connect(summary="t", name="Worker", channel="wi1"))
CH, agent = r["channel"], r["member_id"]


def raw():
    c = sqlite3.connect(DB, isolation_level=None)
    c.row_factory = sqlite3.Row
    return c


def fire_turn_hook(session_id, event="Stop"):
    payload = json.dumps({"session_id": session_id, "hook_event_name": event})
    subprocess.run([sys.executable, str(SERVER / "nth_turn_hook.py")],
                   input=payload, text=True,
                   env={**os.environ, "NTH_DB_PATH": DB}, check=True)


def turn_end(session_id):
    c = raw()
    try:
        row = c.execute("SELECT last_turn_end FROM sessions WHERE fingerprint=?",
                        (session_id,)).fetchone()
    finally:
        c.close()
    return row["last_turn_end"] if row else None


check("hook: last_turn_end starts empty", turn_end("wi-sid-1") is None)
fire_turn_hook("wi-sid-1", "Stop")
check("hook: Stop stamps last_turn_end", turn_end("wi-sid-1") is not None)
end_after_stop = turn_end("wi-sid-1")
fire_turn_hook("wi-sid-1", "StopFailure")
check("hook: StopFailure also stamps (a stalled turn still 'ends')",
      turn_end("wi-sid-1") is not None and turn_end("wi-sid-1") >= end_after_stop)
fire_turn_hook("wi-sid-nobody", "Stop")  # unknown session — must not crash
check("hook: unknown session_id is a harmless no-op",
      turn_end("wi-sid-nobody") is None)


# ── roster integration: status flips idle -> working on new activity ─────────
hub = web.EventHub(srv.DB_PATH, CH)


def status_of(member_id):
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    try:
        roster = hub._fetch_roster(c)
    finally:
        c.close()
    for m in roster:
        if m["id"] == member_id:
            return m["status"]
    return None


# right now: session acted at connect (last_seen ~now), then a turn end was
# stamped just after -> last_turn_end >= activity -> idle
c = raw()
try:
    c.execute("UPDATE members SET last_seen=? WHERE channel=? AND id=?", (iso(0), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-20), iso(-5), "wi-sid-1"))
finally:
    c.close()
check("roster: turn ended after last activity -> idle", status_of(agent) == "idle")

# the agent acts again (a fresh poll) AFTER the turn end -> working
c = raw()
try:
    c.execute("UPDATE sessions SET last_seen=? WHERE fingerprint=?", (iso(0), "wi-sid-1"))
finally:
    c.close()
check("roster: activity after turn end -> working", status_of(agent) == "working")

# a member with no turn data recorded shows the legacy 'active' (no regression)
os.environ["CLAUDE_CODE_SESSION_ID"] = "wi-sid-legacy"
r2 = json.loads(srv.nth_connect(summary="t", name="Legacyish", channel=CH))
legacy = r2["member_id"]
c = raw()
try:
    c.execute("UPDATE members SET last_seen=? WHERE channel=? AND id=?", (iso(0), CH, legacy))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=NULL WHERE fingerprint=?",
              (iso(0), "wi-sid-legacy"))
finally:
    c.close()
check("roster: no turn data -> legacy 'active' (no regression)", status_of(legacy) == "active")


# ── _agent_liveness(): the /api/agents live + working fallback ────────────────
# Bug: /api/agents read `live` only from the supervisor's in-memory _procs and
# `busy` only from compaction, so an agent this process never spawned (a
# reclaim-connected identity, or one spawned before a dashboard restart) showed
# "Not currently connected" and never "Working" during real work. _agent_liveness
# derives both from the same heartbeat + turn signals the roster already trusts.
def liveness(aid):
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    try:
        return web._agent_liveness(c).get(aid)
    finally:
        c.close()


c = raw()
try:
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(0), iso(0), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-2), iso(-30), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: fresh heartbeat + acted since turn end -> (live, working)",
      liveness(agent) == (True, True))

# fresh but idle: its turn ended after its last activity -> live, not working.
c = raw()
try:
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-30), iso(-5), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: fresh but turn ended after activity -> (live, not working)",
      liveness(agent) == (True, False))

# THE CORE FIX: only the Monitor heartbeat is fresh (session activity is old) —
# the agent is still live because it is heartbeating, even though this process
# holds no handle for it. Without the fallback this agent read as disconnected.
c = raw()
try:
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(-200), iso(-5), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-200), iso(-220), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: Monitor heartbeat alone keeps an unspawned agent live",
      liveness(agent) == (True, True))

# Each freshness source in isolation must keep the agent live. members.last_seen
# ALONE (messenger_heartbeat + session activity stale):
c = raw()
try:
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(-2), iso(-200), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-200), iso(-100), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: members.last_seen alone keeps agent live",
      (liveness(agent) or (False,))[0] is True)

# sessions.last_seen ALONE (Monitor columns stale) — the "Monitor down, agent
# still active via trio RPCs / activity hooks" case the docstring promises:
c = raw()
try:
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(-200), iso(-200), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-2), iso(-30), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: sessions.last_seen alone keeps agent live+working",
      liveness(agent) == (True, True))

# LIVE_SECONDS boundary: 59s fresh, 61s stale.
c = raw()
try:
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(-59), iso(-59), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-59), iso(-100), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: heartbeat at 59s is still fresh", (liveness(agent) or (False,))[0] is True)
c = raw()
try:
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(-61), iso(-61), CH, agent))
    c.execute("UPDATE sessions SET last_seen=? WHERE fingerprint=?", (iso(-61), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: heartbeat at 61s is stale", liveness(agent) == (False, False))

# blocked: fresh heartbeat but the session is frozen on a host prompt
# (blocked_since == activity) -> live but NOT working.
c = raw()
try:
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(0), iso(0), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=?, blocked_since=? WHERE fingerprint=?",
              (iso(-30), iso(-30), iso(-30), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: fresh but blocked -> (live, not working)",
      liveness(agent) == (True, False))
c = raw()
try:
    c.execute("UPDATE sessions SET blocked_since=NULL WHERE fingerprint=?", ("wi-sid-1",))
finally:
    c.close()

# no heartbeat within LIVE_SECONDS from any source -> not live, not working.
c = raw()
try:
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(-200), iso(-200), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-200), iso(-100), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: no heartbeat within LIVE_SECONDS -> not live",
      liveness(agent) == (False, False))

# Multi-channel agent (Sauron W1): the SAME member id present in two channels,
# working (activity > its own turn end) in one and idle (turn ended after
# activity) in the other. Per-session classification must report working;
# the old column-wise MAX(activity) vs MAX(turn_end) could cross-compare and
# wrongly report idle. Raw inserts (FK off on this connection) add the second
# channel membership + session for the same agent id.
c = raw()
try:
    # channel wi2: idle, but its turn ended very recently (-2s). A column-wise
    # MAX(last_turn_end) would pick THIS end and compare it against wi1's
    # activity, wrongly flipping the working agent to idle.
    c.execute("INSERT INTO members (id, channel, name, joined_at, last_seen, messenger_heartbeat) "
              "VALUES (?, 'wi2', 'Worker', ?, ?, ?)", (agent, iso(-2), iso(-2), iso(-2)))
    c.execute("INSERT INTO sessions (session_token, member_id, channel, connected_at, "
              "last_seen, fingerprint, last_turn_end) "
              "VALUES ('tok-wi2', ?, 'wi2', ?, ?, 'wi-sid-2', ?)",
              (agent, iso(-60), iso(-60), iso(-2)))
    # channel wi1: working — activity (-5s) after its OWN turn end (-30s).
    c.execute("UPDATE members SET last_seen=?, messenger_heartbeat=? WHERE channel=? AND id=?",
              (iso(-5), iso(-5), CH, agent))
    c.execute("UPDATE sessions SET last_seen=?, last_turn_end=? WHERE fingerprint=?",
              (iso(-5), iso(-30), "wi-sid-1"))
finally:
    c.close()
check("_agent_liveness: multi-channel — working in one channel is reported working",
      liveness(agent) == (True, True))
c = raw()
try:
    c.execute("DELETE FROM members WHERE id=? AND channel='wi2'", (agent,))
    c.execute("DELETE FROM sessions WHERE fingerprint='wi-sid-2'")
finally:
    c.close()

# A member row with NO live session (all revoked / never had one): heartbeat
# still drives freshness; no turn data -> not working; must not crash.
c = raw()
try:
    c.execute("INSERT INTO members (id, channel, name, joined_at, last_seen, messenger_heartbeat) "
              "VALUES ('ag_nosess', 'wi1', 'NoSession', ?, ?, ?)", (iso(0), iso(0), iso(0)))
finally:
    c.close()
check("_agent_liveness: member with no session -> (live, not working), no crash",
      liveness("ag_nosess") == (True, False))
os.environ["CLAUDE_CODE_SESSION_ID"] = "wi-sid-1"


os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
