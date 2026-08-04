"""Unit 2: global sessions retain independent per-channel read cursors."""

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


tmp = tempfile.mkdtemp(prefix="nth-global-watermark-")
srv.DB_DIR = Path(tmp)
srv.DB_PATH = Path(tmp) / "nth.db"


def poll(channel, member_id, token):
    return json.loads(srv.nth_poll(
        channel=channel, member_id=member_id, session_token=token,
        wait_seconds=0))


try:
    first = json.loads(srv.nth_connect(
        summary="watermark owner", name="WatermarkOwner", channel="wm-a"))
    agent = first["member_id"]
    token = first["session_token"]
    secret = first["reclaim_secret"]
    second = json.loads(srv.nth_connect(
        summary="watermark owner", name="WatermarkOwner", channel="wm-b",
        resume_member_id=agent, reclaim_secret=secret))
    check("one token spans both channels", second["session_token"] == token)

    sender_a = json.loads(srv.nth_connect(
        summary="sender A", name="SenderA", channel="wm-a"))
    sender_b = json.loads(srv.nth_connect(
        summary="sender B", name="SenderB", channel="wm-b"))

    a_first = poll("wm-a", agent, token)
    b_first = poll("wm-b", agent, token)
    a_ids = [m["id"] for m in a_first.get("messages", [])]
    b_ids = [m["id"] for m in b_first.get("messages", [])]
    check("channel A has unread messages", a_first.get("event") == "new_messages" and bool(a_ids))
    check("channel B has unread messages", b_first.get("event") == "new_messages" and bool(b_ids))

    ack_a = json.loads(srv.nth_ack(
        channel="wm-a", member_id=agent, through_id=max(a_ids),
        session_token=token))
    check("ack with global token succeeds in A", ack_a.get("ok") is True)
    db = srv.get_db()
    try:
        session_before_poll = db.execute(
            "SELECT last_read FROM sessions WHERE session_token = ?", (token,)
        ).fetchone()["last_read"]
        member_a_after_ack = db.execute(
            "SELECT last_read FROM members WHERE id = ? AND channel = 'wm-a'",
            (agent,),
        ).fetchone()["last_read"]
        check("ack advances members.last_read in A", member_a_after_ack >= max(a_ids))
        check("ack no longer drives sessions.last_read", session_before_poll < max(a_ids))
        # Simulate a stale/global legacy cursor from another channel. The
        # current channel's members.last_read must still drive this poll.
        db.execute(
            "UPDATE sessions SET last_read = 999 WHERE session_token = ?", (token,)
        )
        db.commit()
    finally:
        db.close()
    a_again = poll("wm-a", agent, token)
    b_again = poll("wm-b", agent, token)
    check("ack in A suppresses A re-notify", a_again.get("event") == "no_new")
    check("ack in A leaves B unread", b_again.get("event") == "new_messages" and bool(b_again.get("messages")))

    # A reconnect must retain A's channel-local cursor rather than replacing
    # it with the global session cursor or the channel's latest id.
    late = json.loads(srv.nth_send(
        channel="wm-a", member_id=sender_a["member_id"],
        session_token=sender_a["session_token"], message="late A message"))
    reconnect = json.loads(srv.nth_connect(
        summary="watermark owner", name="WatermarkOwner", channel="wm-a",
        resume_member_id=agent, reclaim_secret=secret))
    check("reconnect reuses the same token", reconnect["session_token"] == token)
    after_reconnect = poll("wm-a", agent, token)
    after_ids = [m["id"] for m in after_reconnect.get("messages", [])]
    check("reconnect preserves A cursor for new unread work", late["message_id"] in after_ids)
    check("reconnect does not replay already acked A work",
          all(mid > max(a_ids) for mid in after_ids))

    db = srv.get_db()
    try:
        rows = db.execute(
            "SELECT channel, last_read FROM members WHERE id = ? ORDER BY channel",
            (agent,)).fetchall()
        by_channel = {r["channel"]: r["last_read"] for r in rows}
        check("members.last_read is independent for A and B",
              by_channel.get("wm-a", 0) >= max(a_ids)
              and by_channel.get("wm-b", 0) < max(b_ids))
    finally:
        db.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
