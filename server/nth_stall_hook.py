#!/usr/bin/env python3
"""nth_stall_hook.py — Claude Code StopFailure hook for the trio stall-watchdog.

Wire this as a `StopFailure` hook in settings.json. When a Claude session's
turn is terminated by an API error (overloaded / rate_limit / server_error /
...), Claude Code runs this script with the hook payload on stdin. We record
one row in the trio `stall_events` table; the watchdog (in nth_web.py) picks
it up, maps the session back to its trio member, and nudges it back to life.

Design contract:
  * This hook only ever INSERTs a row. Claude Code ignores a StopFailure
    hook's stdout/stderr/exit code, so there is nothing to "return" — all
    policy (mapping, backoff, retract, give-up) lives in the watchdog.
  * It must NEVER raise, hang, or otherwise disturb the host session. Every
    failure path is swallowed and we exit 0. A watchdog that breaks the thing
    it protects is worse than no watchdog.

Verified StopFailure payload (Claude Code 2.1.212), for reference:
  {
    "session_id": "f55aefb5-...",              # == env CLAUDE_CODE_SESSION_ID
    "transcript_path": ".../<session_id>.jsonl",
    "cwd": "/path/where/claude/ran",
    "prompt_id": "...",
    "error": "model_not_found",                # NB: field is `error`, not `error_type`
    "hook_event_name": "StopFailure",
    "last_assistant_message": "..."
  }
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("NTH_DB_PATH", str(Path.home() / ".claude" / "nth" / "nth.db")))

# Mirrors nth_server.get_db()'s stall_events DDL so a stall is never dropped
# just because the server process hasn't initialized the schema yet. (The rest
# of this codebase already mirrors DDL across nth_server / nth_web.)
_DDL = """
CREATE TABLE IF NOT EXISTS stall_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL,
    error              TEXT NOT NULL DEFAULT '',
    cwd                TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL,
    resolved_at        TEXT,
    resolution         TEXT NOT NULL DEFAULT '',
    nudge_count        INTEGER NOT NULL DEFAULT 0,
    last_nudge_at      TEXT,
    last_nudge_msg_id  INTEGER
)
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> int:
    try:
        raw = sys.stdin.read()
    except Exception:
        return 0
    if not raw:
        return 0
    try:
        payload = json.loads(raw)
    except Exception:
        return 0

    # Only act on StopFailure. The settings.json matcher should already scope
    # this, but defend against a mis-wired Stop hook pointing here.
    if payload.get("hook_event_name") and payload.get("hook_event_name") != "StopFailure":
        return 0

    # session_id is the mapping key. Fall back to the env var (same value in
    # practice) if the payload somehow lacks it.
    session_id = (payload.get("session_id")
                  or os.environ.get("CLAUDE_CODE_SESSION_ID")
                  or os.environ.get("CLAUDE_SESSION_ID")
                  or "")
    if not session_id:
        return 0  # nothing the watchdog could map — drop silently

    error = payload.get("error", "") or ""
    cwd = payload.get("cwd", "") or ""

    conn = None
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=5, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(_DDL)
        conn.execute(
            "INSERT INTO stall_events (session_id, error, cwd, created_at) "
            "VALUES (?, ?, ?, ?)",
            (session_id[:64], error[:64], cwd[:1024], _now_iso()),
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
