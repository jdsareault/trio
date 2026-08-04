"""Monitor reconciliation must use members.last_read, not sessions.last_read."""

import sqlite3
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_monitor as nm  # noqa: E402


failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + f": {name}")
    if not condition:
        failures.append(name)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class Capture:
    def __init__(self):
        self.events = []
        self.lock = threading.Lock()

    def __call__(self, event):
        with self.lock:
            self.events.append(event)

    def messages(self):
        with self.lock:
            return [e for e in self.events if e.get("event") == "new_messages"]


tmp = Path(tempfile.mkdtemp(prefix="nth-monitor-global-watermark-"))
db_path = tmp / "monitor.db"
db = sqlite3.connect(str(db_path))
db.executescript(
    """
    CREATE TABLE channels (code TEXT PRIMARY KEY, status TEXT, ended_by TEXT);
    CREATE TABLE members (
        id TEXT, channel TEXT, name TEXT, last_seen TEXT,
        last_read INTEGER DEFAULT 0, status_text TEXT DEFAULT '',
        messenger_heartbeat TEXT DEFAULT '', watchdog_heartbeat TEXT DEFAULT '',
        filter_mode TEXT DEFAULT 'all', PRIMARY KEY (id, channel)
    );
    CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, member_id TEXT,
        member_name TEXT, content TEXT, created_at TEXT,
        mentions TEXT DEFAULT '', refs TEXT DEFAULT '', bangs TEXT DEFAULT '',
        recipients TEXT DEFAULT ''
    );
    CREATE TABLE sessions (
        session_token TEXT, member_id TEXT, channel TEXT,
        last_read INTEGER DEFAULT 0, revoked_at TEXT
    );
    CREATE TABLE tasks (channel TEXT, claimed_by TEXT, status TEXT);
    """
)
db.execute("INSERT INTO channels VALUES ('wm-monitor', 'active', NULL)")
db.execute(
    "INSERT INTO members (id, channel, name, last_read, filter_mode) "
    "VALUES ('agent', 'wm-monitor', 'Agent', 0, 'all')"
)
# This is the stale legacy/global cursor that used to win reconciliation.
db.execute(
    "INSERT INTO sessions VALUES ('token', 'agent', 'wm-monitor', 999, NULL)"
)
db.execute(
    "INSERT INTO messages (channel, member_id, member_name, content, created_at) "
    "VALUES ('wm-monitor', 'peer', 'Peer', 'new work', ?)",
    (now_iso(),),
)
db.commit()
db.close()

capture = Capture()
old_emit = nm.emit
nm.emit = capture
thread = threading.Thread(
    target=nm.monitor,
    kwargs={"channel": "wm-monitor", "member_id": "agent",
            "filter_mode": "all", "_db_path": str(db_path)},
    daemon=True,
)
thread.start()
try:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not capture.messages():
        time.sleep(0.02)
    check("monitor wakes from members.last_read despite stale session cursor",
          bool(capture.messages()))
finally:
    nm.emit = old_emit

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
