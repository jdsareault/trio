#!/usr/bin/env python3
"""Managed-agent inbox replies are private even when a model uses trio_send."""
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

import nth_server as srv  # noqa: E402
from nth_constants import AGENT_INBOX_CHANNEL  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + ": " + name)
    if not condition:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth_agent_inbox_"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
try:
    db = srv.get_db()
    now = srv.now_iso()
    db.execute(
        "INSERT INTO agents (id, name, reclaim_secret, created_at) "
        "VALUES ('ag_managed', 'Managed', 'managed-secret', ?)", (now,))
    db.execute(
        "INSERT INTO agents (id, name, reclaim_secret, created_at) "
        "VALUES ('ag_other', 'Other', 'other-secret', ?)", (now,))
    db.commit()
    db.close()
    first = json.loads(srv.nth_connect(
        summary="managed", name="Managed", channel=AGENT_INBOX_CHANNEL,
        resume_member_id="ag_managed", reclaim_secret="managed-secret"))
    json.loads(srv.nth_connect(
        summary="other", name="Other", channel=AGENT_INBOX_CHANNEL,
        resume_member_id="ag_other", reclaim_secret="other-secret"))
    db = srv.get_db()
    try:
        now = srv.now_iso()
        operator_id = "_op_l_test"
        db.execute(
            "INSERT INTO members (id,channel,name,summary,skills,last_seen,joined_at,active,kind) "
            "VALUES (?,?,?,'','',?,?,1,'human')",
            (operator_id, AGENT_INBOX_CHANNEL, "Operator", now, now))
        db.execute(
            "INSERT INTO messages (channel,member_id,member_name,content,recipients,created_at) "
            "VALUES (?,?,?,?,?,?)",
            (AGENT_INBOX_CHANNEL, operator_id, "Operator", "private question",
             json.dumps(["ag_managed"]), now))
        db.commit()
    finally:
        db.close()

    sent = json.loads(srv.nth_send(
        AGENT_INBOX_CHANNEL, "ag_managed", "private answer",
        session_token=first.get("session_token", "")))
    check("agent reply succeeds through ordinary trio_send", "message_id" in sent)
    db = srv.get_db()
    try:
        row = db.execute("SELECT recipients FROM messages WHERE id=?",
                         (sent.get("message_id"),)).fetchone()
        recipients = json.loads(row["recipients"] if row else "[]")
    finally:
        db.close()
    check("ordinary inbox reply is server-scoped to the latest DM sender",
          recipients == [operator_id])

    other_history = json.loads(srv.nth_history(
        AGENT_INBOX_CHANNEL, member_id="ag_other", last_n=50))
    bodies = [m.get("content") for m in other_history.get("messages", [])]
    check("another inbox agent cannot read the private reply", "private answer" not in bodies)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
