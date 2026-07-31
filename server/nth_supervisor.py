#!/usr/bin/env python3
"""nth_supervisor — the deterministic agent process supervisor.

Part of the unified-interface build (see proposals/unified-interface.md). This
is PLAIN SOFTWARE, not an agent: no LLM, no tokens in its control loop. It owns
the OS handles of headless `claude -p` agent sessions so the hub can spawn,
stop, hibernate, resume, and place them authoritatively — the thing today's
architecture can't do (the server can't see or kill a member's OS process,
the root of bugs B1/B2).

Design points realised here:
  * Agents are headless `claude -p` in stream-json mode on the user's Claude
    Code SUBSCRIPTION (not the Agent SDK — that needs a per-token API key).
  * The agent binary is configurable via $TRIO_AGENT_CMD so this module is
    testable against a fake stream-json agent WITHOUT spawning real, billed
    Claude sessions. In production it defaults to `claude`.
  * Durable identity lives in the `agents` table (nth_server schema); the
    supervisor keeps the DB row's state/pid/session_id in sync with the OS
    process. A hibernated agent keeps its session_id and is revived with
    `--resume`, memory intact.

This module intentionally does NOT wire the HTTP endpoints or channel message
routing yet — those land in follow-up increments on nth_web. It provides the
process-lifecycle core + DB state machine, unit-tested in isolation.
"""
from __future__ import annotations

import json
import os
import shlex
import sqlite3
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

DB_PATH = Path.home() / ".claude" / "nth" / "nth.db"

# Valid agent lifecycle states (mirror the supervisor state machine in the
# design doc). Kept as plain strings in agents.state.
ST_SPAWNING = "spawning"
ST_RUNNING = "running"
ST_IDLE = "idle"
ST_SLEEPING = "sleeping"
ST_STOPPED = "stopped"
ST_ERRORED = "errored"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def agent_binary() -> List[str]:
    """The base argv for launching an agent. Overridable via $TRIO_AGENT_CMD
    (shell-split) so tests can point at a fake stream-json agent. Defaults to
    the real headless Claude Code CLI."""
    raw = os.environ.get("TRIO_AGENT_CMD", "").strip()
    if raw:
        return shlex.split(raw)
    return ["claude"]


def build_spawn_argv(
    *,
    model: str = "",
    system_prompt: str = "",
    mcp_config: str = "",
    resume_session_id: str = "",
    permission_mode: str = "acceptEdits",
    disallowed_tools: str = "AskUserQuestion",
) -> List[str]:
    """Assemble the headless `claude -p` command for one agent.

    Streaming JSON both ways keeps the session conversational across turns and
    lets us capture the session_id (for --resume) from the init event. We drive
    the JSON stream, NOT a pseudo-terminal — no TTY scraping.
    """
    argv = list(agent_binary())
    argv += [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", permission_mode,
    ]
    if disallowed_tools:
        argv += ["--disallowedTools", disallowed_tools]
    if model:
        argv += ["--model", model]
    if system_prompt:
        argv += ["--append-system-prompt", system_prompt]
    if mcp_config:
        argv += ["--mcp-config", mcp_config]
    if resume_session_id:
        argv += ["--resume", resume_session_id]
    return argv


class AgentProc:
    """A live agent OS process + its stdout reader thread. The reader parses
    the stream-json output, captures the session_id from the init event, and
    forwards assistant/result events to an optional callback."""

    def __init__(self, agent_id: str, argv: List[str],
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None):
        self.agent_id = agent_id
        self.argv = argv
        self.on_event = on_event
        self.session_id: str = ""
        self._session_evt = threading.Event()
        self.proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Capture session_id from the init system event (first line).
            if not self.session_id:
                sid = evt.get("session_id") or evt.get("sessionId") or ""
                if sid:
                    self.session_id = sid
                    self._session_evt.set()
            if self.on_event is not None:
                try:
                    self.on_event(self.agent_id, evt)
                except Exception:
                    pass

    def wait_session(self, timeout: float = 10.0) -> str:
        """Block until the init event yields a session_id (or timeout)."""
        self._session_evt.wait(timeout)
        return self.session_id

    def send_user(self, text: str) -> bool:
        """Feed a user message into the agent's stream-json stdin."""
        if not self.proc or not self.proc.stdin or self.proc.poll() is not None:
            return False
        msg = {"type": "user",
               "message": {"role": "user", "content": text}}
        try:
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError):
            return False

    @property
    def pid(self) -> Optional[int]:
        return self.proc.pid if self.proc else None

    def alive(self) -> bool:
        return bool(self.proc and self.proc.poll() is None)

    def stop(self, grace: float = 3.0) -> None:
        if not self.proc:
            return
        try:
            if self.proc.stdin:
                try:
                    self.proc.stdin.close()
                except OSError:
                    pass
            self.proc.terminate()
            try:
                self.proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=grace)
        except Exception:
            pass


