"""Tests for same-name ghost pruning on connect (fix/duplicate-agent-cull, option B).

A session that reconnects under the same name used to leave its old member row
behind, piling up duplicate rows (which also made @Name wake every copy). Now a
join first prunes any DEAD same-name agent ghost — one with no live session —
while leaving genuinely-live same-name members and humans untouched.

Drives the real nth_server connect + prune logic against a temp DB.
Usage: python tests/test-name-dedup.py
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

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_dedup_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"
DB = str(srv.DB_PATH)


def iso(delta=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta)).isoformat()


def connect(name, channel="", sid=None):
    if sid is not None:
        os.environ["CLAUDE_CODE_SESSION_ID"] = sid
    else:
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
    r = json.loads(srv.nth_connect(summary="t", name=name, channel=channel))
    return r["channel"], r["member_id"]


def raw():
    c = sqlite3.connect(DB, isolation_level=None)
    c.row_factory = sqlite3.Row
    return c


def make_dead(member_id, channel):
    """Simulate a fully-dead ghost: its Monitor heartbeat (members.last_seen) is
    stale (process gone), its session is stale, and it joined a while ago."""
    c = raw()
    try:
        c.execute("UPDATE members SET last_seen=?, joined_at=? WHERE channel=? AND id=?",
                  (iso(-4000), iso(-5000), channel, member_id))
        c.execute("UPDATE sessions SET last_seen=? WHERE channel=? AND member_id=?",
                  (iso(-4000), channel, member_id))
    finally:
        c.close()


def members_named(channel, name):
    c = raw()
    try:
        return [r["id"] for r in c.execute(
            "SELECT id FROM members WHERE channel=? AND name=?", (channel, name)).fetchall()]
    finally:
        c.close()


# ── 1: a stale same-name ghost is pruned on reconnect ────────────────────────
CH, dev1 = connect("Dev", channel="dd1", sid="dev-sid-1")
make_dead(dev1, CH)
_c, dev2 = connect("Dev", channel=CH, sid="dev-sid-2")
named = members_named(CH, "Dev")
check("1: only one 'Dev' member remains after reconnect", named == [dev2])
check("1: the stale ghost row is gone", dev1 not in named)
c = raw()
try:
    sup = c.execute("SELECT content FROM messages WHERE channel=? AND content LIKE '[superseded]%'",
                    (CH,)).fetchone()
    revoked = c.execute("SELECT revoked_at FROM sessions WHERE channel=? AND member_id=?",
                        (CH, dev1)).fetchone()
finally:
    c.close()
check("1: a [superseded] system line was posted", sup is not None)
check("1: the ghost's session was revoked", revoked and revoked["revoked_at"] is not None)


# ── 2: a genuinely LIVE same-name member is NOT pruned ───────────────────────
CH2, liveA = connect("Twin", channel="dd2", sid="twin-a")
# liveA's session is fresh (just connected) -> live -> must survive a same-name join
_c, liveB = connect("Twin", channel=CH2, sid="twin-b")
named2 = members_named(CH2, "Twin")
check("2: a live same-name member is left alone (both coexist)",
      set(named2) == {liveA, liveB})


# ── 3: pruning a ghost releases its claimed task ─────────────────────────────
CH3, wrk1 = connect("Worker", channel="dd3", sid="wrk-1")
_c, boss = connect("Boss", channel=CH3, sid="boss-1")
tid = json.loads(srv.nth_send(channel=CH3, member_id=boss, message="do it", task=True))["task_id"]
json.loads(srv.nth_claim(channel=CH3, member_id=wrk1, task_id=tid))
make_dead(wrk1, CH3)
_c, wrk2 = connect("Worker", channel=CH3, sid="wrk-2")
c = raw()
try:
    t = c.execute("SELECT status, claimed_by FROM tasks WHERE id=?", (tid,)).fetchone()
finally:
    c.close()
check("3: ghost pruned -> its claimed task released to open",
      t["status"] == "open" and t["claimed_by"] is None)
check("3: only one 'Worker' remains", members_named(CH3, "Worker") == [wrk2])


# ── 4: a human with the same name is NEVER pruned ────────────────────────────
CH4, agentX = connect("Sam", channel="dd4", sid="sam-agent")
# turn a second member into a human named 'Sam', make it stale (still must survive)
_c, humanSam = connect("Sam", channel=CH4, sid="sam-human")
c = raw()
try:
    c.execute("UPDATE members SET kind='human' WHERE channel=? AND id=?", (CH4, humanSam))
finally:
    c.close()
make_dead(humanSam, CH4)
make_dead(agentX, CH4)
_c, agentY = connect("Sam", channel=CH4, sid="sam-agent-2")
named4 = set(members_named(CH4, "Sam"))
check("4: the stale human 'Sam' is preserved (humans never pruned)", humanSam in named4)
check("4: the stale AGENT 'Sam' ghost was pruned", agentX not in named4)
check("4: the new agent 'Sam' joined", agentY in named4)


# ── 5: a dead legacy member with NO session row is treated as a ghost ────────
CH5, _seed = connect("Seeded", channel="dd5", sid="seed-1")
c = raw()
try:
    # bare member, no sessions row at all (pre-v6 style), heartbeat long stale
    c.execute("INSERT INTO members (id, channel, name, summary, skills, last_seen, last_read, "
              "joined_at, active) VALUES ('legacy1', ?, 'Legacy', '', '', ?, 0, ?, 1)",
              (CH5, iso(-4000), iso(-5000)))
finally:
    c.close()
_c, legacy_new = connect("Legacy", channel=CH5, sid="legacy-2")
check("5: a dead session-less legacy same-name row is pruned as a ghost",
      members_named(CH5, "Legacy") == [legacy_new])


# ── 6: an idle-but-ALIVE agent (fresh Monitor heartbeat, stale session) is
#      spared — the key regression for the concurrent-race / idle-eviction fix.
CH6, idleA = connect("Idle", channel="dd6", sid="idle-a")
c = raw()
try:
    # process alive (members.last_seen fresh via monitor), but idle >5min at the
    # session level, and it joined long ago (so no "just-joined" grace masks it)
    c.execute("UPDATE members SET last_seen=?, joined_at=? WHERE channel=? AND id=?",
              (iso(-5), iso(-9999), CH6, idleA))
    c.execute("UPDATE sessions SET last_seen=? WHERE channel=? AND member_id=?",
              (iso(-4000), CH6, idleA))
finally:
    c.close()
_c, idleB = connect("Idle", channel=CH6, sid="idle-b")
named6 = set(members_named(CH6, "Idle"))
check("6: idle-but-alive agent (fresh heartbeat) is NOT pruned", idleA in named6)
check("6: the new same-name join still succeeds alongside it", idleB in named6)


# ── 7: name matching is case- and whitespace-insensitive ─────────────────────
CH7, dga = connect("Case", channel="dd7", sid="case-1")
make_dead(dga, CH7)
_c, dgb = connect("  case  ", channel=CH7, sid="case-2")  # variant case + spaces
c = raw()
try:
    remaining = [row["id"] for row in
                 c.execute("SELECT id FROM members WHERE channel=?", (CH7,)).fetchall()]
finally:
    c.close()
check("7: a case/space-variant reconnect prunes the dead same-name ghost", dga not in remaining)
check("7: the new variant-cased member is present", dgb in remaining)


os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
