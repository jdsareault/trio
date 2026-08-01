#!/usr/bin/env python3
"""bugs/2026-08-01-private-fallback-reply-wrong-recipient.md: a plain
(non-Trio-tool) result must bridge to the SENDER of the message it was fed to
answer, not to whoever most recently DM'd the agent's inbox.

Regression scenario: Alice's private question is fed to the agent. Before the
agent's plain result comes back, Bob's later question is fed too (queued
behind Alice's turn). The result answering Alice's turn must still go to
Alice, even though Bob's message is now the newest inbox DM.
"""
import collections
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
import nth_server as srv  # noqa: E402
import nth_supervisor as sup  # noqa: E402
from nth_constants import AGENT_INBOX_CHANNEL  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + ": " + name)
    if not condition:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth_fallback_recipient_"))
db_path = tmp / "nth.db"
agent_id = "ag_fallback"
alice_id = "_op_l_alice"
bob_id = "_op_l_bob"

db = srv.get_db(db_path)
now = srv.now_iso()
db.execute("INSERT INTO channels (code,status,created_at,updated_at) VALUES (?,'active',?,?)",
           (AGENT_INBOX_CHANNEL, now, now))
db.execute("INSERT INTO agents (id,name,model,state,managed,created_at) "
           "VALUES (?, 'Fallback Agent', 'sonnet', 'stopped', 1, ?)", (agent_id, now))
for mid, name in ((agent_id, "Fallback Agent"), (alice_id, "Alice"), (bob_id, "Bob")):
    kind = "agent" if mid == agent_id else "human"
    db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,joined_at,active,kind) "
               "VALUES (?,?,?,'','',?,?,1,?)", (mid, AGENT_INBOX_CHANNEL, name, now, now, kind))
db.execute("INSERT INTO messages (channel,member_id,member_name,content,recipients,created_at) "
           "VALUES (?,?,?,?,?,?)",
           (AGENT_INBOX_CHANNEL, alice_id, "Alice", "Alice's question",
            json.dumps([agent_id]), now))
alice_msg_id = db.execute("SELECT MAX(id) FROM messages").fetchone()[0]
db.commit()
db.close()

manager = sup.AgentSupervisor(db_path=db_path)
try:
    baseline = db_path and sqlite3.connect(str(db_path)).execute(
        "SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0]

    # Simulate the router queuing Alice's turn (as the fixed feed() now does,
    # carrying the source message id/sender), WITHOUT actually spawning a
    # process — we drive _bridge_result directly against the two contexts to
    # isolate the recipient-selection logic from process timing.
    manager._pending[agent_id] = collections.deque([
        {"channel": AGENT_INBOX_CHANNEL, "baseline": baseline,
         "source_message_id": alice_msg_id, "source_sender": alice_id},
    ])

    # Bob's later question arrives and is inserted into the inbox BEFORE
    # Alice's plain result is bridged — this is the newest DM in the table.
    db = sqlite3.connect(str(db_path))
    db.execute("INSERT INTO messages (channel,member_id,member_name,content,recipients,created_at) "
               "VALUES (?,?,?,?,?,?)",
               (AGENT_INBOX_CHANNEL, bob_id, "Bob", "Bob's later question",
                json.dumps([agent_id]), srv.now_iso()))
    db.commit()
    db.close()

    manager._bridge_result(agent_id, {
        "type": "result", "is_error": False, "result": "answer intended for Alice"})

    db = sqlite3.connect(str(db_path)); db.row_factory = sqlite3.Row
    reply = db.execute(
        "SELECT * FROM messages WHERE channel=? AND member_id=? ORDER BY id DESC LIMIT 1",
        (AGENT_INBOX_CHANNEL, agent_id)).fetchone()
    db.close()
    check("plain result was bridged", reply is not None)
    check("reply recipients is Alice, not Bob (the newest DM sender)",
          reply is not None and json.loads(reply["recipients"]) == [alice_id])
finally:
    manager.shutdown()

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
