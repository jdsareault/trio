"""Tests for REAL private DMs — the member-aware visibility engine.

Covers the locked design:
  (a) a recipient sees a DM via trio_poll and trio_history
  (b) a NON-recipient does NOT see it via poll, history, pounds, the SSE
      message event, AND the monitor unread query
  (c) the operator (kind != 'agent' / _op_ id) is all-seeing — sees every DM
  (d) broadcasts still reach everyone (no regression)
  (e) a hidden DM still advances the non-recipient's watermark (not re-surfaced)
  + the dashboard /api/send DM path stores recipients and the server enforces it.

Usage: python tests/test-dms.py
"""
import json
import tempfile
import threading
import time
import urllib.error
import urllib.request
import shutil
import sqlite3
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv          # noqa: E402
import nth_web as web            # noqa: E402
from nth_constants import can_see  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_dms_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def poll_ids(member_id, contents=None):
    """Return (ids, contents) of messages a member sees on a 0-wait poll."""
    r = json.loads(srv.nth_poll(channel=CH, member_id=member_id, wait_seconds=0))
    msgs = r.get("messages", []) if r.get("event") == "new_messages" else []
    return [m["id"] for m in msgs], [m["content"] for m in msgs]


def history_ids(member_id=""):
    r = json.loads(srv.nth_history(channel=CH, last_n=100, member_id=member_id))
    return [m["id"] for m in r.get("messages", [])]


def watermark(member_id):
    db = srv.get_db()
    try:
        row = db.execute(
            "SELECT last_read FROM members WHERE channel=? AND id=?",
            (CH, member_id)).fetchone()
        return row["last_read"] if row else None
    finally:
        db.close()


def dm_row(msg_id):
    db = srv.get_db()
    try:
        return db.execute(
            "SELECT member_id, recipients, mentions FROM messages WHERE id=?",
            (msg_id,)).fetchone()
    finally:
        db.close()


# ── Roster: Alice (sender), Bob (recipient), Carol (non-recipient) ──
A = json.loads(srv.nth_connect(summary="a", name="Alice", channel="dmtest"))
CH = A["channel"]
alice = A["member_id"]
bob = json.loads(srv.nth_connect(summary="b", name="Bob", channel=CH))["member_id"]
carol = json.loads(srv.nth_connect(summary="c", name="Carol", channel=CH))["member_id"]

# Everyone reads the channel up to now so join chatter doesn't confound polls.
srv.nth_poll(channel=CH, member_id=bob, wait_seconds=0)
srv.nth_poll(channel=CH, member_id=carol, wait_seconds=0)

# ── Alice DMs Bob ──
dm = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="secret-for-bob", to="Bob"))
check("trio_dm: ok", dm.get("ok") is True)
check("trio_dm: recipients resolved to Bob", dm.get("recipients") == [bob])
DM_ID = dm["message_id"]
row = dm_row(DM_ID)
check("trio_dm: recipients stored on row", json.loads(row["recipients"]) == [bob])
check("trio_dm: recipient auto-added to ping set", bob in json.loads(row["mentions"] or "[]"))

# unresolved recipient is rejected (no silent broadcast)
bad = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="x", to="Nobody"))
check("trio_dm: unknown recipient rejected", "error" in bad)
# empty `to` rejected
bad2 = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="x", to=""))
check("trio_dm: empty `to` rejected", "error" in bad2)

# (a) recipient sees the DM via poll + history
bob_ids, bob_contents = poll_ids(bob)
check("(a) recipient sees DM via poll", DM_ID in bob_ids)
check("(a) recipient poll carries DM body", "secret-for-bob" in bob_contents)
check("(a) recipient sees DM via history", DM_ID in history_ids(bob))

# (b) non-recipient does NOT see the DM
carol_ids, carol_contents = poll_ids(carol)
check("(b) non-recipient does NOT see DM via poll", DM_ID not in carol_ids)
check("(b) non-recipient poll has no DM body", "secret-for-bob" not in carol_contents)
check("(b) non-recipient does NOT see DM via history (with id)", DM_ID not in history_ids(carol))
check("(b) unidentified history sees broadcasts only (no DM)", DM_ID not in history_ids(""))

# (b) pounds: a #ref to a non-recipient inside a DM must not surface it.
#     Alice DMs Bob but #references Carol — Carol must NOT see it via pounds.
dm2 = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="re #Carol, tell nobody", to="Bob"))
DM2_ID = dm2["message_id"]
carol_pounds = json.loads(srv.nth_pounds(channel=CH, member_id=carol))
check("(b) non-recipient does NOT see referenced DM via pounds",
      DM2_ID not in [m["id"] for m in carol_pounds.get("messages", [])])
# Bob (a recipient) who is #referenced would see it; sanity: Bob referenced?
dm3 = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="hey #Bob look", to="Bob"))
DM3_ID = dm3["message_id"]
bob_pounds = json.loads(srv.nth_pounds(channel=CH, member_id=bob))
check("(b) recipient DOES see their referenced DM via pounds",
      DM3_ID in [m["id"] for m in bob_pounds.get("messages", [])])

