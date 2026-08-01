#!/usr/bin/env python3
"""Install/manage the unified nth hub as a macOS LaunchAgent.

Usage:
  python3 server/nth_launchd.py install
  python3 server/nth_launchd.py status
  python3 server/nth_launchd.py uninstall
  python3 server/nth_launchd.py install --dry-run
"""
from __future__ import annotations

import argparse
import os
import plistlib
import shutil
import subprocess
import sys
import time
from pathlib import Path

LABEL = "com.nth.trio-hub"


def service_path() -> str:
    """PATH for a non-shell LaunchAgent, including installed CLI locations.

    A LaunchAgent doesn't inherit the interactive shell PATH, so any provider
    CLI installed outside the hardcoded system/Homebrew directories must have
    its parent directory added explicitly here — for every supported runtime
    (claude, codex, ...), not just claude."""
    entries = []
    for candidate in (str(Path(sys.executable).resolve().parent),
                      str(Path(shutil.which("claude") or "").parent),
                      str(Path(shutil.which("codex") or "").parent),
                      "/opt/homebrew/bin", "/usr/local/bin",
                      "/usr/bin", "/bin", "/usr/sbin", "/sbin"):
        if candidate and candidate != "." and candidate not in entries:
            entries.append(candidate)
    return ":".join(entries)


def build_plist(*, python: str, web_script: str, db_path: str, port: int = 8765,
                idle_minutes: float = 10.0, log_dir: str,
                path_env: str = "") -> dict:
    args = [python, web_script, "--db", db_path, "--port", str(port),
            "--strict-port", "--agent-idle-minutes", str(idle_minutes)]
    return {
        "Label": LABEL,
        "ProgramArguments": args,
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 5,
        "WorkingDirectory": str(Path(web_script).resolve().parent.parent),
        "StandardOutPath": str(Path(log_dir) / "hub.out.log"),
        "StandardErrorPath": str(Path(log_dir) / "hub.err.log"),
        "EnvironmentVariables": {
            "PYTHONUNBUFFERED": "1",
            "PATH": path_env or service_path(),
        },
        "ProcessType": "Interactive",
    }


def launchctl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", *args], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def bootstrap(domain: str, plist_path: Path, attempts: int = 8,
              delay: float = 0.25) -> subprocess.CompletedProcess:
    """Load a LaunchAgent, tolerating launchd's brief post-bootout race."""
    result = None
    for attempt in range(max(1, attempts)):
        result = launchctl("bootstrap", domain, str(plist_path), check=False)
        if result.returncode == 0:
            return result
        if attempt + 1 < attempts:
            time.sleep(delay)
    assert result is not None
    return result


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Install the nth unified hub as a macOS LaunchAgent")
    ap.add_argument("command", choices=("install", "uninstall", "status"))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--agent-idle-minutes", type=float, default=10.0)
    ap.add_argument("--db", default=str(Path.home() / ".claude" / "nth" / "nth.db"))
    ap.add_argument("--dry-run", action="store_true")
    ns = ap.parse_args(argv)
    if sys.platform != "darwin":
        sys.stderr.write("nth_launchd is only available on macOS.\n")
        return 2

    plist_path = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    logs = Path.home() / ".claude" / "nth" / "logs"
    web_script = Path(__file__).resolve().with_name("nth_web.py")
    domain = f"gui/{os.getuid()}"
    service = f"{domain}/{LABEL}"

    if ns.command == "status":
        result = launchctl("print", service, check=False)
        if result.returncode:
            print("nth hub is not loaded")
            return 1
        print(result.stdout.rstrip())
        return 0

    if ns.command == "uninstall":
        if ns.dry_run:
            print(f"would bootout {service} and remove {plist_path}")
            return 0
        launchctl("bootout", service, check=False)
        try:
            plist_path.unlink()
        except FileNotFoundError:
            pass
        print(f"removed {LABEL}")
        return 0

    plist = build_plist(
        python=sys.executable, web_script=str(web_script), db_path=ns.db,
        port=ns.port, idle_minutes=ns.agent_idle_minutes, log_dir=str(logs))
    payload = plistlib.dumps(plist, fmt=plistlib.FMT_XML, sort_keys=False)
    if ns.dry_run:
        sys.stdout.buffer.write(payload)
        return 0
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    plist_path.write_bytes(payload)
    launchctl("bootout", service, check=False)
    result = bootstrap(domain, plist_path)
    if result.returncode:
        sys.stderr.write(result.stderr or "launchctl bootstrap failed\n")
        return result.returncode
    launchctl("kickstart", "-k", service, check=False)
    print(f"installed {LABEL} at {plist_path}")
    print(f"open http://127.0.0.1:{ns.port}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
