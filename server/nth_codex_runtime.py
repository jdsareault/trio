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
import shlex
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional


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
        tool_names = [
            "connect", "send", "dm", "poll", "ack", "pounds", "ask",
            "claim", "complete", "cancel", "release", "lock", "unlock",
            "set_status", "rename", "status", "roster", "history", "end",
            "list", "cull", "cleanup", "retract",
        ]
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

    def start(self, timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
        if self.alive():
            return dict(self.initialize_result)
        self._closed.clear()
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
                    self._handle_server_request(message)
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


def codex_cli_diagnostics(timeout: float = 5.0) -> Dict[str, Any]:
    """Cheap readiness probe that never starts a model turn."""
    executable = shutil.which("codex")
    result: Dict[str, Any] = {
        "provider": "codex", "command": ["codex"],
        "executable": executable or "", "available": bool(executable),
        "authenticated": None, "version": "", "ready": False, "detail": "",
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

