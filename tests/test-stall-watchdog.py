"""Tests for the stall-watchdog (StallWatchdog in nth_web) + its session-id
capture and stall_events schema.

Drives the real nth_server DB + nth_web.StallWatchdog logic against a temp DB.
Covers, end to end:
  * connect captures CLAUDE_CODE_SESSION_ID into sessions.fingerprint (the fix)
  * a transient stall becomes a due nudge that @mentions the agent + the human
  * backoff gating (not-yet-due stalls are left alone)
  * resume detection (session activity past the stall) resolves + retracts nudges
  * non-transient errors are surfaced, never nudged
  * give-up after the backoff schedule is exhausted
  * human targets are never nudged
  * unmapped session_ids are dropped only after the grace period
  * a watchdog only handles its own channel's stalls

Usage: python tests/test-stall-watchdog.py
"""
import json
import os
import shutil
import sqlite3
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


_tmp = tempfile.mkdtemp(prefix="nth_watchdog_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"
DB_PATH = srv.DB_PATH


def iso(delta_seconds=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_seconds)).isoformat()


def connect(name, channel="", session_id=None):
    """Connect a member, optionally with a specific Claude session id (captured
    into sessions.fingerprint by the connect flow)."""
    if session_id is not None:
        os.environ["CLAUDE_CODE_SESSION_ID"] = session_id
    else:
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
    r = json.loads(srv.nth_connect(summary="t", name=name, channel=channel))
    return r["channel"], r["member_id"]


def raw():
    c = sqlite3.connect(str(DB_PATH), isolation_level=None)
    c.row_factory = sqlite3.Row
    return c


def set_last_seen(member_id, channel, ts):
    c = raw()
    try:
        c.execute("UPDATE sessions SET last_seen=? WHERE channel=? AND member_id=?",
                  (ts, channel, member_id))
    finally:
        c.close()


def set_kind(member_id, channel, kind):
    c = raw()
    try:
        c.execute("UPDATE members SET kind=? WHERE channel=? AND id=?",
                  (kind, channel, member_id))
    finally:
        c.close()


def insert_stall(session_id, error, created_at, nudge_count=0, last_nudge_at=None):
    c = raw()
    try:
        cur = c.execute(
            "INSERT INTO stall_events (session_id, error, cwd, created_at, "
            "nudge_count, last_nudge_at) VALUES (?, ?, '', ?, ?, ?)",
            (session_id, error, created_at, nudge_count, last_nudge_at),
        )
        return cur.lastrowid
    finally:
        c.close()


def clear_stalls():
    c = raw()
    try:
        c.execute("DELETE FROM stall_events")
    finally:
        c.close()


def event(event_id):
    c = raw()
    try:
        return c.execute("SELECT * FROM stall_events WHERE id=?", (event_id,)).fetchone()
    finally:
        c.close()


def watchdog_tick(channel):
    """Run exactly one watchdog scan for `channel` against the DB."""
    wd = web.StallWatchdog(DB_PATH, channel)
    c = raw()
    try:
        wd._tick(c)
    finally:
        c.close()


def nudges_for(channel, member_id, include_retracted=True):
    c = raw()
    try:
        rows = c.execute(
            "SELECT id, content, mentions, retracted_at FROM messages "
            "WHERE channel=? AND member_id=? ORDER BY id",
            (channel, web.StallWatchdog.AUTHOR_ID),
        ).fetchall()
    finally:
        c.close()
    out = []
    for r in rows:
        if not include_retracted and r["retracted_at"]:
            continue
        out.append(r)
    return out


# ── H: connect captures the real session id (the fix) ────────────────────────
CH, agent = connect("Agent", channel="wd1", session_id="sid-agent-1")
fp = raw().execute("SELECT fingerprint FROM sessions WHERE member_id=?", (agent,)).fetchone()["fingerprint"]
check("connect captures CLAUDE_CODE_SESSION_ID into fingerprint", fp == "sid-agent-1")

_ch, human = connect("Operator", channel=CH, session_id="sid-human-1")
set_kind(human, CH, "human")


# ── A: a due transient stall produces a nudge mentioning agent + human ───────
clear_stalls()
# agent last acted 10m ago; stalled 5m ago (after last activity, and > 60s -> due)
set_last_seen(agent, CH, iso(-600))
eid = insert_stall("sid-agent-1", "overloaded", iso(-300))
watchdog_tick(CH)
ev = event(eid)
check("A: nudge_count incremented to 1", ev["nudge_count"] == 1)
check("A: last_nudge_at recorded", bool(ev["last_nudge_at"]))
check("A: event still open (not resolved)", ev["resolved_at"] is None)
ns = nudges_for(CH, agent)
check("A: exactly one nudge message posted", len(ns) == 1)
if ns:
    ment = json.loads(ns[0]["mentions"] or "[]")
    check("A: nudge @mentions the stalled agent (wakes it)", agent in ment)
    check("A: nudge @mentions the human", human in ment)
    check("A: nudge reads as a continue instruction", "continue" in ns[0]["content"].lower())


