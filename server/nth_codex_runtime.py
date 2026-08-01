#!/usr/bin/env python3
"""Codex App Server transport and managed-runtime primitives for Trio.

The Codex rich-client surface is a long-lived JSON-RPC process.  This module
keeps that provider protocol isolated from nth_web and the Claude stream-json
adapter.  Phase 5 builds the managed-agent lifecycle on this client.
"""
from __future__ import annotations

import collections
import json
import os
import queue
import shlex
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional

from nth_constants import AGENT_INBOX_CHANNEL


STDERR_TAIL_LINES = 200
DEFAULT_TIMEOUT = 10.0


def _toml_string(value: str) -> str:
    """JSON strings are valid TOML basic strings for the paths used here."""
    return json.dumps(value)


def build_app_server_argv(nth_server_path: str = "",
                          python_cmd: str = "") -> List[str]:
    """Build a local stdio App Server command with Trio MCP made required.

    ``TRIO_CODEX_CMD`` is a full command override used by deterministic tests.
    Production uses CLI config overrides so managed agents never depend on a
    user's global nth-trio registration.
    """
    override = os.environ.get("TRIO_CODEX_CMD", "").strip()
    if override:
        return shlex.split(override)
    argv = ["codex", "app-server"]
    if nth_server_path:
        py = python_cmd or sys.executable
        tool_names = ["trio_" + name for name in (
            "connect", "send", "dm", "poll", "ack", "pounds", "ask",
            "claim", "complete", "cancel", "release", "lock", "unlock",
            "set_status", "rename", "status", "roster", "history", "end",
            "list", "cull", "cleanup", "retract",
        )]
        argv += [
            "-c", f"mcp_servers.nth-trio.command={_toml_string(py)}",
            "-c", "mcp_servers.nth-trio.args=" + json.dumps([nth_server_path]),
            "-c", "mcp_servers.nth-trio.required=true",
            "-c", "mcp_servers.nth-trio.enabled_tools=" + json.dumps(tool_names),
            "-c", 'mcp_servers.nth-trio.default_tools_approval_mode="auto"',
        ]
    return argv


@dataclass
class _Pending:
    event: threading.Event
    response: Optional[Dict[str, Any]] = None


class CodexProtocolError(RuntimeError):
    pass