class AgentSupervisor:
    """Owns all live AgentProc handles and keeps the `agents` DB row in sync.

    Deterministic and process-local: the hub holds one of these. Methods are
    thread-safe under a single lock; process I/O happens off-lock.
    """

    def __init__(self, db_path: Path = DB_PATH,
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None):
        self.db_path = db_path
        self.on_event = on_event
        self._procs: Dict[str, AgentProc] = {}
        self._lock = threading.Lock()

    # ── db helpers ──
    def _db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _set_state(self, agent_id: str, state: str, *,
                   pid: Optional[int] = None, session_id: Optional[str] = None,
                   clear_pid: bool = False) -> None:
        db = self._db()
        try:
            sets = ["state = ?", "last_active_at = ?"]
            vals: List[Any] = [state, now_iso()]
            if clear_pid:
                sets.append("pid = NULL")
            elif pid is not None:
                sets.append("pid = ?")
                vals.append(pid)
            if session_id:
                sets.append("session_id = ?")
                vals.append(session_id)
            vals.append(agent_id)
            db.execute(f"UPDATE agents SET {', '.join(sets)} WHERE id = ?", vals)
            db.commit()
        finally:
            db.close()

    # ── lifecycle ──
    def spawn(self, agent_id: str, *, model: str = "", system_prompt: str = "",
              mcp_config: str = "", resume_session_id: str = "",
              session_timeout: float = 10.0) -> AgentProc:
        """Launch (or resume) an agent process and sync its DB row. Blocks
        briefly to capture the session_id from the init event."""
        argv = build_spawn_argv(
            model=model, system_prompt=system_prompt, mcp_config=mcp_config,
            resume_session_id=resume_session_id)
        proc = AgentProc(agent_id, argv, on_event=self.on_event)
        with self._lock:
            existing = self._procs.get(agent_id)
            if existing and existing.alive():
                return existing
            self._set_state(agent_id, ST_SPAWNING)
            proc.start()
            self._procs[agent_id] = proc
        sid = proc.wait_session(session_timeout)
        if not proc.alive():
            self._set_state(agent_id, ST_ERRORED, clear_pid=True)
        else:
            self._set_state(agent_id, ST_RUNNING, pid=proc.pid,
                            session_id=sid or None)
        return proc

    def hibernate(self, agent_id: str) -> bool:
        """Stop the process but keep session_id → state=sleeping. The agent is
        revived later with --resume, memory intact (aggressive-hibernation)."""
        with self._lock:
            proc = self._procs.pop(agent_id, None)
        if proc:
            proc.stop()
        self._set_state(agent_id, ST_SLEEPING, clear_pid=True)
        return True

    def wake(self, agent_id: str, **spawn_kw) -> Optional[AgentProc]:
        """Resume a sleeping agent from its persisted session_id."""
        db = self._db()
        try:
            row = db.execute(
                "SELECT session_id, model, base_prompt FROM agents WHERE id = ?",
                (agent_id,)).fetchone()
        finally:
            db.close()
        if row is None:
            return None
        return self.spawn(
            agent_id,
            model=spawn_kw.get("model", row["model"] or ""),
            system_prompt=spawn_kw.get("system_prompt", row["base_prompt"] or ""),
            mcp_config=spawn_kw.get("mcp_config", ""),
            resume_session_id=row["session_id"] or "")

    def stop(self, agent_id: str) -> bool:
        """Deliberately halt an agent (state=stopped)."""
        with self._lock:
            proc = self._procs.pop(agent_id, None)
        if proc:
            proc.stop()
        self._set_state(agent_id, ST_STOPPED, clear_pid=True)
        return True

    def feed(self, agent_id: str, channel: str, text: str) -> bool:
        """Route an inbound channel message into the agent, channel-tagged
        (hybrid context). The agent replies to a specific channel via its
        injected Trio MCP."""
        with self._lock:
            proc = self._procs.get(agent_id)
        if not proc:
            return False
        return proc.send_user(f"[#{channel}] {text}")

    def is_running(self, agent_id: str) -> bool:
        with self._lock:
            proc = self._procs.get(agent_id)
        return bool(proc and proc.alive())

    def live_ids(self) -> List[str]:
        with self._lock:
            return [a for a, p in self._procs.items() if p.alive()]

    def shutdown(self) -> None:
        """Stop every live agent (process shutdown). Marks rows stopped so a
        later daemon start can decide whether to auto-resume."""
        with self._lock:
            items = list(self._procs.items())
            self._procs.clear()
        for agent_id, proc in items:
            proc.stop()
            self._set_state(agent_id, ST_STOPPED, clear_pid=True)


if __name__ == "__main__":
    # Minimal manual smoke: `TRIO_AGENT_CMD='python3 tests/fake_agent.py' \
    #   python3 server/nth_supervisor.py` — but real use is via the hub.
    print("nth_supervisor is a library; import AgentSupervisor. "
          f"agent binary = {agent_binary()}")
