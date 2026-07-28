#!/usr/bin/env python3
"""nth_turn_hook.py — Claude Code Stop/StopFailure hook for the working indicator.

Wire this as BOTH a `Stop` and a `StopFailure` hook in settings.json. Whenever a
Claude turn ends — cleanly (Stop) or on an API error (StopFailure) — Claude Code
runs this script with the hook payload on stdin. We stamp `sessions.last_turn_end`
for the matching session so the dashboard can distinguish:
  * "working" — the agent has acted (its own tool calls bump sessions.last_seen)
    MORE recently than its last turn end -> it woke and is mid-turn.
  * "idle"    — the last thing that happened is a turn end -> done / waiting.

Design contract (same as nth_stall_hook.py):
  * This hook only UPDATEs one timestamp. Claude Code ignores a Stop/StopFailure
    hook's output/exit code, so there's nothing to return.
  * It must NEVER raise, hang, or disturb the host session. Every failure path is
    swallowed and we exit 0.

It records turn ends for BOTH Stop and StopFailure so a *stalled* turn (which
fires StopFailure, handled separately by nth_stall_hook.py for the watchdog) also
counts as "ended" here — a frozen session must not read as a false "working".

Mapping: the payload's `session_id` equals the connect-time CLAUDE_CODE_SESSION_ID
stored in sessions.fingerprint, so we update WHERE fingerprint = session_id.
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("NTH_DB_PATH", str(Path.home() / ".claude" / "nth" / "nth.db")))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> int:
    try:
        raw = sys.stdin.read(1_000_000)   # bounded — never buffer a hostile stream
    except Exception:
        return 0
    if not raw:
        return 0
    try:
        payload = json.loads(raw)
    except Exception:
        return 0
    if not isinstance(payload, dict):
        return 0

    # Only act on turn-end events. The settings.json registration scopes this to
    # Stop / StopFailure, but defend against a mis-wired hook pointing here.
    event = payload.get("hook_event_name")
    if event and event not in ("Stop", "StopFailure"):
        return 0

    session_id = (payload.get("session_id")
                  or os.environ.get("CLAUDE_CODE_SESSION_ID")
                  or os.environ.get("CLAUDE_SESSION_ID")
                  or "")
    if not session_id:
        return 0

    now = _now_iso()
    conn = None
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=5, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "UPDATE sessions SET last_turn_end = ? WHERE fingerprint = ?",
                (now, session_id[:64]),
            )
        except sqlite3.OperationalError:
            # DB predates the column (server not restarted since the feature
            # landed) — add it, then stamp, so we self-heal without a restart.
            conn.execute("ALTER TABLE sessions ADD COLUMN last_turn_end TEXT")
            conn.execute(
                "UPDATE sessions SET last_turn_end = ? WHERE fingerprint = ?",
                (now, session_id[:64]),
            )
        conn.execute("COMMIT")
    except Exception:
        return 0  # best-effort: never disturb the host session
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
