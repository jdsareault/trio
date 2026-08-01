#!/usr/bin/env python3
"""Pure launchd configuration checks (does not call launchctl)."""
import sys
from types import SimpleNamespace
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
    "pins a strict service port": "--strict-port" in p["ProgramArguments"],
    "passes idle timeout": p["ProgramArguments"][-2:] == ["--agent-idle-minutes", "7"],
    "captures stdout/stderr": p["StandardOutPath"].endswith("hub.out.log") and p["StandardErrorPath"].endswith("hub.err.log"),
    "service PATH includes common Claude CLI locations":
        "/opt/homebrew/bin" in p["EnvironmentVariables"]["PATH"]
        and "/usr/local/bin" in p["EnvironmentVariables"]["PATH"],
}
for label, ok in checks.items():
    print(("PASS" if ok else "FAIL") + ": " + label)

calls = []
original_launchctl = launchd.launchctl
try:
    def fake_launchctl(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=5 if len(calls) == 1 else 0,
                               stdout="", stderr="transient")
    launchd.launchctl = fake_launchctl
    retry = launchd.bootstrap("gui/501", Path("/tmp/test.plist"), attempts=2, delay=0)
    retry_ok = retry.returncode == 0 and len(calls) == 2
finally:
    launchd.launchctl = original_launchctl
print(("PASS" if retry_ok else "FAIL") + ": retries transient bootstrap failures")
checks["retries transient bootstrap failures"] = retry_ok
print()
failed = sum(not ok for ok in checks.values())
print(f"{'FAILED' if failed else 'OK'} — {failed} failure(s)")
raise SystemExit(1 if failed else 0)
