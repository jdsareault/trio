#!/usr/bin/env python3
"""Unified-interface Phase 2: agents / agent_channels schema smoke test.

Verifies the additive schema is valid SQL and supports the load-bearing
queries: placement (agent in N channels), the per-channel members join, and
the 'abandoned agent' detection (an agent in zero channels). The PK
(duplicate-placement) constraint IS enforced and tested; the declared FOREIGN
KEYs are NOT — get_db() doesn't set PRAGMA foreign_keys=ON, so they're advisory
(orphan agent_channels rows are insertable). That's an accepted Phase-2
property (integrity is app-enforced), not verified here.

Runs against a throwaway DB via nth_server.get_db (monkeypatched path), so it
also proves get_db() creates the new tables on a fresh database.
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import nth_server  # noqa: E402

failures = 0


def check(label, cond):
    global failures
    if cond:
        print(f"PASS: {label}")
    else:
        print(f"FAIL: {label}")
        failures += 1


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="nth-agents-test-")
    db_path = Path(tmp) / "nth.db"
    # Point nth_server at the throwaway DB so get_db() builds the full schema.
    nth_server.DB_PATH = db_path
    nth_server.DB_DIR = Path(tmp)

    db = nth_server.get_db()
    now = nth_server.now_iso()

    # Fresh DB: get_db() created agents + agent_channels.
    tbls = {r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    check("get_db creates agents table", "agents" in tbls)
    check("get_db creates agent_channels table", "agent_channels" in tbls)
    check("get_db creates runtime history table", "agent_runtime_history" in tbls)
    agent_cols = {r[1] for r in db.execute("PRAGMA table_info(agents)").fetchall()}
    check("agents carry provider-neutral runtime settings",
          {"runtime_provider", "runtime_ref", "cwd", "permission_profile",
           "wake_mode"} <= agent_cols)

    # A channel + a managed agent placed in two channels.
    for code in ("alpha", "beta"):
        db.execute("INSERT INTO channels (code, status, created_at, updated_at) "
                   "VALUES (?, 'active', ?, ?)", (code, now, now))
    db.execute(
        "INSERT INTO agents (id, name, model, state, managed, created_at) "
        "VALUES ('ag1', 'Aragorn', 'sonnet', 'running', 1, ?)", (now,))
    db.execute("INSERT INTO agent_channels (agent_id, channel, member_id, joined_at) "
               "VALUES ('ag1', 'alpha', 'm_ag1_alpha', ?)", (now,))
    db.execute("INSERT INTO agent_channels (agent_id, channel, member_id, joined_at) "
               "VALUES ('ag1', 'beta', 'm_ag1_beta', ?)", (now,))
    # An abandoned agent: no placements.
    db.execute(
        "INSERT INTO agents (id, name, model, state, managed, created_at) "
        "VALUES ('ag2', 'Gimli', 'haiku', 'sleeping', 1, ?)", (now,))
    db.commit()

    placements = db.execute(
        "SELECT channel FROM agent_channels WHERE agent_id='ag1' ORDER BY channel"
    ).fetchall()
    check("agent placed in two channels", [r[0] for r in placements] == ["alpha", "beta"])

    # PK prevents a duplicate placement in the same channel.
    dup_ok = True
    try:
        db.execute("INSERT INTO agent_channels (agent_id, channel, member_id, joined_at) "
                   "VALUES ('ag1', 'alpha', 'x', ?)", (now,))
        db.commit()
        dup_ok = False
    except Exception:
        db.rollback()
    check("duplicate placement rejected by PK", dup_ok)

    # Abandoned agents = agents with zero agent_channels rows.
    abandoned = db.execute(
        "SELECT a.id FROM agents a "
        "LEFT JOIN agent_channels ac ON ac.agent_id = a.id "
        "WHERE ac.agent_id IS NULL"
    ).fetchall()
    check("abandoned-agent query finds the placement-less agent",
          [r[0] for r in abandoned] == ["ag2"])

    # Roster join: an agent's channels + its per-channel member ids.
    rows = db.execute(
        "SELECT ac.channel, ac.member_id FROM agent_channels ac "
        "WHERE ac.agent_id='ag1' ORDER BY ac.channel").fetchall()
    check("placement carries per-channel member_id",
          rows[0]["member_id"] == "m_ag1_alpha" and rows[1]["member_id"] == "m_ag1_beta")

    defaults = db.execute(
        "SELECT runtime_provider, permission_profile, wake_mode "
        "FROM agents WHERE id='ag1'").fetchone()
    check("existing create paths receive safe runtime defaults",
          tuple(defaults) == ("claude", "balanced", "at"))

    db.close()
    print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