# ── C: resume detection resolves + retracts the nudge ────────────────────────
# Continuation of A's nudged event: the agent now 'acts' (last_seen past stall).
set_last_seen(agent, CH, iso(0))
watchdog_tick(CH)
ev = event(eid)
check("C: resumed stall resolved", ev["resolved_at"] is not None and ev["resolution"] == "resumed")
live = nudges_for(CH, agent, include_retracted=False)
check("C: outstanding nudge auto-retracted on resume", len(live) == 0)


# ── B: a not-yet-due stall is left alone ─────────────────────────────────────
clear_stalls()
CH_B, agentB = connect("AgentB", channel="wd2", session_id="sid-b")
set_last_seen(agentB, CH_B, iso(-600))
eidB = insert_stall("sid-b", "overloaded", iso(-30))  # only 30s < 60s backoff[0]
watchdog_tick(CH_B)
evB = event(eidB)
check("B: not-yet-due stall not nudged", evB["nudge_count"] == 0 and evB["resolved_at"] is None)
check("B: no nudge message posted", len(nudges_for(CH_B, agentB)) == 0)


# ── D: a non-transient error is surfaced, never nudged ───────────────────────
clear_stalls()
CH_D, agentD = connect("AgentD", channel="wd3", session_id="sid-d")
_c, humanD = connect("OpD", channel=CH_D, session_id="sid-d-human")
set_kind(humanD, CH_D, "human")
set_last_seen(agentD, CH_D, iso(-600))
eidD = insert_stall("sid-d", "authentication_failed", iso(-300))
watchdog_tick(CH_D)
evD = event(eidD)
check("D: non-transient stall resolved as surfaced",
      evD["resolution"] == "surfaced" and evD["resolved_at"] is not None)
check("D: non-transient stall never nudged", evD["nudge_count"] == 0)
msgsD = nudges_for(CH_D, agentD)
check("D: a surface message was posted", len(msgsD) == 1)
if msgsD:
    ment = json.loads(msgsD[0]["mentions"] or "[]")
    check("D: surface message does NOT say continue", "continue" not in msgsD[0]["content"].lower())
    check("D: surface message pings the human", humanD in ment)


# ── E: give up after the backoff schedule is exhausted ───────────────────────
clear_stalls()
CH_E, agentE = connect("AgentE", channel="wd4", session_id="sid-e")
set_last_seen(agentE, CH_E, iso(-100000))
# nudge_count already at the cap, last nudge long ago -> due -> give up
eidE = insert_stall("sid-e", "overloaded", iso(-100000),
                    nudge_count=len(web.StallWatchdog.BACKOFF), last_nudge_at=iso(-100000))
watchdog_tick(CH_E)
evE = event(eidE)
check("E: exhausted backoff -> gave_up", evE["resolution"] == "gave_up" and evE["resolved_at"] is not None)
gaveup_msgs = [m for m in nudges_for(CH_E, agentE) if "giving up" in m["content"].lower()]
check("E: a give-up message was posted", len(gaveup_msgs) == 1)


# ── F: a human target is never nudged ────────────────────────────────────────
clear_stalls()
CH_F, humanF = connect("HumanF", channel="wd5", session_id="sid-f")
set_kind(humanF, CH_F, "human")
set_last_seen(humanF, CH_F, iso(-600))
eidF = insert_stall("sid-f", "overloaded", iso(-300))
watchdog_tick(CH_F)
evF = event(eidF)
check("F: human target resolved as not_agent", evF["resolution"] == "not_agent")
check("F: human target not nudged", evF["nudge_count"] == 0)


# ── G: unmapped session ids -> dropped only after grace ──────────────────────
clear_stalls()
CH_G, agentG = connect("AgentG", channel="wd6", session_id="sid-g")
# recent unmapped (no session has this fingerprint) -> left alone
eidG_new = insert_stall("sid-nobody", "overloaded", iso(-10))
# old unmapped -> dropped
eidG_old = insert_stall("sid-nobody", "overloaded", iso(-(web.StallWatchdog.UNMAPPED_GRACE + 60)))
watchdog_tick(CH_G)
check("G: recent unmapped stall left open", event(eidG_new)["resolved_at"] is None)
check("G: aged-out unmapped stall dropped", event(eidG_old)["resolution"] == "unmapped")


# ── I: a watchdog ignores stalls that belong to another channel ──────────────
clear_stalls()
CH_I1, agentI = connect("AgentI", channel="wd7", session_id="sid-i")
set_last_seen(agentI, CH_I1, iso(-600))
eidI = insert_stall("sid-i", "overloaded", iso(-300))
watchdog_tick("wd_other")  # a watchdog for a DIFFERENT channel
evI = event(eidI)
check("I: foreign-channel watchdog leaves the stall untouched",
      evI["nudge_count"] == 0 and evI["resolved_at"] is None)
# the right channel's watchdog does handle it
watchdog_tick(CH_I1)
check("I: own-channel watchdog nudges it", event(eidI)["nudge_count"] == 1)


shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