class CodexAppServerClient:
    """Thread-safe stdio JSON-RPC client for one Codex App Server process."""

    def __init__(self, command: Optional[List[str]] = None, *,
                 nth_server_path: str = "", python_cmd: str = "",
                 on_notification: Optional[Callable[[Dict[str, Any]], None]] = None,
                 on_server_request: Optional[Callable[[Dict[str, Any]], Any]] = None):
        self.command = list(command or build_app_server_argv(
            nth_server_path, python_cmd=python_cmd))
        self.on_notification = on_notification
        self.on_server_request = on_server_request
        self.proc: Optional[subprocess.Popen] = None
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending: Dict[int, _Pending] = {}
        self._next_id = 1
        self._reader: Optional[threading.Thread] = None
        self._stderr_reader: Optional[threading.Thread] = None
        self._stderr: Deque[str] = collections.deque(maxlen=STDERR_TAIL_LINES)
        self._closed = threading.Event()
        self.initialize_result: Dict[str, Any] = {}
        # Bounds concurrent App Server -> client requests (approval/user-input
        # prompts); the reader thread must never block on these, but a buggy
        # or rapid-fire App Server must not be able to spawn unbounded threads.
        self._request_executor = ThreadPoolExecutor(
            max_workers=8, thread_name_prefix="codex-req")
        self._request_executor_closed = False

    def start(self, timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
        if self.alive():
            return dict(self.initialize_result)
        self._closed.clear()
        if self._request_executor_closed:
            self._request_executor = ThreadPoolExecutor(
                max_workers=8, thread_name_prefix="codex-req")
            self._request_executor_closed = False
        self.proc = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._stderr_reader = threading.Thread(target=self._stderr_loop, daemon=True)
        self._reader.start()
        self._stderr_reader.start()
        try:
            result = self.request("initialize", {
                "clientInfo": {
                    "name": "trio",
                    "title": "Trio managed agent workspace",
                    "version": "0.1.0",
                }
            }, timeout=timeout)
            self.notify("initialized", {})
        except Exception:
            self.stop()
            raise
        self.initialize_result = result
        return dict(result)

    def alive(self) -> bool:
        return bool(self.proc and self.proc.poll() is None and not self._closed.is_set())

    @property
    def pid(self) -> Optional[int]:
        return self.proc.pid if self.alive() and self.proc is not None else None

    def stderr_tail(self) -> str:
        return "\n".join(self._stderr)

    def request(self, method: str, params: Optional[Dict[str, Any]] = None,
                timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
        if not self.alive():
            raise CodexProtocolError("Codex App Server is not running")
        with self._pending_lock:
            request_id = self._next_id
            self._next_id += 1
            pending = _Pending(threading.Event())
            self._pending[request_id] = pending
        try:
            self._send({"method": method, "id": request_id,
                        "params": params or {}})
            if not pending.event.wait(timeout):
                raise CodexProtocolError(f"Codex App Server timed out: {method}")
            response = pending.response or {}
            if response.get("error") is not None:
                error = response.get("error") or {}
                message = error.get("message") if isinstance(error, dict) else str(error)
                raise CodexProtocolError(f"{method}: {message or 'request failed'}")
            result = response.get("result")
            return result if isinstance(result, dict) else {"value": result}
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        if not self.alive():
            raise CodexProtocolError("Codex App Server is not running")
        self._send({"method": method, "params": params or {}})

    def _send(self, message: Dict[str, Any]) -> None:
        proc = self.proc
        if proc is None or proc.stdin is None or proc.poll() is not None:
            raise CodexProtocolError("Codex App Server stdin is unavailable")
        encoded = json.dumps(message, separators=(",", ":")) + "\n"
        try:
            with self._write_lock:
                proc.stdin.write(encoded)
                proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise CodexProtocolError(f"Codex App Server write failed: {exc}") from exc

    def _read_loop(self) -> None:
        proc = self.proc
        if proc is None or proc.stdout is None:
            return
        try:
            for raw in proc.stdout:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    self._stderr.append(f"non-JSON stdout: {raw[:500]}")
                    continue
                if not isinstance(message, dict):
                    self._stderr.append(f"non-object stdout: {raw[:500]}")
                    continue
                if "id" in message and "method" not in message:
                    try:
                        response_id = int(message["id"])
                    except (TypeError, ValueError):
                        continue
                    with self._pending_lock:
                        pending = self._pending.get(response_id)
                    if pending is not None:
                        pending.response = message
                        pending.event.set()
                    continue
                if "id" in message and "method" in message:
                    # Approval/user-input handlers may wait on a UI decision.
                    # Never block the one reader responsible for correlating
                    # every other App Server response and notification.
                    self._request_executor.submit(self._handle_server_request, message)
                    continue
                callback = self.on_notification
                if callback is not None and message.get("method"):
                    try:
                        callback(message)
                    except Exception as exc:
                        self._stderr.append(f"notification callback failed: {exc}")
        finally:
            self._closed.set()
            self._fail_pending("Codex App Server closed its output")

    def _handle_server_request(self, message: Dict[str, Any]) -> None:
        request_id = message.get("id")
        try:
            if self.on_server_request is None:
                raise CodexProtocolError(
                    f"unsupported server request: {message.get('method')}")
            result = self.on_server_request(message)
            self._send({"id": request_id, "result": result})
        except Exception as exc:
            try:
                self._send({"id": request_id, "error": {
                    "code": -32601, "message": str(exc)}})
            except CodexProtocolError:
                pass

    def _stderr_loop(self) -> None:
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        for line in proc.stderr:
            self._stderr.append(line.rstrip("\n"))

    def _fail_pending(self, message: str) -> None:
        with self._pending_lock:
            pending = list(self._pending.values())
        for item in pending:
            item.response = {"error": {"message": message}}
            item.event.set()

    def stop(self, grace: float = 3.0) -> None:
        proc = self.proc
        self._closed.set()
        if proc is not None:
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
            except OSError:
                pass
            if proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=grace)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=grace)
                except OSError:
                    pass
        self._fail_pending("Codex App Server stopped")
        self._request_executor.shutdown(wait=False)
        self._request_executor_closed = True


