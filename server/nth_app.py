#!/usr/bin/env python3
"""Install, inspect, and open the nth unified workspace app.

Examples:
  python3 server/nth_app.py install
  python3 server/nth_app.py doctor
  python3 server/nth_app.py open
  python3 server/nth_app.py uninstall
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nth_launchd  # noqa: E402
import nth_supervisor  # noqa: E402
import nth_web  # noqa: E402


DEFAULT_DB = Path.home() / ".claude" / "nth" / "nth.db"
DEFAULT_PORT = 8765


def app_url(port: int) -> str:
    return f"http://127.0.0.1:{port}/"


def fetch_health(port: int, timeout: float = 2.0) -> Optional[Dict[str, Any]]:
    try:
        with urllib.request.urlopen(app_url(port) + "api/health", timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return None


def launchd_loaded() -> bool:
    if sys.platform != "darwin":
        return False
    service = f"gui/{os.getuid()}/{nth_launchd.LABEL}"
    return nth_launchd.launchctl("print", service, check=False).returncode == 0


def database_status(path: Path) -> Dict[str, Any]:
    result: Dict[str, Any] = {"path": str(path), "exists": path.is_file(), "ready": False}
    if not path.is_file():
        result["detail"] = "workspace database has not been initialized"
        return result
    try:
        db = sqlite3.connect(str(path), timeout=5)
        try:
            check = db.execute("PRAGMA quick_check").fetchone()[0]
            result.update(quick_check=check, ready=check == "ok",
                          channels=db.execute("SELECT COUNT(*) FROM channels").fetchone()[0],
                          agents=db.execute("SELECT COUNT(*) FROM agents").fetchone()[0])
        finally:
            db.close()
    except sqlite3.Error as exc:
        result["detail"] = str(exc)
    return result


def doctor_report(db_path: Path, port: int, *, probe_hub: bool = True) -> Dict[str, Any]:
    # Report every configured provider (Claude, Codex) rather than requiring
    # Claude specifically — a Codex-only workspace with a healthy database and
    # hub must not be reported as failing (bugs/2026-08-01-app-doctor-requires-
    # claude-for-codex-only.md).
    runtimes = {
        "claude": nth_supervisor.ClaudeRuntime().diagnostics(),
        "codex": nth_web.runtime_health(provider="codex"),
    }
    return {
        "database": database_status(db_path),
        "claude": runtimes["claude"],
        "runtimes": runtimes,
        "service_loaded": launchd_loaded(),
        "hub": fetch_health(port) if probe_hub else None,
        "url": app_url(port),
    }


def print_report(report: Dict[str, Any]) -> None:
    db = report["database"]
    runtimes = report.get("runtimes") or {"claude": report["claude"]}
    hub = report.get("hub")
    print("nth app doctor")
    print(f"  database: {'ready' if db.get('ready') else 'needs attention'} — {db['path']}")
    if db.get("ready"):
        print(f"            {db.get('channels', 0)} channels, {db.get('agents', 0)} agents")
    elif db.get("detail"):
        print(f"            {db['detail']}")
    for name, runtime in runtimes.items():
        print(f"  {name}:{' ' * max(1, 9 - len(name))}{'ready' if runtime.get('ready') else 'needs attention'}")
        print(f"            {runtime.get('detail') or runtime.get('version') or 'unknown'}")
    if sys.platform == "darwin":
        print(f"  service:  {'loaded' if report.get('service_loaded') else 'not loaded'}")
    print(f"  web app:  {'running' if hub else 'not reachable'} — {report['url']}")


def wait_for_hub(port: int, timeout: float = 12.0) -> Optional[Dict[str, Any]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        health = fetch_health(port, timeout=1.0)
        if health is not None:
            return health
        time.sleep(0.25)
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Install and manage the nth workspace app")
    ap.add_argument("command", choices=("install", "doctor", "status", "open", "uninstall"))
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--agent-idle-minutes", type=float, default=10.0)
    ap.add_argument("--no-open", action="store_true", help="Do not open the browser after install")
    ap.add_argument("--json", action="store_true", help="Print doctor/status as JSON")
    ns = ap.parse_args(argv)
    db_path = ns.db.expanduser().resolve()

    if ns.command in ("doctor", "status"):
        report = doctor_report(db_path, ns.port)
        print(json.dumps(report, indent=2) if ns.json else "", end="" if ns.json else "")
        if not ns.json:
            print_report(report)
        elif ns.json:
            print()
        runtimes = report.get("runtimes") or {"claude": report["claude"]}
        any_runtime_ready = any(r.get("ready") for r in runtimes.values())
        return 0 if report["database"].get("ready") and any_runtime_ready else 1

    if ns.command == "open":
        url = app_url(ns.port)
        if fetch_health(ns.port) is None:
            sys.stderr.write("nth web app is not running; run `nth_app.py install` first\n")
            return 1
        webbrowser.open(url)
        print(url)
        return 0

    if ns.command == "uninstall":
        return nth_launchd.main(["uninstall", "--port", str(ns.port), "--db", str(db_path)])

    # install
    try:
        created = nth_web.initialize_database(db_path)
    except Exception as exc:
        sys.stderr.write(f"could not initialize {db_path}: {exc}\n")
        return 1
    if created:
        print(f"created workspace database: {db_path}")
    rc = nth_launchd.main([
        "install", "--port", str(ns.port), "--db", str(db_path),
        "--agent-idle-minutes", str(ns.agent_idle_minutes),
    ])
    if rc:
        return rc
    health = wait_for_hub(ns.port)
    if health is None:
        sys.stderr.write("nth service was installed but the web app did not become reachable\n")
        return 1
    url = app_url(ns.port)
    print(f"nth workspace is running: {url}")
    runtime = health.get("runtime") or {}
    if not runtime.get("ready"):
        print(f"attention: {runtime.get('detail') or 'Claude Code is not ready'}")
    if not ns.no_open:
        webbrowser.open(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
