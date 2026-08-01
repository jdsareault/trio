#!/usr/bin/env python3
"""Pure app lifecycle/doctor checks; does not modify launchd."""
import os
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"

import nth_app  # noqa: E402
import nth_web  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + ": " + name)
    if not condition:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth_app_"))
db_path = tmp / "nth.db"
try:
    check("stable loopback URL", nth_app.app_url(9123) == "http://127.0.0.1:9123/")
    before = nth_app.database_status(db_path)
    check("doctor explains an absent database", not before["ready"] and not before["exists"])
    nth_web.initialize_database(db_path)
    report = nth_app.doctor_report(db_path, 9123, probe_hub=False)
    check("doctor sees a healthy initialized database",
          report["database"]["ready"] and report["database"]["quick_check"] == "ok")
    check("doctor uses the configured Claude runtime adapter",
          report["claude"]["provider"] == "claude" and report["claude"]["ready"])
    check("doctor can skip network probing in pure tests", report["hub"] is None)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
