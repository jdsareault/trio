#!/usr/bin/env python3
"""Unit 1: self-registered identities are global and securely reclaimable."""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_server as srv  # noqa: E402


failures = []


def check(label, condition):
    print(("PASS" if condition else "FAIL") + ": " + label)
    if not condition:
        failures.append(label)


tmp = Path(tempfile.mkdtemp(prefix="nth-global-identity-"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
try:
    first = json.loads(srv.nth_connect(
        summary="self", name="Alice", channel="identity-a", model="opus"))
    member_id = first.get("member_id")
    secret = first.get("reclaim_secret", "")
    check("normal connect returns canonical id and reclaim secret",
          first.get("action") == "created" and member_id and secret)

    db = srv.get_db()
    agent = db.execute(
        "SELECT id, name, model, managed, reclaim_secret, last_active_at "
        "FROM agents WHERE id = ?", (member_id,)).fetchone()
    check("normal connect registers a self-managed global agent",
          agent and tuple(agent)[:4] == (member_id, "Alice", "opus", 0))
    check("agents row stores the returned secret and activity timestamp",
          agent and agent["reclaim_secret"] == secret and agent["last_active_at"])
    db.close()

    denied = json.loads(srv.nth_connect(
        summary="spoof", name="Impostor", channel="identity-b",
        resume_member_id=member_id))
    check("cross-channel reclaim without secret is refused",
          "error" in denied)
    wrong = json.loads(srv.nth_connect(
        summary="spoof", name="Impostor", channel="identity-b",
        resume_member_id=member_id, reclaim_secret="wrong"))
    check("cross-channel reclaim with wrong secret is refused",
          "error" in wrong)
    db = srv.get_db()
    check("failed cross-channel reclaims do not create a member row",
          db.execute("SELECT 1 FROM members WHERE id=? AND channel=?",
                     (member_id, "identity-b")).fetchone() is None)
    db.close()

    reclaimed = json.loads(srv.nth_connect(
        summary="self", name="Alice", channel="identity-b",
        resume_member_id=member_id, reclaim_secret=secret))
    check("valid cross-channel reclaim reuses the canonical id",
          reclaimed.get("member_id") == member_id and
          reclaimed.get("action") == "created")
    check("valid reclaim returns the same secret",
          reclaimed.get("reclaim_secret") == secret)

    unknown = json.loads(srv.nth_connect(
        summary="forged", name="Forged", channel="identity-c",
        resume_member_id="chosen-id", reclaim_secret="wrong"))
    db = srv.get_db()
    check("unknown reclaim mints a fresh id and secret",
          unknown.get("member_id") != "chosen-id" and
          bool(unknown.get("reclaim_secret")))
    check("unknown reclaim registers only the fresh identity",
          db.execute("SELECT 1 FROM agents WHERE id='chosen-id'").fetchone() is None and
          db.execute("SELECT 1 FROM agents WHERE id=?",
                     (unknown.get("member_id"),)).fetchone() is not None)
    db.close()

    # A fresh short id must not collide with a pre-existing global identity.
    db = srv.get_db()
    db.execute(
        "INSERT INTO agents (id, name, reclaim_secret, created_at) "
        "VALUES ('shared-id', 'Existing', 'private-secret', ?)",
        (srv.now_iso(),),
    )
    db.commit()
    db.close()
    original_generate = srv.generate_member_id
    minted = iter(("shared-id", "fresh-id"))
    srv.generate_member_id = lambda: next(minted)
    try:
        fresh = json.loads(srv.nth_connect(
            summary="new", name="New Agent", channel="identity-collision"))
    finally:
        srv.generate_member_id = original_generate
    check("fresh registration skips a global agent-id collision",
          fresh.get("member_id") == "fresh-id")
    check("collision cannot disclose the existing agent secret",
          fresh.get("reclaim_secret") != "private-secret")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
