#!/usr/bin/env python3
"""Fresh installs create a complete workspace database automatically."""
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

import nth_server as srv  # noqa: E402
import nth_web as web  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + ": " + name)
    if not condition:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth_first_run_"))
path = tmp / "nested" / "nth.db"
try:
    check("database starts absent", not path.exists())
    check("first initialization reports creation", web.initialize_database(path))
    check("database file is created", path.is_file())
    check("second initialization is idempotent", not web.initialize_database(path))

    db = sqlite3.connect(str(path))
    try:
        tables = {r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        check("canonical collaboration tables exist",
              {"channels", "members", "messages", "tasks", "locks", "sessions"}
              <= tables)
        check("managed-agent tables exist",
              {"agents", "agent_channels", "agent_runtime_history"} <= tables)
        cols = {r[1] for r in db.execute("PRAGMA table_info(messages)").fetchall()}
        check("current DM and interaction columns exist",
              {"recipients", "reply_to", "choices", "selection", "confidence"}
              <= cols)
    finally:
        db.close()

    # A custom first-run path must not redirect normal MCP calls globally.
    check("custom initialization leaves the configured MCP DB path unchanged",
          srv.DB_PATH != path)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