# (b) SSE message event carries recipients (real data) and the predicate the
#     delivery paths use withholds the DM from Carol. The dashboard itself is
#     the operator's all-seeing surface, so its live feed ships every row; the
#     recipients field is what makes the DM tab a REAL (server-backed) scope.
db = srv.get_db()
try:
    sse_row = db.execute(
        "SELECT id, member_id, member_name, content, mentions, refs, bangs, "
        "choices, selection, reply_to, recipients, retracted_at, retraction_reason, "
        "edited_at, created_at FROM messages WHERE id=?", (DM_ID,)).fetchone()
    ev = web._message_event(db, sse_row)
finally:
    db.close()
check("(b) SSE event carries recipients", ev.get("recipients") == [bob])
check("(b) predicate over SSE row withholds DM from non-recipient",
      can_see(carol, "agent", ev["member_id"], json.dumps(ev["recipients"])) is False)
check("(b) predicate over SSE row admits DM for recipient",
      can_see(bob, "agent", ev["member_id"], json.dumps(ev["recipients"])) is True)

# (b) monitor unread query: replicate exactly what nth_monitor does — pull
#     unread (member_id != self) then filter by can_see — and confirm Carol's
#     relevant set never contains the DM (its preview would otherwise leak).
def monitor_visible(member_id):
    db = srv.get_db()
    try:
        rows = db.execute(
            "SELECT id, mentions, refs, bangs, recipients, member_id, member_name, content "
            "FROM messages WHERE channel=? AND id>0 AND member_id!=? ORDER BY id",
            (CH, member_id)).fetchall()
    finally:
        db.close()
    return [m["id"] for m in rows
            if can_see(member_id, "agent", m["member_id"], m["recipients"])]


check("(b) monitor query hides DM from non-recipient", DM_ID not in monitor_visible(carol))
check("(b) monitor query shows DM to recipient", DM_ID in monitor_visible(bob))

# (c) operator is all-seeing — sees every DM
now = srv.now_iso()
db = srv.get_db()
try:
    db.execute(
        "INSERT OR IGNORE INTO members (id, channel, name, summary, skills, last_seen, "
        "last_read, joined_at, active, kind) VALUES (?,?,?,?,'',?,0,?,1,'human')",
        ("_op_test", CH, "Operator", "op", now, now))
    db.commit()
finally:
    db.close()
op_hist = history_ids("_op_test")
check("(c) operator sees DM #1 via history", DM_ID in op_hist)
check("(c) operator sees DM #2 via history", DM2_ID in op_hist)
check("(c) operator predicate is all-seeing (kind=human)",
      can_see("_op_test", "human", alice, json.dumps([bob])) is True)
check("(c) operator predicate is all-seeing (_op_ id, kind absent)",
      can_see("_op_anything", None, alice, json.dumps([bob])) is True)

# (d) broadcasts still reach everyone (no regression)
bc = json.loads(srv.nth_send(channel=CH, member_id=alice, message="hello everyone"))
BC_ID = bc["message_id"]
check("(d) broadcast reaches recipient-set member Bob", BC_ID in poll_ids(bob)[0])
check("(d) broadcast reaches non-recipient Carol", BC_ID in poll_ids(carol)[0])
check("(d) broadcast in unidentified history", BC_ID in history_ids(""))
check("(d) empty recipients = broadcast in predicate",
      can_see(carol, "agent", alice, "[]") is True
      and can_see(carol, "agent", alice, "") is True
      and can_see(carol, "agent", alice, None) is True)

# (e) the hidden DM advanced Carol's watermark and does not re-surface
#     (Carol polled above, which auto-acks past the raw batch incl. the DM).
wm = watermark(carol)
check("(e) hidden DM advanced non-recipient watermark past it", wm is not None and wm >= DM_ID)
carol_again, _ = poll_ids(carol)
check("(e) hidden DM does not re-surface on next poll", DM_ID not in carol_again)

# ── Dashboard path: operator /api/send with recipients=[bob] is a real DM ──
hub = web.EventHub(srv.DB_PATH, CH)
server = None
try:
    hub.start()
    web.NthWebHandler.hub = hub
    web.NthWebHandler.channel = CH
    web.NthWebHandler.db_path = srv.DB_PATH
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    data = json.dumps({"content": "web dm to bob", "recipients": [bob]}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/send", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            st, out = resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        st, out = e.code, {}
    if st != 200:
        check("web DM: loopback send accepted", False)
    else:
        WEB_DM = out["id"]
        wr = dm_row(WEB_DM)
        check("web DM: recipients stored", json.loads(wr["recipients"]) == [bob])
        check("web DM: recipient Bob sees it via poll", WEB_DM in poll_ids(bob)[0])
        check("web DM: non-recipient Carol does NOT see it via poll", WEB_DM not in poll_ids(carol)[0])
        # invalid recipients payload → 400
        bad = json.dumps({"content": "x", "recipients": [123]}).encode()
        rq = urllib.request.Request(f"http://127.0.0.1:{port}/api/send", data=bad, method="POST")
        rq.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(rq, timeout=5) as r2:
                bst = r2.status
        except urllib.error.HTTPError as e:
            bst = e.code
        check("web DM: non-string recipient -> 400", bst == 400)
except OSError as e:
    check("web DM: server started", False)
    print(f"  (server error: {e})")
finally:
    if server is not None:
        server.shutdown()
    hub.stop()

shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