def codex_cli_diagnostics(timeout: float = 5.0) -> Dict[str, Any]:
    """Cheap readiness probe that never starts a model turn."""
    override = os.environ.get("TRIO_CODEX_CMD", "").strip()
    if override:
        command = shlex.split(override)
        executable = shutil.which(command[0]) if command else None
        return {
            "provider": "codex", "command": command,
            "executable": executable or "", "available": bool(executable),
            "authenticated": None, "version": "", "ready": bool(executable),
            "detail": ("custom Codex App Server command configured" if executable
                       else "custom Codex App Server command was not found"),
            "override": True,
        }
    executable = shutil.which("codex")
    result: Dict[str, Any] = {
        "provider": "codex", "command": ["codex"],
        "executable": executable or "", "available": bool(executable),
        "authenticated": None, "version": "", "ready": False, "detail": "",
        "override": False,
    }
    if not executable:
        result["detail"] = "Codex CLI was not found on PATH"
        return result
    try:
        version = subprocess.run(
            [executable, "--version"], check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        result["version"] = (version.stdout or version.stderr).strip()
        auth = subprocess.run(
            [executable, "login", "status"], check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        auth_text = (auth.stdout or auth.stderr).strip()
        result["authenticated"] = auth.returncode == 0 and "logged in" in auth_text.lower()
        result["ready"] = bool(version.returncode == 0 and result["authenticated"])
        result["detail"] = "ready" if result["ready"] else (
            "Codex is not authenticated; run `codex login`")
    except (OSError, subprocess.TimeoutExpired) as exc:
        result["detail"] = f"Codex health check failed: {exc}"
    return result


class CodexAgentHandle:
    """Compatibility handle returned by CodexRuntimeManager.spawn/wake."""

    def __init__(self, manager: "CodexRuntimeManager", agent_id: str,
                 thread_id: str):
        self.manager = manager
        self.agent_id = agent_id
        self.thread_id = thread_id
        self.session_id = thread_id

    def alive(self) -> bool:
        return self.manager.is_running(self.agent_id)

    @property
    def pid(self) -> Optional[int]:
        # Codex agents share the provider process; per-agent pid is intentionally
        # undefined so callers do not mistake one service pid for N processes.
        return None


class CodexRuntimeManager:
    """One shared App Server process, one persistent Codex thread per agent."""

    name = "codex"

    def __init__(self, db_path: Path, *, nth_server_path: str = "",
                 command: Optional[List[str]] = None,
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None):
        self.db_path = Path(db_path)
        self.nth_server_path = nth_server_path
        self.on_event = on_event
        self._lock = threading.RLock()
        self._agent_locks: Dict[str, threading.RLock] = {}
        self._threads: Dict[str, str] = {}
        self._thread_agents: Dict[str, str] = {}
        self._loaded: set = set()
        self._active: Dict[str, str] = {}
        self._starting: Dict[str, Dict[str, Any]] = {}
        self._turn_context: Dict[str, Dict[str, Any]] = {}
        self._turn_text: Dict[str, str] = {}
        self._queued: Dict[str, Deque[Dict[str, Any]]] = {}
        self._activity: Dict[str, Deque[Dict[str, Any]]] = {}
        self._approvals: Dict[str, Dict[str, Any]] = {}
        self._approval_events: Dict[str, threading.Event] = {}
        self._approval_seq = 0
        self._actions: "queue.Queue" = queue.Queue()
        self._worker_stop = threading.Event()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker_started = False
        self._ready_detail: Dict[str, Any] = {}
        self._client = CodexAppServerClient(
            command=command,
            nth_server_path=nth_server_path,
            on_notification=self._on_notification,
            on_server_request=self._on_server_request,
        )

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(str(self.db_path), timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        return db

    def _agent_lock(self, agent_id: str) -> threading.RLock:
        with self._lock:
            return self._agent_locks.setdefault(agent_id, threading.RLock())

    def ensure_started(self) -> None:
        if not self._worker_started:
            self._worker.start()
            self._worker_started = True
        if self._client.alive():
            return
        self._client.start()
        account = self._client.request("account/read", {"refreshToken": False})
        if account.get("requiresOpenaiAuth") and not account.get("account"):
            self._client.stop()
            raise CodexProtocolError("Codex App Server is not authenticated")
        mcp = self._client.request("mcpServerStatus/list", {
            "limit": 50, "detail": "toolsAndAuthOnly"})
        trio = next((row for row in mcp.get("data", [])
                     if row.get("name") == "nth-trio"), None)
        required = {"trio_" + name for name in (
            "connect", "send", "dm", "poll", "ack", "pounds", "ask",
            "claim", "complete", "cancel", "release", "lock", "unlock",
            "set_status", "rename", "status", "roster", "history", "end",
            "list", "cull", "cleanup", "retract")}
        tools = set((trio or {}).get("tools", {}).keys())
        missing = sorted(required - tools)
        if trio is None or missing:
            self._client.stop()
            detail = "nth-trio MCP did not initialize" if trio is None else (
                "nth-trio is missing tools: " + ", ".join(missing))
            raise CodexProtocolError(detail)
        self._ready_detail = {
            "app_server": True,
            "app_server_pid": self._client.pid,
            "trio_mcp": True,
            "tool_count": len(tools),
        }

    def diagnostics(self, deep: bool = False) -> Dict[str, Any]:
        result = codex_cli_diagnostics()
        if not result.get("ready") or not deep:
            result.update(self._ready_detail)
            return result
        try:
            self.ensure_started()
            result.update(self._ready_detail)
        except Exception as exc:
            result.update(ready=False, detail=str(exc), app_server=False,
                          trio_mcp=False)
        return result

    def list_models(self) -> List[Dict[str, Any]]:
        self.ensure_started()
        payload = self._client.request("model/list", {
            "limit": 100, "includeHidden": False})
        models = []
        for row in payload.get("data", []):
            if row.get("hidden"):
                continue
            efforts = [e.get("reasoningEffort")
                       for e in row.get("supportedReasoningEfforts", [])
                       if e.get("reasoningEffort")]
            models.append({
                "id": row.get("id") or row.get("model"),
                "name": row.get("displayName") or row.get("model") or row.get("id"),
                "description": row.get("description") or "",
                "efforts": efforts,
                "default_effort": row.get("defaultReasoningEffort") or "",
                "default": bool(row.get("isDefault")),
                "input_modalities": row.get("inputModalities") or [],
            })
        return models

    def spawn(self, agent_id: str, *, model: str = "", system_prompt: str = "",
              effort: str = "", cwd: str = "", permission_profile: str = "balanced",
              **_ignored) -> CodexAgentHandle:
        with self._agent_lock(agent_id):
            self.ensure_started()
            with self._lock:
                existing = self._threads.get(agent_id)
                if existing and agent_id in self._loaded:
                    return CodexAgentHandle(self, agent_id, existing)
            params: Dict[str, Any] = {
                "serviceName": "trio",
                "developerInstructions": system_prompt or None,
                "approvalPolicy": "never" if permission_profile == "autonomous" else "on-request",
                "approvalsReviewer": "auto_review" if permission_profile == "balanced" else "user",
                "sandbox": "read-only" if permission_profile == "observe" else "workspace-write",
            }
            if model:
                params["model"] = model
            if cwd:
                params["cwd"] = cwd
            response = self._client.request("thread/start", params)
            thread = response.get("thread") or {}
            thread_id = str(thread.get("id") or "")
            if not thread_id:
                raise CodexProtocolError("thread/start returned no thread id")
            with self._lock:
                self._threads[agent_id] = thread_id
                self._thread_agents[thread_id] = agent_id
                self._loaded.add(agent_id)
            self._set_state(agent_id, "running", runtime_ref=thread_id)
            return CodexAgentHandle(self, agent_id, thread_id)

    def wake(self, agent_id: str, **spawn_kw) -> Optional[CodexAgentHandle]:
        with self._agent_lock(agent_id):
            db = self._db()
            try:
                row = db.execute(
                    "SELECT model, effort, runtime_ref, session_id, cwd, permission_profile "
                    "FROM agents WHERE id=?", (agent_id,)).fetchone()
            finally:
                db.close()
            if row is None:
                return None
            thread_id = (row["runtime_ref"] or row["session_id"] or "")
            if not thread_id:
                return self.spawn(
                    agent_id,
                    model=spawn_kw.get("model", row["model"] or ""),
                    effort=spawn_kw.get("effort", row["effort"] or ""),
                    cwd=spawn_kw.get("cwd", row["cwd"] or ""),
                    permission_profile=spawn_kw.get(
                        "permission_profile", row["permission_profile"] or "balanced"),
                    system_prompt=spawn_kw.get("system_prompt", ""))
            self.ensure_started()
            self._client.request("thread/resume", {"threadId": thread_id})
            with self._lock:
                self._threads[agent_id] = thread_id
                self._thread_agents[thread_id] = agent_id
                self._loaded.add(agent_id)
            self._set_state(agent_id, "idle", runtime_ref=thread_id)
            return CodexAgentHandle(self, agent_id, thread_id)

    def feed(self, agent_id: str, channel: str, text: str,
             attachments: Optional[List[str]] = None,
             source_message_id: int = 0, source_sender: str = "") -> bool:
        context = self._message_context(agent_id, channel, text, attachments or [],
                                        source_message_id, source_sender)
        with self._agent_lock(agent_id):
            if not self.is_running(agent_id):
                if self.wake(agent_id) is None:
                    return False
            with self._lock:
                if agent_id in self._active or agent_id in self._starting:
                    self._queued.setdefault(agent_id, collections.deque()).append(context)
                    return True
            return self._start_turn(agent_id, context)

    def _message_context(self, agent_id: str, channel: str, text: str,
                         attachments: List[str], source_message_id: int = 0,
                         source_sender: str = "") -> Dict[str, Any]:
        baseline = 0
        try:
            db = self._db()
            try:
                baseline = db.execute(
                    "SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0]
            finally:
                db.close()
        except sqlite3.Error:
            pass
        return {"agent_id": agent_id, "channel": channel, "text": text,
                "attachments": list(attachments), "baseline": baseline,
                "source_message_id": source_message_id, "source_sender": source_sender}

    def _start_turn(self, agent_id: str, context: Dict[str, Any]) -> bool:
        # A queued message may wait behind an earlier turn. Establish duplicate-
        # suppression at execution time so that earlier replies are not mistaken
        # for output posted by this turn through Trio MCP.
        db = self._db()
        try:
            context["baseline"] = db.execute(
                "SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0]
            row = db.execute(
                "SELECT effort FROM agents WHERE id=?", (agent_id,)).fetchone()
        finally:
            db.close()
        with self._lock:
            thread_id = self._threads.get(agent_id)
            self._starting[agent_id] = context
        if not thread_id:
            with self._lock:
                self._starting.pop(agent_id, None)
            return False
        params: Dict[str, Any] = {
            "threadId": thread_id,
            "input": ([{"type": "text", "text":
                       f"[#{context['channel']}] {context['text']}"}] +
                      [{"type": "localImage", "path": path}
                       for path in context.get("attachments", [])]),
        }
        if row is not None and row["effort"]:
            params["effort"] = row["effort"]
        try:
            response = self._client.request("turn/start", params)
        except Exception:
            with self._lock:
                self._starting.pop(agent_id, None)
            self._set_state(agent_id, "errored")
            return False
        turn = response.get("turn") or {}
        turn_id = str(turn.get("id") or "")
        # Some implementations can return before the turn/started notification;
        # establish the mapping here only if the notification did not already do
        # so (or complete the turn) on the reader thread.
        with self._lock:
            pending = self._starting.pop(agent_id, None)
            if pending is not None and turn_id:
                self._active[agent_id] = turn_id
                self._turn_context[turn_id] = pending
        self._set_state(agent_id, "running")
        return bool(turn_id)

    def compact(self, agent_id: str) -> bool:
        if not self.is_running(agent_id) and self.wake(agent_id) is None:
            return False
        with self._lock:
            thread_id = self._threads.get(agent_id)
        if not thread_id:
            return False
        self._client.request("thread/compact/start", {"threadId": thread_id})
        self._set_state(agent_id, "running")
        return True

    def interrupt(self, agent_id: str) -> bool:
        with self._lock:
            thread_id = self._threads.get(agent_id)
            turn_id = self._active.get(agent_id)
        if not thread_id or not turn_id or not self._client.alive():
            return False
        self._client.request("turn/interrupt", {
            "threadId": thread_id, "turnId": turn_id})
        with self._lock:
            self._active.pop(agent_id, None)
            self._starting.pop(agent_id, None)
        self._set_state(agent_id, "idle")
        return True

    def hibernate(self, agent_id: str) -> bool:
        return self._unload(agent_id, "sleeping")

    def stop(self, agent_id: str) -> bool:
        return self._unload(agent_id, "stopped")

    def _unload(self, agent_id: str, state: str) -> bool:
        with self._agent_lock(agent_id):
            self._cancel_approvals(agent_id)
            with self._lock:
                thread_id = self._threads.get(agent_id)
                turn_id = self._active.get(agent_id)
            if not thread_id:
                db = self._db()
                try:
                    exists = db.execute("SELECT 1 FROM agents WHERE id=?", (agent_id,)).fetchone()
                finally:
                    db.close()
                if not exists:
                    return False
            if turn_id and self._client.alive():
                try:
                    self._client.request("turn/interrupt", {
                        "threadId": thread_id, "turnId": turn_id})
                except CodexProtocolError:
                    pass
            if thread_id and self._client.alive():
                try:
                    self._client.request("thread/unsubscribe", {"threadId": thread_id})
                except CodexProtocolError:
                    pass
            with self._lock:
                self._loaded.discard(agent_id)
                self._active.pop(agent_id, None)
                self._starting.pop(agent_id, None)
                self._queued.pop(agent_id, None)
            self._set_state(agent_id, state)
            return True

    def clear(self, agent_id: str, **spawn_kw) -> Optional[CodexAgentHandle]:
        with self._agent_lock(agent_id):
            db = self._db()
            try:
                row = db.execute(
                    "SELECT model, effort, cwd, permission_profile FROM agents WHERE id=?",
                    (agent_id,)).fetchone()
            finally:
                db.close()
            if row is None:
                return None
            with self._lock:
                old_thread = self._threads.get(agent_id)
            if old_thread and self._client.alive():
                try:
                    self._client.request("thread/archive", {"threadId": old_thread})
                except CodexProtocolError:
                    pass
            with self._lock:
                self._loaded.discard(agent_id)
                self._threads.pop(agent_id, None)
                if old_thread:
                    self._thread_agents.pop(old_thread, None)
            self._set_state(agent_id, "stopped", clear_runtime_ref=True)
            return self.spawn(
                agent_id,
                model=spawn_kw.get("model", row["model"] or ""),
                effort=spawn_kw.get("effort", row["effort"] or ""),
                cwd=spawn_kw.get("cwd", row["cwd"] or ""),
                permission_profile=spawn_kw.get(
                    "permission_profile", row["permission_profile"] or "balanced"),
                system_prompt=spawn_kw.get("system_prompt", ""))

    def delete(self, agent_id: str) -> bool:
        with self._agent_lock(agent_id):
            self._cancel_approvals(agent_id)
            with self._lock:
                thread_id = self._threads.get(agent_id)
            if not thread_id:
                db = self._db()
                try:
                    row = db.execute(
                        "SELECT runtime_ref, session_id FROM agents WHERE id=?",
                        (agent_id,)).fetchone()
                finally:
                    db.close()
                if row is None:
                    return False
                thread_id = row["runtime_ref"] or row["session_id"]
            if thread_id:
                self.ensure_started()
                try:
                    self._client.request("thread/delete", {"threadId": thread_id})
                except CodexProtocolError:
                    return False
            with self._lock:
                self._loaded.discard(agent_id)
                self._threads.pop(agent_id, None)
                if thread_id:
                    self._thread_agents.pop(thread_id, None)
                self._active.pop(agent_id, None)
                self._queued.pop(agent_id, None)
            return True

    def is_running(self, agent_id: str) -> bool:
        with self._lock:
            return self._client.alive() and agent_id in self._loaded

    def live_ids(self) -> List[str]:
        with self._lock:
            return sorted(self._loaded) if self._client.alive() else []

    def queued_count(self, agent_id: str) -> int:
        with self._lock:
            return len(self._queued.get(agent_id, ()))

    def is_busy(self, agent_id: str) -> bool:
        with self._lock:
            return agent_id in self._active or agent_id in self._starting

    def activity(self, agent_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            rows = list(self._activity.get(agent_id, ()))
        return rows[-max(1, min(limit, 200)):]

    def pending_approvals(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self._approvals.values()
                    if row.get("status") == "pending"]

    def resolve_approval(self, approval_id: str, decision: str) -> bool:
        if decision not in ("accept", "acceptForSession", "decline", "cancel"):
            return False
        with self._lock:
            row = self._approvals.get(approval_id)
            event = self._approval_events.get(approval_id)
            if row is None or event is None or row.get("status") != "pending":
                return False
            row["decision"] = decision
            row["status"] = "resolved"
            row["resolved_at"] = time.strftime(
                "%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
            event.set()
        return True

    def _cancel_approvals(self, agent_id: str) -> None:
        with self._lock:
            for approval_id, row in self._approvals.items():
                if row.get("agent_id") != agent_id or row.get("status") != "pending":
                    continue
                row["decision"] = "cancel"
                row["status"] = "cancelled"
                event = self._approval_events.get(approval_id)
                if event is not None:
                    event.set()

    def _on_notification(self, message: Dict[str, Any]) -> None:
        method = message.get("method") or ""
        params = message.get("params") or {}
        thread_id = params.get("threadId")
        if not thread_id and isinstance(params.get("thread"), dict):
            thread_id = params["thread"].get("id")
        with self._lock:
            agent_id = self._thread_agents.get(str(thread_id or ""))
        if not agent_id:
            return
        self._record_activity(agent_id, message)
        if method == "turn/started":
            turn = params.get("turn") or {}
            turn_id = str(turn.get("id") or "")
            with self._lock:
                context = self._starting.pop(agent_id, None)
                if turn_id:
                    self._active[agent_id] = turn_id
                    if context is not None:
                        self._turn_context[turn_id] = context
            self._set_state(agent_id, "running")
        elif method == "item/completed":
            item = params.get("item") or {}
            turn_id = str(params.get("turnId") or self._active.get(agent_id) or "")
            if item.get("type") == "agentMessage" and isinstance(item.get("text"), str):
                with self._lock:
                    self._turn_text[turn_id] = item["text"]
        elif method == "turn/completed":
            turn = params.get("turn") or {}
            turn_id = str(turn.get("id") or self._active.get(agent_id) or "")
            with self._lock:
                self._active.pop(agent_id, None)
                context = self._turn_context.pop(turn_id, None)
                text = self._turn_text.pop(turn_id, "")
                still_loaded = agent_id in self._loaded
            if context is not None and text.strip() and turn.get("status") == "completed":
                self._bridge_result(agent_id, context, text)
            if still_loaded:
                self._set_state(agent_id, "idle" if turn.get("status") == "completed" else "errored")
                self._actions.put(("drain", agent_id))
        if self.on_event is not None:
            try:
                self.on_event(agent_id, {"provider": "codex", **message})
            except Exception:
                pass

    def _on_server_request(self, message: Dict[str, Any]) -> Dict[str, Any]:
        method = message.get("method") or ""
        params = message.get("params") or {}
        thread_id = str(params.get("threadId") or "")
        with self._lock:
            agent_id = self._thread_agents.get(thread_id, "")
        if "requestApproval" in method and agent_id:
            db = self._db()
            try:
                row = db.execute(
                    "SELECT name, permission_profile FROM agents WHERE id=?",
                    (agent_id,)).fetchone()
            finally:
                db.close()
            profile = (row["permission_profile"] if row else "balanced") or "balanced"
            if profile == "autonomous":
                return {"decision": "decline"}
            with self._lock:
                self._approval_seq += 1
                approval_id = f"ap_{self._approval_seq}"
                event = threading.Event()
                approval = {
                    "id": approval_id,
                    "agent_id": agent_id,
                    "agent_name": (row["name"] if row else agent_id),
                    "provider": "codex", "method": method,
                    "kind": ("command" if "commandExecution" in method else
                             "file-change" if "fileChange" in method else "permission"),
                    "reason": params.get("reason") or "",
                    "command": params.get("command") or "",
                    "cwd": params.get("cwd") or "",
                    "status": "pending", "decision": "",
                    "created_at": time.strftime(
                        "%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
                }
                self._approvals[approval_id] = approval
                self._approval_events[approval_id] = event
            self._record_activity(agent_id, {
                "method": "approval/pending", "params": approval})
            if self.on_event is not None:
                try:
                    self.on_event(agent_id, {
                        "provider": "codex", "method": "approval/pending",
                        "params": dict(approval)})
                except Exception:
                    pass
            decided = event.wait(120.0)
            with self._lock:
                current = self._approvals.get(approval_id) or approval
                decision = current.get("decision") if decided else "decline"
                if not decided:
                    current["status"] = "expired"
                    current["decision"] = "decline"
                self._approval_events.pop(approval_id, None)
            return {"decision": decision or "decline"}
        raise CodexProtocolError(f"unsupported Codex server request: {method}")

    def _record_activity(self, agent_id: str, message: Dict[str, Any]) -> None:
        method = message.get("method") or "event"
        params = message.get("params") or {}
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        entry = {
            "method": method,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
            "turn_id": params.get("turnId") or turn.get("id") or "",
            "item_type": item.get("type") or "",
            "status": item.get("status") or turn.get("status") or "",
        }
        if item.get("type") == "commandExecution":
            entry["summary"] = item.get("command") or "command"
        elif item.get("type") == "fileChange":
            entry["summary"] = f"{len(item.get('changes') or [])} file change(s)"
        elif item.get("type") == "mcpToolCall":
            entry["summary"] = f"{item.get('server', '')}/{item.get('tool', '')}".strip("/")
        elif method == "turn/plan/updated":
            entry["summary"] = f"plan updated ({len(params.get('plan') or [])} steps)"
        elif method in ("warning", "configWarning"):
            entry["summary"] = params.get("message") or params.get("summary") or "warning"
        elif method == "approval/pending":
            entry["summary"] = params.get("reason") or params.get("kind") or "approval requested"
        with self._lock:
            self._activity.setdefault(
                agent_id, collections.deque(maxlen=200)).append(entry)

    def _worker_loop(self) -> None:
        while not self._worker_stop.is_set():
            try:
                action, agent_id = self._actions.get(timeout=0.5)
            except queue.Empty:
                continue
            if action != "drain":
                continue
            with self._agent_lock(agent_id):
                with self._lock:
                    if agent_id in self._active or agent_id in self._starting:
                        continue
                    pending = self._queued.get(agent_id)
                    context = pending.popleft() if pending else None
                    if pending is not None and not pending:
                        self._queued.pop(agent_id, None)
                if context is not None and self.is_running(agent_id):
                    self._start_turn(agent_id, context)

    def _bridge_result(self, agent_id: str, context: Dict[str, Any], text: str) -> None:
        db = self._db()
        try:
            already_posted = db.execute(
                "SELECT 1 FROM messages WHERE channel=? AND member_id=? AND id>? LIMIT 1",
                (context["channel"], agent_id, context["baseline"])).fetchone()
            if already_posted:
                return
            agent = db.execute("SELECT name FROM agents WHERE id=?", (agent_id,)).fetchone()
            if agent is None:
                return
            recipients: List[str] = []
            if context["channel"] == AGENT_INBOX_CHANNEL:
                # Use the specific message THIS turn was fed to answer — never
                # infer the recipient by scanning current inbox history, which
                # can pick up a different, later sender's DM (see
                # bugs/2026-08-01-private-fallback-reply-wrong-recipient.md).
                source_sender = context.get("source_sender")
                if source_sender:
                    recipients = [source_sender]
                if not recipients:
                    recipients = [r["id"] for r in db.execute(
                        "SELECT id FROM members WHERE channel=? AND kind='human' "
                        "AND active=1 ORDER BY joined_at", (context["channel"],)).fetchall()]
            now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
            db.execute(
                "INSERT INTO messages (channel,member_id,member_name,content,mentions,"
                "recipients,created_at) VALUES (?,?,?,?,?,?,?)",
                (context["channel"], agent_id, agent["name"], text.strip(),
                 json.dumps(recipients) if recipients else "",
                 json.dumps(recipients) if recipients else "[]", now))
            db.execute("UPDATE members SET last_seen=? WHERE channel=? AND id=?",
                       (now, context["channel"], agent_id))
            db.commit()
        except sqlite3.Error:
            pass
        finally:
            db.close()

    def _set_state(self, agent_id: str, state: str, *, runtime_ref: str = "",
                   clear_runtime_ref: bool = False) -> None:
        db = self._db()
        try:
            sets = ["state=?", "last_active_at=?", "pid=NULL"]
            values: List[Any] = [state,
                time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())]
            if runtime_ref:
                sets.extend(["runtime_ref=?", "session_id=?"])
                values.extend([runtime_ref, runtime_ref])
            elif clear_runtime_ref:
                sets.extend(["runtime_ref=NULL", "session_id=NULL"])
            values.append(agent_id)
            db.execute(f"UPDATE agents SET {', '.join(sets)} WHERE id=?", values)
            db.commit()
        finally:
            db.close()

    def reconcile(self) -> List[str]:
        if self._client.alive():
            return []
        with self._lock:
            dead = list(self._loaded)
            interrupted = []
            for agent_id, turn_id in list(self._active.items()):
                context = self._turn_context.pop(turn_id, None)
                if context is not None:
                    interrupted.append((agent_id, context))
            self._loaded.clear()
            self._active.clear()
            self._starting.clear()
        if not dead:
            return []
        try:
            self.ensure_started()
            for agent_id in dead:
                if self.wake(agent_id) is None:
                    raise CodexProtocolError(f"could not resume {agent_id}")
            with self._lock:
                for agent_id, context in interrupted:
                    self._queued.setdefault(
                        agent_id, collections.deque()).appendleft(context)
                    self._actions.put(("drain", agent_id))
            return []
        except Exception:
            for agent_id in dead:
                self._set_state(agent_id, "errored")
            return dead

    def shutdown(self, preserve_sessions: bool = False) -> None:
        with self._lock:
            live = list(self._loaded)
            self._loaded.clear()
        for agent_id in live:
            self._cancel_approvals(agent_id)
            self._set_state(agent_id, "sleeping" if preserve_sessions else "stopped")
        self._worker_stop.set()
        self._client.stop()
