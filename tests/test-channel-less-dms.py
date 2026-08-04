"""P3 Unit 1: DMs are global, inbox-backed messages.

An agent's topic placement is deliberately unrelated to its DM capability.
This covers MCP writes, cross-topic replies, global recipient resolution,
inbox membership, and the operator web send/reply path.
"""

import json
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
import nth_server as srv  # noqa: E402
import nth_web as web  # noqa: E402
import nth_monitor as monitor_mod  # noqa: E402
from nth_constants import AGENT_INBOX_CHANNEL, parse_recipients  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + f": {name}")
    if not condition:
        failures.append(name)


def parse(value):
    return json.loads(value) if isinstance(value, str) else value


def poll(channel, member_id):
    result = parse(srv.nth_poll(channel=channel, member_id=member_id,
                                wait_seconds=0))
    return result.get("messages", []) if result.get("event") == "new_messages" else []


tmp = tempfile.mkdtemp(prefix="nth-channel-less-dms-")
srv.DB_DIR = Path(tmp)
srv.DB_PATH = Path(tmp) / "nth.db"

try:
    a = parse(srv.nth_connect(summary="A", name="GlobalAlice", channel="topic-x"))
    b = parse(srv.nth_connect(summary="B", name="GlobalBob", channel="topic-y"))
    c = parse(srv.nth_connect(summary="C", name="GlobalCarol", channel="topic-z"))
    aid, bid, cid = a["member_id"], b["member_id"], c["member_id"]

    db = srv.get_db()
    try:
        inbox_ids = {r["id"] for r in db.execute(
            "SELECT id FROM members WHERE channel=?", (AGENT_INBOX_CHANNEL,)
        ).fetchall()}
    finally:
        db.close()
    check("every connected agent has inbox membership", {aid, bid, cid} <= inbox_ids)

    dm = parse(srv.nth_dm(member_id=aid, message="global hello", to="GlobalBob"))
    dm_id = dm.get("message_id")
    db = srv.get_db()
    try:
        row = db.execute(
            "SELECT channel, member_id, recipients FROM messages WHERE id=?",
            (dm_id,),
        ).fetchone()
    finally:
        db.close()
    check("trio_dm succeeds without a channel", dm.get("ok") is True)
    check("DM is stored in the global inbox", row and row["channel"] == AGENT_INBOX_CHANNEL)
    check("global name resolution reaches another topic", row and parse_recipients(row["recipients"]) == [bid])
    check("recipient sees DM in inbox", dm_id in {m["id"] for m in poll(AGENT_INBOX_CHANNEL, bid)})
    check("recipient does not see DM in topic Y", dm_id not in {m["id"] for m in poll("topic-y", bid)})
    check("non-recipient does not see DM in inbox", dm_id not in {m["id"] for m in poll(AGENT_INBOX_CHANNEL, cid)})

    reply = parse(srv.nth_send(channel="topic-y", member_id=bid,
                               message="global reply", reply_to=dm_id))
    reply_id = reply.get("message_id")
    db = srv.get_db()
    try:
        reply_row = db.execute(
            "SELECT channel, recipients FROM messages WHERE id=?", (reply_id,)
        ).fetchone()
    finally:
        db.close()
    check("topic reply to DM succeeds", reply.get("ok") is True)
    check("DM reply stays in inbox", reply_row and reply_row["channel"] == AGENT_INBOX_CHANNEL)
    check("DM reply remains private", reply_row and parse_recipients(reply_row["recipients"]) == [aid])
    check("sender sees reply in inbox", reply_id in {m["id"] for m in poll(AGENT_INBOX_CHANNEL, aid)})
    intrude = parse(srv.nth_send(channel="topic-z", member_id=cid,
                                 message="should fail", reply_to=dm_id))
    check("non-participant cannot reply into DM", "error" in intrude)

    # Operator web send from a topic URL must use the same global transport.
    web.NthWebHandler._default_channel = "topic-x"
    web.NthWebHandler.db_path = srv.DB_PATH
    httpd = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.1)
    port = httpd.server_address[1]

    def post(body):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/send?channel=topic-x",
            data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            return exc.code, {}

    status, web_out = post({"content": "operator global hello", "recipients": [bid]})
    web_id = web_out.get("id")
    db = srv.get_db()
    try:
        web_row = db.execute(
            "SELECT channel, recipients FROM messages WHERE id=?", (web_id,)
        ).fetchone()
    finally:
        db.close()
    check("web DM send accepted", status == 200)
    check("web DM is stored in inbox", web_row and web_row["channel"] == AGENT_INBOX_CHANNEL)
    check("web DM recipient sees inbox message", web_id in {m["id"] for m in poll(AGENT_INBOX_CHANNEL, bid)})
    check("web DM is absent from topic Y", web_id not in {m["id"] for m in poll("topic-y", bid)})

    status, web_reply = post({"content": "operator reply", "reply_to": web_id})
    web_reply_id = web_reply.get("id")
    db = srv.get_db()
    try:
        web_reply_row = db.execute(
            "SELECT channel, recipients FROM messages WHERE id=?", (web_reply_id,)
        ).fetchone()
    finally:
        db.close()
    check("web DM reply accepted", status == 200)
    check("web DM reply is stored in inbox", web_reply_row and web_reply_row["channel"] == AGENT_INBOX_CHANNEL)
    check("web DM reply remains scoped", web_reply_row and bid in parse_recipients(web_reply_row["recipients"]))
    httpd.shutdown()

    # A real inbox monitor wakes the recipient even though its public work is
    # in topic-y; a non-recipient advances past the hidden row without a wake.
    monitor_events = {"monitor-b": [], "monitor-c": []}
    monitor_woke = threading.Event()
    original_emit = monitor_mod.emit

    def capture_monitor_event(event):
        name = threading.current_thread().name
        if name in monitor_events:
            monitor_events[name].append(event)
            if name == "monitor-b" and event.get("event") == "new_messages":
                monitor_woke.set()

    monitor_mod.emit = capture_monitor_event
    monitor_b = threading.Thread(
        target=monitor_mod.monitor,
        args=(AGENT_INBOX_CHANNEL, bid, "at"),
        kwargs={"_db_path": srv.DB_PATH}, name="monitor-b", daemon=True)
    monitor_c = threading.Thread(
        target=monitor_mod.monitor,
        args=(AGENT_INBOX_CHANNEL, cid, "at"),
        kwargs={"_db_path": srv.DB_PATH}, name="monitor-c", daemon=True)
    monitor_b.start()
    monitor_c.start()
    time.sleep(0.2)
    wake_dm = parse(srv.nth_dm(member_id=aid, message="wake inbox", to="GlobalBob"))
    check("inbox monitor wakes cross-topic recipient", monitor_woke.wait(3))
    check("inbox monitor flags the wake as a DM",
          any(e.get("has_dms") for e in monitor_events["monitor-b"]
              if e.get("event") == "new_messages"))
    time.sleep(0.2)
    check("inbox monitor does not wake non-recipient",
          not any(e.get("event") == "new_messages" for e in monitor_events["monitor-c"]))
    db = srv.get_db()
    try:
        db.execute("UPDATE channels SET status='ended' WHERE code=?",
                   (AGENT_INBOX_CHANNEL,))
        db.commit()
    finally:
        db.close()
    monitor_b.join(2)
    monitor_c.join(2)
    monitor_mod.emit = original_emit
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
