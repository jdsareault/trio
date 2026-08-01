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

import collections
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional

DB_PATH = Path.home() / ".claude" / "nth" / "nth.db"

# How many stderr lines to retain per agent for post-mortem diagnostics.
STDERR_TAIL_LINES = 200

# Valid agent lifecycle states (mirror the supervisor state machine in the
# design doc). Kept as plain strings in agents.state. ST_IDLE is set by the hub
# (idle-timer), not by this core — it's here so the enum is complete.
ST_SPAWNING = "spawning"
ST_RUNNING = "running"
ST_IDLE = "idle"
ST_SLEEPING = "sleeping"
ST_STOPPED = "stopped"
ST_ERRORED = "errored"

_warned_override = False


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def agent_binary() -> List[str]:
    """The base argv for launching an agent. Overridable via $TRIO_AGENT_CMD
    (shell-split) so tests can point at a fake stream-json agent. Defaults to
    the real headless Claude Code CLI.

    Because this swaps the launched executable, a non-empty override is logged
    once to stderr — an unexpected value in production is an arbitrary-command
    vector the operator should see."""
    global _warned_override
    raw = os.environ.get("TRIO_AGENT_CMD", "").strip()
    if raw:
        if not _warned_override:
            sys.stderr.write(
                f"[nth_supervisor] NOTE: TRIO_AGENT_CMD override active — "
                f"launching agents via: {raw!r}\n")
            _warned_override = True
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
    effort: str = "",
) -> List[str]:
    """Assemble the headless `claude -p` command for one agent.

    Streaming JSON both ways keeps the session conversational across turns and
    lets us capture the session_id (for --resume) from the init event. We drive
    the JSON stream, NOT a pseudo-terminal — no TTY scraping.

    `effort` is the reasoning/thinking level (low|medium|high|xhigh|max); more
    effort = more planning before acting, which helps weaker models drive tools.
    """
    argv = list(agent_binary())
    argv += [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", permission_mode,
    ]
    if effort:
        argv += ["--effort", effort]
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


def build_mcp_config(nth_server_path: str, python_cmd: str = "") -> str:
    """Inline JSON for `claude --mcp-config` that gives a spawned agent the Trio
    MCP tools (stdio), pointed at this repo's nth_server.py. Returned as a
    compact JSON string (claude accepts inline config or a file path).

    NOTE: enabling this makes the agent call trio_connect itself, which mints a
    NEW member_id — the identity-reclaim path (agents connect AS their agent_id)
    must land alongside wiring this in, or it reproduces bug B1 (duplicate
    member on connect). See proposals/unified-interface.md § Agent identity.
    """
    py = python_cmd or sys.executable
    return json.dumps({
        "mcpServers": {
            "nth-trio": {
                "type": "stdio",
                "command": py,
                "args": [nth_server_path],
            }
        }
    }, separators=(",", ":"))


