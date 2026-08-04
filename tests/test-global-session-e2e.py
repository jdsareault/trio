"""End-to-end Unit 1–3 coverage: identity, session, watermarks, and access."""

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv  # noqa: E402
import nth_web as web  # noqa: E402


failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + f": {name}")
    if not condition:
        failures.append(name)


def parse(value):
    return json.loads(value) if isinstance(value, str) else value


tmp = tempfile.mkdtemp(prefix="nth-global-session-e2e-")
srv.DB_DIR = Path(tmp)
srv.DB_PATH = Path(tmp) / "nth.db"

try:
    first = parse(srv.nth_connect(
        summary="e2e owner", name="E2EOwner", channel="e2e-a"))
    agent = first["member_id"]
    token = first["session_token"]
    secret = first["reclaim_secret"]
    second = parse(srv.nth_connect(
        summary="e2e owner", name="E2EOwner", channel="e2e-b",
        resume_member_id=agent, reclaim_secret=secret))
    outsider = parse(srv.nth_connect(
        summary="e2e outsider", name="E2EOutsider", channel="e2e-c"))
    peer_a = parse(srv.nth_connect(
        summary="peer A", name="PeerA", channel="e2e-a"))
    peer_b = parse(srv.nth_connect(
        summary="peer B", name="PeerB", channel="e2e-b"))

    check("one canonical id spans A and B", second["member_id"] == agent)
    check("one active token spans A and B", second["session_token"] == token)

    sent_a = parse(srv.nth_send(
        channel="e2e-a", member_id=agent, session_token=token,
        message="owner message A"))
    sent_b = parse(srv.nth_send(
        channel="e2e-b", member_id=agent, session_token=token,
        message="owner message B"))
    check("global session sends in A", sent_a.get("ok") is True)
    check("global session sends in B", sent_b.get("ok") is True)

    # Peer messages create independent unread batches for the same agent.
    peer_a_msg = parse(srv.nth_send(
        channel="e2e-a", member_id=peer_a["member_id"],
        session_token=peer_a["session_token"], message="unread A"))
    peer_b_msg = parse(srv.nth_send(
        channel="e2e-b", member_id=peer_b["member_id"],
        session_token=peer_b["session_token"], message="unread B"))
    poll_a = parse(srv.nth_poll(
        channel="e2e-a", member_id=agent, session_token=token, wait_seconds=0))
    poll_b = parse(srv.nth_poll(
        channel="e2e-b", member_id=agent, session_token=token, wait_seconds=0))
    a_ids = [m["id"] for m in poll_a.get("messages", [])]
    b_ids = [m["id"] for m in poll_b.get("messages", [])]
    check("A returns its own channel's unread batch", peer_a_msg["message_id"] in a_ids)
    check("B returns its own channel's unread batch", peer_b_msg["message_id"] in b_ids)

    ack_a = parse(srv.nth_ack(
        channel="e2e-a", member_id=agent, session_token=token,
        through_id=max(a_ids)))
    check("ack in A succeeds", ack_a.get("ok") is True)
    # A stale legacy session cursor must not suppress B's member watermark.
    db = srv.get_db()
    try:
        db.execute(
            "UPDATE sessions SET last_read = 999 WHERE session_token = ?", (token,)
        )
        db.commit()
    finally:
        db.close()
    b_after_a = parse(srv.nth_poll(
        channel="e2e-b", member_id=agent, session_token=token, wait_seconds=0))
    check("ack in A leaves B unread", peer_b_msg["message_id"] in
          [m["id"] for m in b_after_a.get("messages", [])])

    # The same global token cannot cross into an unjoined channel.
    denied = parse(srv.nth_send(
        channel="e2e-c", member_id=agent, session_token=token,
        message="must be rejected"))
    check("global token is rejected in unjoined C",
          "error" in denied and "member" in denied["error"].lower())
    allowed = parse(srv.nth_send(
        channel="e2e-a", member_id=agent, session_token=token,
        message="still allowed in joined A"))
    check("global token remains allowed in joined A", allowed.get("ok") is True)

    # Web roster is another read surface: it must use the channel member
    # watermark, not the stale global session cursor.
    hub = web.EventHub(srv.DB_PATH, "e2e-a")
    db = srv.get_db()
    try:
        roster = hub._fetch_roster(db)
    finally:
        db.close()
    owner_row = next((row for row in roster if row["id"] == agent), None)
    check("web roster uses A's member watermark",
          owner_row is not None and owner_row["last_read"] >= max(a_ids))

    # The global session's legacy channel is A. Clear B's member heartbeat so
    # this proves the secondary-channel roster joins observability globally.
    db = srv.get_db()
    try:
        db.execute(
            "UPDATE members SET last_seen = '', messenger_heartbeat = '', "
            "watchdog_heartbeat = '' WHERE id = ? AND channel = 'e2e-b'",
            (agent,),
        )
        db.commit()
    finally:
        db.close()
    hub_b = web.EventHub(srv.DB_PATH, "e2e-b")
    db = srv.get_db()
    try:
        roster_b = hub_b._fetch_roster(db)
    finally:
        db.close()
    owner_b = next((row for row in roster_b if row["id"] == agent), None)
    check("secondary web roster inherits global session observability",
          owner_b is not None and bool(owner_b["last_seen"]))

    db = srv.get_db()
    try:
        active = db.execute(
            "SELECT COUNT(*) AS n FROM sessions "
            "WHERE member_id = ? AND revoked_at IS NULL", (agent,)
        ).fetchone()["n"]
        check("agent has one active global session row", active == 1)
    finally:
        db.close()

    # Culling topic presences must not revoke the global session while the
    # permanent global inbox presence remains. Full teardown of that inbox
    # presence is what revokes the session.
    secondary_cull = parse(srv.nth_cull(
        channel="e2e-b", member_id=peer_b["member_id"],
        target_member_id=agent))
    check("culling the secondary presence succeeds", secondary_cull.get("ok") is True)
    still_allowed = parse(srv.nth_send(
        channel="e2e-a", member_id=agent, session_token=token,
        message="still alive in A after B cull"))
    check("secondary cull preserves the global session in A",
          still_allowed.get("ok") is True)

    final_cull = parse(srv.nth_cull(
        channel="e2e-a", member_id=peer_a["member_id"],
        target_member_id=agent))
    check("culling the final topic presence succeeds", final_cull.get("ok") is True)
    db = srv.get_db()
    try:
        revoked = db.execute(
            "SELECT revoked_at FROM sessions WHERE member_id = ?", (agent,)
        ).fetchone()["revoked_at"]
        check("final topic cull preserves the global session", not revoked)
    finally:
        db.close()

    inbox_cull = parse(srv.nth_cull(
        channel=srv.AGENT_INBOX_CHANNEL, member_id=peer_a["member_id"],
        target_member_id=agent))
    check("culling the global inbox presence succeeds", inbox_cull.get("ok") is True)
    db = srv.get_db()
    try:
        inbox_member = db.execute(
            "SELECT 1 FROM members WHERE id=? AND channel=?",
            (agent, srv.AGENT_INBOX_CHANNEL)).fetchone()
        revoked = db.execute(
            "SELECT revoked_at FROM sessions WHERE member_id = ?", (agent,)
        ).fetchone()["revoked_at"]
        check("global inbox teardown removes the final presence", inbox_member is None)
        check("global inbox teardown revokes the global session", bool(revoked))
    finally:
        db.close()
    denied_after_final = parse(srv.nth_send(
        channel="e2e-a", member_id=agent, session_token=token,
        message="must fail after final cull"))
    check("revoked session cannot act after final cull",
          "error" in denied_after_final)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
