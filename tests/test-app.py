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

    # bugs/2026-08-01-app-doctor-requires-claude-for-codex-only.md: a healthy
    # database + a usable Codex runtime must succeed even with Claude missing.
    class _UnavailableClaude:
        def diagnostics(self, timeout=5.0):
            return {"provider": "claude", "ready": False, "detail": "claude CLI not found"}

    orig_claude_runtime = nth_app.nth_supervisor.ClaudeRuntime
    orig_runtime_health = nth_app.nth_web.runtime_health
    nth_app.nth_supervisor.ClaudeRuntime = _UnavailableClaude
    nth_app.nth_web.runtime_health = lambda **kw: (
        {"provider": "codex", "ready": True, "version": "codex-cli 1.0"}
        if kw.get("provider") == "codex" else orig_runtime_health(**kw))
    try:
        codex_only = nth_app.doctor_report(db_path, 9123, probe_hub=False)
        check("doctor reports Codex readiness independently of Claude",
              codex_only["runtimes"]["codex"]["ready"]
              and not codex_only["runtimes"]["claude"]["ready"])
        argv_ok = codex_only["database"]["ready"] and any(
            r.get("ready") for r in codex_only["runtimes"].values())
        check("Codex-only healthy workspace is NOT reported as failing", argv_ok)
    finally:
        nth_app.nth_supervisor.ClaudeRuntime = orig_claude_runtime
        nth_app.nth_web.runtime_health = orig_runtime_health
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
