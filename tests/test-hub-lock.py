#!/usr/bin/env python3
"""Only one unified hub may own a database's managed-agent control plane."""
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

import nth_web as web  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + ": " + name)
    if not condition:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth_hub_lock_"))
db_path = tmp / "nth.db"
first = web.UnifiedHubLock(db_path)
second = web.UnifiedHubLock(db_path)
try:
    first.acquire()
    check("first unified hub acquires the database lock", first.handle is not None)
    denied = False
    try:
        second.acquire()
    except RuntimeError as exc:
        denied = "another unified nth hub" in str(exc)
    check("second unified hub is rejected with an actionable error", denied)
    first.close()
    second.acquire()
    check("ownership can move after the first hub exits", second.handle is not None)
finally:
    first.close()
    second.close()
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
