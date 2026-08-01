"""Regression test: the monitor READS members.filter_mode from the DB each tick.

Feature #4 (FUTURE_IMPROVEMENTS.md — operator-adjustable wake filter). The
monitor used to WRITE its launch --filter arg into members.filter_mode every
heartbeat (a reporting mirror). It now reads the column as the single source of
truth for should_wake(), so an operator can retune an agent's wake filter from
the dashboard with no restart. This test locks in the precedence contract:

  * SEED  — a null column is seeded ONCE from the launch --filter arg.
  * DB WINS — a non-null column overrides the launch arg, and the heartbeat
              write never clobbers it back to the launch value.
  * FAIL OPEN — an unknown/invalid column value wakes on everything, so a bad
                write can never silently mute an agent.

It drives the REAL monitor() loop against a temporary sqlite DB — the actual
production read/seed/wake path, not duplicated logic.

Usage: python test-monitor-filter-db.py
"""
import json
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

# Import the real module under test from ../server.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_monitor as nm


failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def build_db(path, filter_mode):
    """Minimal schema matching the columns monitor() touches. filter_mode is
    seeded verbatim (may be None to exercise the null-column seed path, or a
    bogus string to exercise fail-open)."""
    db = sqlite3.connect(str(path))
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(
        """
        CREATE TABLE channels (code TEXT PRIMARY KEY, status TEXT, ended_by TEXT);
        CREATE TABLE members (
            id TEXT, channel TEXT, name TEXT, last_seen TEXT,
            last_read INTEGER DEFAULT 0, status_text TEXT DEFAULT '',
            messenger_heartbeat TEXT DEFAULT '', watchdog_heartbeat TEXT DEFAULT '',
            filter_mode TEXT, PRIMARY KEY (id, channel)
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, member_id TEXT,
            member_name TEXT, content TEXT, created_at TEXT,
            mentions TEXT DEFAULT '', refs TEXT DEFAULT '', bangs TEXT DEFAULT '',
            recipients TEXT DEFAULT ''
        );
        CREATE TABLE sessions (
            channel TEXT, member_id TEXT, last_read INTEGER DEFAULT 0, revoked_at TEXT
        );
        CREATE TABLE tasks (channel TEXT, claimed_by TEXT, status TEXT);
        """
    )
    db.execute("INSERT INTO channels (code, status) VALUES ('CHAN', 'active')")
    db.execute(
        "INSERT INTO members (id, channel, name, filter_mode) "
        "VALUES ('m1', 'CHAN', 'Alice', ?)",
        (filter_mode,),
    )
    db.commit()
    db.close()


def insert_message(path, content, mentions=None):
    """Insert a peer message (from m2, so monitor's member_id != self skip
    doesn't drop it). mentions is a list of member ids or None (ambient)."""
    db = sqlite3.connect(str(path))
    db.execute("PRAGMA busy_timeout=5000")
    db.execute(
        "INSERT INTO messages (channel, member_id, member_name, content, "
        "created_at, mentions) VALUES ('CHAN', 'm2', 'Bob', ?, ?, ?)",
        (content, now_iso(), json.dumps(mentions) if mentions else ""),
    )
    db.commit()
    db.close()


def read_filter_mode(path):
    db = sqlite3.connect(str(path))
    try:
        row = db.execute(
            "SELECT filter_mode FROM members WHERE id='m1' AND channel='CHAN'"
        ).fetchone()
        return row[0] if row else None
    finally:
        db.close()


def heartbeat_written(path):
    db = sqlite3.connect(str(path))
    try:
        row = db.execute(
            "SELECT messenger_heartbeat FROM members WHERE id='m1' AND channel='CHAN'"
        ).fetchone()
        return bool(row and row[0])
    finally:
        db.close()


class Capture:
    def __init__(self):
        self.events = []
        self.lock = threading.Lock()

    def __call__(self, event_dict):
        with self.lock:
            self.events.append(event_dict)

    def snapshot(self):
        with self.lock:
            return list(self.events)

    def new_messages(self):
        return [e for e in self.snapshot() if e.get("event") == "new_messages"]


