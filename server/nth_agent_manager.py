#!/usr/bin/env python3
"""Provider-neutral managed-agent lifecycle for the unified Trio hub."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import nth_supervisor as nsup
from nth_codex_runtime import CodexRuntimeManager


CLAUDE_MODELS = [
    {"id": "opus", "name": "Claude Opus", "efforts": ["low", "medium", "high", "max"]},
    {"id": "sonnet", "name": "Claude Sonnet", "efforts": ["low", "medium", "high", "max"],
     "default": True},
    {"id": "haiku", "name": "Claude Haiku", "efforts": ["low", "medium", "high"]},
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class UnifiedAgentSupervisor:
    """Dispatch lifecycle calls to Claude or Codex by durable agent provider."""

    def __init__(self, db_path: Path, *, nth_server_path: str = "",
                 on_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                 claude: Optional[nsup.AgentSupervisor] = None,
                 codex: Optional[CodexRuntimeManager] = None):
        self.db_path = Path(db_path)
        self.claude = claude or nsup.AgentSupervisor(
            db_path=self.db_path, on_event=on_event)
        self.codex = codex or CodexRuntimeManager(
            self.db_path, nth_server_path=nth_server_path, on_event=on_event)

    # Backward-compatible accessors used by Phase 4 diagnostics and tests.
    @property
    def runtime(self):
        return self.claude.runtime

    @property
    def _procs(self):
        return self.claude._procs

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(str(self.db_path), timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        return db

    def provider_for(self, agent_id: str) -> str:
        db = self._db()
        try:
            row = db.execute(
                "SELECT runtime_provider FROM agents WHERE id=?", (agent_id,)
            ).fetchone()
        finally:
            db.close()
        if row is None:
            return ""
        return (row["runtime_provider"] or "claude").lower()

    def manager_for(self, agent_id: str):
        provider = self.provider_for(agent_id)
        if provider == "codex":
            return self.codex
        if provider == "claude":
            return self.claude
        return None

    def spawn(self, agent_id: str, *, provider: str = "", **kwargs):
        provider = (provider or self.provider_for(agent_id) or "claude").lower()
        if provider not in ("claude", "codex"):
            raise ValueError(f"unsupported runtime provider: {provider}")
        db = self._db()
        try:
            db.execute("UPDATE agents SET runtime_provider=? WHERE id=?",
                       (provider, agent_id))
            db.commit()
        finally:
            db.close()
        manager = self.codex if provider == "codex" else self.claude
        if provider == "claude":
            kwargs.pop("cwd", None)
            kwargs.pop("permission_profile", None)
        return manager.spawn(agent_id, **kwargs)

    def wake(self, agent_id: str, **kwargs):
        manager = self.manager_for(agent_id)
        return manager.wake(agent_id, **kwargs) if manager else None

    def feed(self, agent_id: str, channel: str, text: str,
             attachments: Optional[List[str]] = None) -> bool:
        manager = self.manager_for(agent_id)
        if manager is self.codex:
            return self.codex.feed(
                agent_id, channel, text, attachments=attachments or [])
        return bool(manager and manager.feed(
            agent_id, channel, text, attachments=attachments or []))

    def hibernate(self, agent_id: str) -> bool:
        manager = self.manager_for(agent_id)
        return bool(manager and manager.hibernate(agent_id))

    def stop(self, agent_id: str) -> bool:
        manager = self.manager_for(agent_id)
        return bool(manager and manager.stop(agent_id))

    def interrupt(self, agent_id: str) -> bool:
        manager = self.manager_for(agent_id)
        if manager is self.codex:
            return self.codex.interrupt(agent_id)
        # Claude's stream protocol has no provider-level turn interrupt. Stop is
        # the truthful equivalent and retains its resumable session reference.
        return bool(manager and manager.stop(agent_id))

    def compact(self, agent_id: str) -> bool:
        manager = self.manager_for(agent_id)
        return bool(manager and manager.compact(agent_id))

    def clear(self, agent_id: str, **kwargs):
        manager = self.manager_for(agent_id)
        if manager is None:
            return None
        self._record_runtime(agent_id, "cleared")
        return manager.clear(agent_id, **kwargs)

    def delete(self, agent_id: str) -> bool:
        manager = self.manager_for(agent_id)
        if manager is None:
            return False
        ok = self.codex.delete(agent_id) if manager is self.codex else manager.stop(agent_id)
        if ok:
            self._record_runtime(agent_id, "deleted")
        return bool(ok)

    def _record_runtime(self, agent_id: str, disposition: str) -> None:
        db = self._db()
        try:
            row = db.execute(
                "SELECT runtime_provider, runtime_ref, session_id FROM agents WHERE id=?",
                (agent_id,)).fetchone()
            if row is not None:
                runtime_ref = row["runtime_ref"] or row["session_id"] or ""
                if runtime_ref:
                    db.execute(
                        "INSERT INTO agent_runtime_history "
                        "(agent_id,provider,runtime_ref,disposition,created_at) "
                        "VALUES (?,?,?,?,?)",
                        (agent_id, row["runtime_provider"] or "claude", runtime_ref,
                         disposition, now_iso()))
                    db.commit()
        finally:
            db.close()

    def is_running(self, agent_id: str) -> bool:
        manager = self.manager_for(agent_id)
        return bool(manager and manager.is_running(agent_id))

    def live_ids(self) -> List[str]:
        return sorted(set(self.claude.live_ids()) | set(self.codex.live_ids()))

    def queued_count(self, agent_id: str) -> int:
        manager = self.manager_for(agent_id)
        if manager is self.codex:
            return self.codex.queued_count(agent_id)
        return 0

    def is_busy(self, agent_id: str) -> bool:
        manager = self.manager_for(agent_id)
        if manager is self.codex:
            return self.codex.is_busy(agent_id)
        return False

    def activity(self, agent_id: str, limit: int = 100) -> List[Dict[str, Any]]:
        manager = self.manager_for(agent_id)
        if manager is self.codex:
            return self.codex.activity(agent_id, limit=limit)
        return []

    def pending_approvals(self) -> List[Dict[str, Any]]:
        return self.codex.pending_approvals()

    def resolve_approval(self, approval_id: str, decision: str) -> bool:
        return self.codex.resolve_approval(approval_id, decision)

    def diagnostics(self, provider: str, *, deep: bool = False) -> Dict[str, Any]:
        provider = provider.lower()
        if provider == "claude":
            return self.claude.runtime.diagnostics()
        if provider == "codex":
            return self.codex.diagnostics(deep=deep)
        return {"provider": provider, "ready": False,
                "detail": f"unsupported runtime provider: {provider}"}

    def list_models(self, provider: str) -> List[Dict[str, Any]]:
        if provider.lower() == "claude":
            return [dict(model) for model in CLAUDE_MODELS]
        if provider.lower() == "codex":
            return self.codex.list_models()
        raise ValueError(f"unsupported runtime provider: {provider}")

    def _set_state(self, agent_id: str, state: str, **_kwargs) -> int:
        db = self._db()
        try:
            cur = db.execute(
                "UPDATE agents SET state=?, pid=NULL, last_active_at=? WHERE id=?",
                (state, now_iso(), agent_id))
            db.commit()
            return cur.rowcount
        finally:
            db.close()

    def reconcile(self) -> List[str]:
        return self.claude.reconcile() + self.codex.reconcile()

    def shutdown(self, preserve_sessions: bool = False) -> None:
        self.claude.shutdown(preserve_sessions=preserve_sessions)
        self.codex.shutdown(preserve_sessions=preserve_sessions)
