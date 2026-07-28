#!/usr/bin/env python3
"""nth_activity_hook.py — Claude Code PreToolUse/UserPromptSubmit hook for the
working indicator.

Wire this as BOTH a `PreToolUse` and a `UserPromptSubmit` hook in settings.json,
each MATCHER-LESS (fires for every tool / every prompt). Whenever a Claude
session does *anything* mid-turn — submits a prompt, or is about to run a tool
(Bash, Read, a sub-agent, a trio poll, ...) — Claude Code runs this script with
the hook payload on stdin and we stamp `sessions.last_seen` for the matching
session.

Why this exists
---------------
The dashboard's working/idle split is `sessions.last_seen > last_turn_end`
(see member_status in nth_web.py). Before this hook, `sessions.last_seen` was
bumped ONLY by trio MCP calls (poll/send/ack) — so an agent that was reasoning,
generating tokens, running a long `Bash`, or grinding through a sub-agent with
no trio chatter had a *stale* last_seen and read as **idle** even though it was
hard at work. The green dot only lit from the agent's first trio call in a turn
until its Stop hook fired.

This hook decouples "working" from trio-call cadence: any tool call keeps
last_seen fresh, so the dot stays green for the whole active turn. Because
PreToolUse fires at the *start* of each tool call, a long-running tool (a
multi-minute `Bash`, a sub-agent) keeps the session green for its full
duration. The turn's Stop hook (nth_turn_hook.py) stamps `last_turn_end`
*after* the last tool call, so the dot correctly flips to idle exactly when the
turn ends.

Interaction with the stall watchdog
-----------------------------------
The watchdog's `_resumed()` (nth_web.py) already keys revival on
`MAX(sessions.last_seen) WHERE fingerprint = session_id` and documents the
intent that "last_seen is bumped by that session's own tool calls". This hook
makes that literally true — improving revival responsiveness (a resumed session
is detected on its first tool call, not only its first trio call). A genuinely
stalled turn runs no tools, so this hook cannot mask a real stall.

Design contract (same as nth_turn_hook.py / nth_stall_hook.py):
  * PreToolUse fires *constantly*, so this must be dead-cheap: one UPDATE, no
    reads, no allocation beyond the payload parse.
  * Claude Code ignores a PreToolUse hook's stdout for scheduling as long as we
    exit 0 without emitting a decision, so there's nothing to return.
  * It must NEVER raise, hang, or disturb the host session. Every failure path
    is swallowed and we exit 0.

Mapping: the payload's `session_id` equals the connect-time
CLAUDE_CODE_SESSION_ID stored in sessions.fingerprint, so we update
WHERE fingerprint = session_id.
"""
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get("NTH_DB_PATH", str(Path.home() / ".claude" / "nth" / "nth.db")))

# This hook runs on EVERY tool call (PreToolUse), and Claude Code blocks the tool
# until the hook exits — so it sits on the critical path of every Bash/Read/etc.
# Under N concurrent agents contending on the shared nth.db write lock, a long
# busy timeout would add that much latency to every tool call. A missed last_seen
# stamp is harmless (the next tool call re-stamps), so we fail FAST instead: give
# up the write after a fraction of a second rather than stalling the host's tool.
# (The turn/stall hooks fire only once or twice per turn, so their 5s is fine.)
BUSY_TIMEOUT_MS = 500


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

    # Only act on activity events. The settings.json registration scopes this to
    # PreToolUse / UserPromptSubmit, but defend against a mis-wired hook. A truly
    # absent field (None) is tolerated — some Claude Code versions omit it and the
    # registration already scopes which events reach us — but any *present* value
    # that isn't ours (including "" or "Stop") is rejected.
    event = payload.get("hook_event_name")
    if event not in (None, "PreToolUse", "UserPromptSubmit"):
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
        conn = sqlite3.connect(str(DB_PATH), timeout=BUSY_TIMEOUT_MS / 1000,
                               isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE sessions SET last_seen = ? WHERE fingerprint = ?",
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
