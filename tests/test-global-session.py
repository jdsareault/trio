"""Unit 1: sessions are agent-scoped rather than channel-scoped."""

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


tmp = tempfile.mkdtemp(prefix="nth-global-session-")
srv.DB_DIR = Path(tmp)
srv.DB_PATH = Path(tmp) / "nth.db"

try:
    first = json.loads(srv.nth_connect(
        summary="session owner", name="SessionOwner", channel="session-a"))
    member_id = first["member_id"]
    first_token = first["session_token"]
    reclaim_secret = first["reclaim_secret"]
    check("first connect returns a session token", bool(first_token))
    check("first connect returns a reclaim secret", bool(reclaim_secret))

    second = json.loads(srv.nth_connect(
        summary="session owner", name="SessionOwner", channel="session-b",
        resume_member_id=member_id, reclaim_secret=reclaim_secret))
    check("cross-channel connect reclaims the same agent", second["member_id"] == member_id)
    check("cross-channel connect reuses the global session token",
          second["session_token"] == first_token)

    sent_a = json.loads(srv.nth_send(
        channel="session-a", member_id=member_id, session_token=first_token,
        message="send through the global session in A"))
    sent_b = json.loads(srv.nth_send(
        channel="session-b", member_id=member_id, session_token=first_token,
        message="send through the global session in B"))
    check("global session authenticates a send in channel A", sent_a.get("ok") is True)
    check("global session authenticates a send in channel B", sent_b.get("ok") is True)

    db = srv.get_db()
    try:
        rows = db.execute(
            "SELECT session_token, channel, revoked_at FROM sessions "
            "WHERE member_id = ? AND revoked_at IS NULL", (member_id,)
        ).fetchall()
        cross_channel = srv._get_session(db, "session-b", first_token)
        check("one active session row exists for the agent", len(rows) == 1)
        check("global lookup ignores the session row's legacy channel",
              cross_channel is not None and cross_channel["session_token"] == first_token)
    finally:
        db.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