class AgentProc:
    """A live agent OS process + its reader threads. One thread parses the
    stream-json stdout (capturing session_id from the init event, forwarding
    events); a second DRAINS stderr into a bounded ring buffer so a chatty
    agent can't deadlock on a full stderr pipe."""

    def __init__(self, agent_id: str, argv: List[str],
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                 on_session: Optional[Callable[[str, str], None]] = None):
        self.agent_id = agent_id
        self.argv = argv
        self.on_event = on_event
        self.on_session = on_session
        self.session_id: str = ""
        self._session_evt = threading.Event()
        self.proc: Optional[subprocess.Popen] = None
        self._readers: List[threading.Thread] = []
        self._stderr: Deque[str] = collections.deque(maxlen=STDERR_TAIL_LINES)

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered
        )
        self._readers = [
            threading.Thread(target=self._read_loop, daemon=True),
            threading.Thread(target=self._stderr_loop, daemon=True),
        ]
        for t in self._readers:
            t.start()

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
            if not isinstance(evt, dict):
                continue
            # Capture session_id from the init system event (first line).
            if not self.session_id:
                sid = evt.get("session_id") or evt.get("sessionId") or ""
                if sid:
                    self.session_id = sid
                    self._session_evt.set()
                    # Persist immediately — do NOT rely on the spawn() return
                    # path, which loses a late-arriving id if wait_session timed
                    # out (Sauron: else --resume is skipped and memory is lost).
                    if self.on_session is not None:
                        try:
                            self.on_session(self.agent_id, sid)
                        except Exception:
                            pass
            if self.on_event is not None:
                try:
                    self.on_event(self.agent_id, evt)
                except Exception:
                    pass

    def _stderr_loop(self) -> None:
        """Drain stderr so the OS pipe buffer can't fill and block the child.
        Kept as a bounded tail for ST_ERRORED diagnostics."""
        if self.proc is None or self.proc.stderr is None:
            return
        for line in self.proc.stderr:
            self._stderr.append(line.rstrip("\n"))

    def stderr_tail(self) -> str:
        return "\n".join(self._stderr)

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
        # Valid only while the process is alive — Popen retains a stale/recycled
        # pid after exit, so don't hand that to callers (Sauron).
        if self.proc and self.proc.poll() is None:
            return self.proc.pid
        return None

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

    Deterministic and process-local: the hub holds one of these. A per-agent
    lock serializes lifecycle ops (spawn/hibernate/wake/stop) on the SAME agent
    so a stop() can't interleave a slow spawn() and leave the DB row claiming
    'running' with a dead pid (Sauron). A short global lock guards only the
    shared dicts; blocking process I/O happens outside it.
    """

    def __init__(self, db_path: Path = DB_PATH,
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None):
        self.db_path = db_path
        self.on_event = on_event
        self._procs: Dict[str, AgentProc] = {}
        self._agent_locks: Dict[str, threading.Lock] = {}
        self._lock = threading.Lock()

    # ── db helpers ──
    def _db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _plock(self, agent_id: str) -> threading.Lock:
        with self._lock:
            lk = self._agent_locks.get(agent_id)
            if lk is None:
                lk = self._agent_locks[agent_id] = threading.Lock()
            return lk

    def _persist_session(self, agent_id: str, session_id: str) -> None:
        """Called from the reader thread the instant a session_id is captured,
        so --resume continuity survives even a slow init (Sauron crit)."""
        if not session_id:
            return
        db = self._db()
        try:
            db.execute(
                "UPDATE agents SET session_id = ?, last_active_at = ? WHERE id = ?",
                (session_id, now_iso(), agent_id))
            db.commit()
        finally:
            db.close()

    def _set_state(self, agent_id: str, state: str, *,
                   pid: Optional[int] = None, session_id: Optional[str] = None,
                   clear_pid: bool = False) -> int:
        """Update an agent's row. Returns rows affected (0 = unknown agent)."""
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
            cur = db.execute(
                f"UPDATE agents SET {', '.join(sets)} WHERE id = ?", vals)
            db.commit()
            return cur.rowcount
        finally:
            db.close()

    # ── lifecycle ──
    def spawn(self, agent_id: str, *, model: str = "", system_prompt: str = "",
              mcp_config: str = "", resume_session_id: str = "", effort: str = "",
              session_timeout: float = 10.0) -> AgentProc:
        """Launch (or resume) an agent process and sync its DB row. Serialized
        per-agent. Blocks briefly to capture the session_id from the init
        event; the reader thread also persists it directly, so a slow init
        doesn't lose --resume continuity."""
        with self._plock(agent_id):
            with self._lock:
                existing = self._procs.get(agent_id)
                if existing and existing.alive():
                    return existing
            argv = build_spawn_argv(
                model=model, system_prompt=system_prompt, mcp_config=mcp_config,
                resume_session_id=resume_session_id, effort=effort)
            proc = AgentProc(agent_id, argv, on_event=self.on_event,
                             on_session=self._persist_session)
            self._set_state(agent_id, ST_SPAWNING)
            proc.start()
            with self._lock:
                self._procs[agent_id] = proc
            sid = proc.wait_session(session_timeout)
            if not proc.alive():
                # Spawn died before/around init — drop the dead handle so the
                # registry doesn't hold a zombie entry (Sauron).
                with self._lock:
                    if self._procs.get(agent_id) is proc:
                        del self._procs[agent_id]
                self._set_state(agent_id, ST_ERRORED, clear_pid=True)
            else:
                self._set_state(agent_id, ST_RUNNING, pid=proc.pid,
                                session_id=sid or None)
            return proc

    def hibernate(self, agent_id: str) -> bool:
        """Stop the process but keep session_id → state=sleeping. Revived later
        with --resume, memory intact. Returns False if the agent was neither
        running nor a known row (no-op)."""
        with self._plock(agent_id):
            with self._lock:
                proc = self._procs.pop(agent_id, None)
            if proc:
                proc.stop()
            rows = self._set_state(agent_id, ST_SLEEPING, clear_pid=True)
            return bool(proc) or rows > 0

    def wake(self, agent_id: str, **spawn_kw) -> Optional[AgentProc]:
        """Resume a sleeping agent from its persisted session_id. If the agent
        has no session_id yet (never spawned), this is a cold first start."""
        db = self._db()
        try:
            row = db.execute(
                "SELECT session_id, model, base_prompt, effort FROM agents WHERE id = ?",
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
            effort=spawn_kw.get("effort",
                                row["effort"] if "effort" in row.keys() else ""),
            resume_session_id=row["session_id"] or "")

    def stop(self, agent_id: str) -> bool:
        """Deliberately halt an agent (state=stopped). Returns False on no-op
        (unknown agent, not running)."""
        with self._plock(agent_id):
            with self._lock:
                proc = self._procs.pop(agent_id, None)
            if proc:
                proc.stop()
            rows = self._set_state(agent_id, ST_STOPPED, clear_pid=True)
            return bool(proc) or rows > 0

    def feed(self, agent_id: str, channel: str, text: str) -> bool:
        """Route an inbound channel message into the agent, channel-tagged
        (hybrid context). The agent replies to a specific channel via its
        injected Trio MCP. Returns False if the agent isn't live (the hub is
        responsible for waking a sleeping agent first — see design doc)."""
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

    def reconcile(self) -> List[str]:
        """Reap agents whose process died out-of-band (crash/kill) without a
        lifecycle call: drop the dead handle and flip the DB row off 'running'
        so it doesn't lie. Returns the reaped agent ids. Intended to be called
        periodically by the hub (also covers Legolas' zombie note)."""
        reaped = []
        with self._lock:
            dead = [(a, p) for a, p in self._procs.items() if not p.alive()]
            for a, _ in dead:
                del self._procs[a]
        for a, _ in dead:
            self._set_state(a, ST_ERRORED, clear_pid=True)
            reaped.append(a)
        return reaped

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
