#!/usr/bin/env python3
"""Unit 2: web display names resolve globally across channel presence rows."""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
from nth_web import resolve_display_name  # noqa: E402


db = sqlite3.connect(":memory:")
db.row_factory = sqlite3.Row
db.executescript("""
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE members (id TEXT NOT NULL, channel TEXT NOT NULL, name TEXT);
""")
db.execute("INSERT INTO agents (id, name) VALUES ('ag-global', 'Canonical Agent')")
db.execute("INSERT INTO members (id, channel, name) VALUES ('ag-global', 'channel-a', 'Old Name')")
db.execute("INSERT INTO members (id, channel, name) VALUES ('legacy', 'channel-a', 'Zed')")
db.execute("INSERT INTO members (id, channel, name) VALUES ('legacy', 'channel-b', 'Ada')")
db.commit()

checks = [
    ("agent registry name wins across channels",
     resolve_display_name(db, "ag-global") == "Canonical Agent"),
    ("legacy member name resolves across channels",
     resolve_display_name(db, "legacy") == "Zed"),
    ("unknown ids fall back to themselves",
     resolve_display_name(db, "ag-unknown") == "ag-unknown"),
]
trace = []
db.set_trace_callback(trace.append)
cache = {}
for _ in range(5):
    resolve_display_name(db, "ag-global", cache)
db.set_trace_callback(None)
checks.append(("request cache avoids repeated name queries",
               sum(sql.lstrip().upper().startswith("SELECT") for sql in trace) == 1))
failures = 0
for label, ok in checks:
    print(("PASS" if ok else "FAIL") + ": " + label)
    failures += not ok
db.close()

print()
print(f"{'FAILED' if failures else 'OK'} — {failures} failure(s)")
raise SystemExit(1 if failures else 0)
