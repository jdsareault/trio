#!/usr/bin/env python3
"""Pure launchd configuration checks (does not call launchctl)."""
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_launchd as launchd  # noqa: E402

p = launchd.build_plist(
    python="/usr/bin/python3", web_script="/repo/server/nth_web.py",
    db_path="/tmp/nth.db", port=9000, idle_minutes=7, log_dir="/tmp/logs")
checks = {
    "stable launchd label": p["Label"] == "com.nth.trio-hub",
    "starts at login": p["RunAtLoad"] is True,
    "restarts after failure": p["KeepAlive"] == {"SuccessfulExit": False},
    "runs unified nth_web (no channel arg)": p["ProgramArguments"][:2] == ["/usr/bin/python3", "/repo/server/nth_web.py"],
    "passes db + port": "--db" in p["ProgramArguments"] and "9000" in p["ProgramArguments"],
    "passes idle timeout": p["ProgramArguments"][-2:] == ["--agent-idle-minutes", "7"],
    "captures stdout/stderr": p["StandardOutPath"].endswith("hub.out.log") and p["StandardErrorPath"].endswith("hub.err.log"),
}
for label, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + label)
print()
failed = sum(not ok for ok in checks.values())
print(f"{'FAILED' if failed else 'OK'} — {failed} failure(s)")
raise SystemExit(1 if failed else 0)