def run_monitor(db_path, seed):
    cap = Capture()
    orig_emit = nm.emit
    nm.emit = cap
    t = threading.Thread(
        target=nm.monitor,
        kwargs={"channel": "CHAN", "member_id": "m1",
                "filter_mode": seed, "_db_path": str(db_path)},
        daemon=True,
    )
    t.start()
    return cap, t, orig_emit


def wait_until(pred, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


import tempfile
tmpdir = Path(tempfile.mkdtemp(prefix="nth-filter-db-test-"))

# ---------------------------------------------------------------------------
# Case 1: SEED — a null column is seeded once from the launch --filter arg.
# ---------------------------------------------------------------------------
db1 = tmpdir / "seed.db"
build_db(db1, filter_mode=None)
cap1, t1, orig1 = run_monitor(db1, seed="about")
try:
    seeded = wait_until(lambda: read_filter_mode(db1) == "about", timeout=5.0)
    check("null column is seeded from the launch --filter arg", seeded)
finally:
    nm.emit = orig1

# ---------------------------------------------------------------------------
# Case 2: DB WINS — a non-null column overrides the launch seed, and the
# heartbeat write does NOT clobber it back to the launch value. With column
# 'at' + seed 'all': ambient stays silent, only @pings wake.
# ---------------------------------------------------------------------------
db2 = tmpdir / "override.db"
build_db(db2, filter_mode="at")
cap2, t2, orig2 = run_monitor(db2, seed="all")
try:
    # The first tick stamps the heartbeat immediately. Under the OLD (buggy)
    # code that same tick also wrote the launch seed ('all') into filter_mode.
    hb = wait_until(lambda: heartbeat_written(db2), timeout=5.0)
    check("monitor ran a heartbeat tick (Case 2)", hb)
    check("heartbeat does NOT clobber a set filter_mode back to the seed",
          read_filter_mode(db2) == "at")

    # Ambient peer message (no mention): under 'at' this must NOT wake.
    insert_message(db2, "just chatting", mentions=None)
    # Give the monitor several poll intervals to (not) fire.
    time.sleep(1.2)
    check("column 'at' overrides seed 'all' — ambient message does NOT wake",
          len(cap2.new_messages()) == 0)

    # @ping message: must wake, tagged with the DB mode.
    insert_message(db2, "hey @Alice", mentions=["m1"])
    woke = wait_until(lambda: len(cap2.new_messages()) >= 1, timeout=5.0)
    check("@ping wakes under column 'at'", woke)
    if cap2.new_messages():
        ev = cap2.new_messages()[-1]
        check("wake event reports the DB filter mode ('at')", ev.get("filter") == "at")
        check("wake event carries only the @ping message", ev.get("has_mentions") is True)
finally:
    nm.emit = orig2

# ---------------------------------------------------------------------------
# Case 3: FAIL OPEN — an unknown/invalid column value wakes on everything, so
# a bad write can never silently mute an agent. Column 'bogus' + seed 'at':
# an ambient message (which 'at' would drop) must still wake.
# ---------------------------------------------------------------------------
db3 = tmpdir / "failopen.db"
build_db(db3, filter_mode="bogus")
cap3, t3, orig3 = run_monitor(db3, seed="at")
try:
    insert_message(db3, "ambient chatter, no mention", mentions=None)
    woke = wait_until(lambda: len(cap3.new_messages()) >= 1, timeout=5.0)
    check("invalid column value fails open — ambient message wakes", woke)
    if cap3.new_messages():
        ev = cap3.new_messages()[-1]
        check("fail-open wake is tagged 'all'", ev.get("filter") == "all")
    # The bogus value is non-null, so it is NOT re-seeded/normalized in place;
    # fail-open happens only in the wake decision.
    check("invalid non-null value is left untouched (not seeded over)",
          read_filter_mode(db3) == "bogus")
finally:
    nm.emit = orig3

if failures:
    print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
    sys.exit(1)
print("\nAll checks passed.")
