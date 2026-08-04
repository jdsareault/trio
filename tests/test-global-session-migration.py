"""P2 schema migration revokes pre-existing channel-scoped sessions once."""

import json
import shutil
import sys
import tempfile
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv  # noqa: E402


failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + f": {name}")
    if not condition:
        failures.append(name)


tmp = tempfile.mkdtemp(prefix="nth-global-session-migration-")
srv.DB_DIR = Path(tmp)
srv.DB_PATH = Path(tmp) / "nth.db"

try:
    # Initialize the current schema, then emulate a P1 database that has not
    # yet recorded the P2 migration and still holds per-channel bearer tokens.
    db = srv.get_db()
    db.execute(
        "DELETE FROM schema_migrations WHERE name = ?",
        (srv.GLOBAL_SESSION_MIGRATION,),
    )
    for token, channel in (("legacy-a-token", "legacy-a"),
                           ("legacy-b-token", "legacy-b")):
        db.execute(
            "INSERT INTO sessions "
            "(session_token, member_id, channel, role, connected_at, last_seen) "
            "VALUES (?, 'legacy-agent', ?, 'primary', ?, ?)",
            (token, channel, srv.now_iso(), srv.now_iso()),
        )
    db.commit()
    db.close()

    migrated = srv.get_db()
    try:
        rows = migrated.execute(
            "SELECT session_token, revoked_at FROM sessions "
            "WHERE member_id = 'legacy-agent' ORDER BY session_token"
        ).fetchall()
        marker = migrated.execute(
            "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?",
            (srv.GLOBAL_SESSION_MIGRATION,),
        ).fetchone()["n"]
        check("migration revokes every pre-existing channel token",
              len(rows) == 2 and all(row["revoked_at"] for row in rows))
        check("migration marker is recorded", marker == 1)
        check("revoked legacy token cannot resolve globally",
              srv._get_session(migrated, "legacy-b", "legacy-b-token") is None)
    finally:
        migrated.close()

    fresh = json.loads(srv.nth_connect(
        summary="post migration", name="PostMigration", channel="post-migration"))
    post_token = fresh["session_token"]
    db = srv.get_db()
    try:
        post = db.execute(
            "SELECT revoked_at FROM sessions WHERE session_token = ?", (post_token,)
        ).fetchone()
        check("post-migration connect mints a live session", post is not None and post["revoked_at"] is None)
    finally:
        db.close()

    # A second get_db() must not revoke a session minted after the migration.
    db = srv.get_db()
    try:
        post_again = db.execute(
            "SELECT revoked_at FROM sessions WHERE session_token = ?", (post_token,)
        ).fetchone()
        check("migration is idempotent for later sessions",
              post_again is not None and post_again["revoked_at"] is None)
    finally:
        db.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
