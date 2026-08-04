"""Unit 3: a global session does not grant access to unjoined channels."""

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


def rejected(result):
    value = json.loads(result) if isinstance(result, str) else result
    return "error" in value and "member" in value["error"].lower()


tmp = tempfile.mkdtemp(prefix="nth-global-capability-")
srv.DB_DIR = Path(tmp)
srv.DB_PATH = Path(tmp) / "nth.db"

try:
    owner = json.loads(srv.nth_connect(
        summary="capability owner", name="CapabilityOwner", channel="cap-a"))
    agent = owner["member_id"]
    token = owner["session_token"]
    peer = json.loads(srv.nth_connect(
        summary="capability peer", name="CapabilityPeer", channel="cap-b"))
    peer_id = peer["member_id"]

    # The owner is a member of cap-a only. Every channel-scoped mutator must
    # reject the valid global token (or legacy member id) before it can inspect
    # or change cap-b state.
    checks = {
        "send": srv.nth_send(
            channel="cap-b", member_id=agent, session_token=token,
            message="must not cross the channel boundary"),
        "dm": srv.nth_dm(
            channel="cap-b", member_id=agent, session_token=token,
            message="must not cross the channel boundary", to="CapabilityPeer"),
        "ask": srv.nth_ask(
            channel="cap-b", member_id=agent, session_token=token,
            question="Should fail before target resolution?", options=["yes", "no"],
            target="CapabilityPeer"),
        "poll": srv.nth_poll(
            channel="cap-b", member_id=agent, session_token=token, wait_seconds=0),
        "ack": srv.nth_ack(
            channel="cap-b", member_id=agent, session_token=token, through_id=0),
        "retract": srv.nth_retract(
            channel="cap-b", member_id=agent, session_token=token, message_id=1),
        "claim": srv.nth_claim(
            channel="cap-b", member_id=agent, session_token=token, task_id=1),
        "complete": srv.nth_complete(
            channel="cap-b", member_id=agent, task_id=1),
        "release": srv.nth_release(
            channel="cap-b", member_id=agent, task_id=1),
        "cancel": srv.nth_cancel(
            channel="cap-b", member_id=agent, task_id=1),
        "set_status": srv.nth_set_status(
            channel="cap-b", member_id=agent, status_text="should fail"),
        "rename": srv.nth_rename(
            channel="cap-b", member_id=agent, session_token=token,
            new_name="ShouldNotRename"),
        "lock": srv.nth_lock(
            channel="cap-b", member_id=agent, resource="secret-resource"),
        "unlock": srv.nth_unlock(
            channel="cap-b", member_id=agent, resource="secret-resource"),
        "end": srv.nth_end(channel="cap-b", member_id=agent),
        "cull": srv.nth_cull(
            channel="cap-b", member_id=agent, target_member_id=peer_id),
    }
    for name, result in checks.items():
        check(f"{name} rejects an A-only agent in B", rejected(result))

    allowed = json.loads(srv.nth_send(
        channel="cap-a", member_id=agent, session_token=token,
        message="allowed in the joined channel"))
    check("global session remains allowed in A", allowed.get("ok") is True)

    db = srv.get_db()
    try:
        b_status = db.execute(
            "SELECT status FROM channels WHERE code = 'cap-b'"
        ).fetchone()["status"]
        b_members = db.execute(
            "SELECT COUNT(*) AS n FROM members WHERE channel = 'cap-b'"
        ).fetchone()["n"]
        b_locks = db.execute(
            "SELECT COUNT(*) AS n FROM locks WHERE channel = 'cap-b'"
        ).fetchone()["n"]
        check("rejected calls leave B active", b_status == "active")
        check("rejected calls leave B membership unchanged", b_members == 1)
        check("rejected calls create no B lock", b_locks == 0)
    finally:
        db.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
