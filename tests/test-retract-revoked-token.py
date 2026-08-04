#!/usr/bin/env python3
"""A REVOKED authoring session token must not still be able to retract its own
message. nth_retract used to accept `session_token == msg.author_session`
without revalidating the token, so a revoked session could still act. It now
revalidates via _get_session (which rejects revoked/unknown tokens) before
trusting the authorship match. Surfaced during the P3 review pass; matters more
post-P2 (one global session per agent).
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_server as srv  # noqa: E402

failures = []


def check(label, cond):
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures.append(label)


tmp = Path(tempfile.mkdtemp(prefix="nth-retract-revoked-"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
try:
    c = json.loads(srv.nth_connect(summary="a", name="A", channel="ch"))
    mid, tok = c["member_id"], c["session_token"]

    # A valid authoring token still retracts its own message.
    m1 = json.loads(srv.nth_send(channel="ch", member_id=mid, message="one", session_token=tok))
    r1 = json.loads(srv.nth_retract(channel="ch", member_id=mid, message_id=m1["message_id"], session_token=tok))
    check("valid authoring token can retract its own message", r1.get("ok") is True)

    # A revoked authoring token cannot.
    m2 = json.loads(srv.nth_send(channel="ch", member_id=mid, message="two", session_token=tok))
    db = srv.get_db()
    db.execute("UPDATE sessions SET revoked_at=? WHERE session_token=?", (srv.now_iso(), tok))
    db.commit()
    db.close()
    r2 = json.loads(srv.nth_retract(channel="ch", member_id=mid, message_id=m2["message_id"], session_token=tok))
    check("revoked authoring token cannot retract", "error" in r2)
    check("the message was NOT retracted by the revoked token", "ok" not in r2)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
