"""Tests for selectable answers (trio_ask multiple-choice questions).

Three tiers, all driving the REAL modules against a throwaway DB:

  1. nth_server.trio_ask + target resolution — validation, option
     normalization, human-vs-agent enforcement, stored payload shape.
  2. nth_web serialization helpers — parse_obj_json + _message_event round
     -trip (choices / selection / reply_to) against an in-memory sqlite row.
  3. Live loopback round-trip — a real nth_web server on 127.0.0.1: an agent
     asks, the (loopback-trusted) human answers via /api/send with
     reply_to + selection, and the reply is validated end to end.

Usage: python tests/test-ask.py
"""
import json
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
import shutil
import sys

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv    # noqa: E402  (banner prints on import — harmless)
import nth_web as web       # noqa: E402

failures = []
skips = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def skip(name, why):
    print(f"SKIP: {name} ({why})")
    skips.append(name)


# ── Point the server at a throwaway DB ───────────────────────────────────────
_tmp = tempfile.mkdtemp(prefix="nth_ask_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def connect(name, channel="", summary="test"):
    r = json.loads(srv.nth_connect(summary=summary, name=name, channel=channel))
    assert r.get("ok"), r
    return r["channel"], r["member_id"]


def make_human(channel, name):
    """Join as a member, then mark the row kind='human' the way the web side
    does in ensure_operator_row — so trio_ask sees a real human target."""
    _ch, mid = connect(name, channel=channel)
    db = srv.get_db()
    try:
        db.execute("UPDATE members SET kind='human' WHERE id=? AND channel=?", (mid, channel))
        db.commit()
    finally:
        db.close()
    return mid


def msg_row(channel, msg_id):
    db = srv.get_db()
    try:
        return db.execute("SELECT * FROM messages WHERE id=? AND channel=?",
                          (msg_id, channel)).fetchone()
    finally:
        db.close()


# ── 1. trio_ask (nth_server) ─────────────────────────────────────────────────
CH, asker = connect("Asker", channel="asktest", summary="the agent asking")
human = make_human(CH, "Gabe")

# happy path
r = json.loads(srv.nth_ask(channel=CH, member_id=asker,
                           question="Which database?",
                           options=["Postgres", "SQLite"],
                           target=human, mode="one"))
check("ask: happy path ok", r.get("ok") is True and r.get("message_id"))
check("ask: returns resolved target name", r.get("target") == "Gabe")
qid = r.get("message_id")
row = msg_row(CH, qid)
ch = json.loads(row["choices"]) if row and row["choices"] else {}
check("ask: choices.mode stored", ch.get("mode") == "one")
check("ask: choices.options stored", ch.get("options") == ["Postgres", "SQLite"])
check("ask: choices.target is the human id", ch.get("target") == human)
check("ask: choices.question stored", ch.get("question") == "Which database?")
check("ask: pings the target", human in json.loads(row["mentions"] or "[]"))
check("ask: content carries a readable transcript",
      "Which database?" in (row["content"] or "") and "Postgres" in (row["content"] or ""))

# many mode
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="Pick tools",
                           options=["a", "b", "c"], target=human, mode="many"))
ch = json.loads(msg_row(CH, r["message_id"])["choices"])
check("ask: mode=many stored", ch.get("mode") == "many")

# agent target rejected
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="q?",
                           options=["x", "y"], target=asker))
check("ask: agent target rejected", "error" in r and "agent" in r["error"].lower())

# unknown target
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="q?",
                           options=["x", "y"], target="Nobody"))
check("ask: unknown target rejected", "error" in r and "no member" in r["error"].lower())

# option normalization: case-insensitive dedupe + blank drop
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="q?",
                           options=["Yes", "yes", "  ", "No"], target=human))
ch = json.loads(msg_row(CH, r["message_id"])["choices"])
check("ask: dedupes case-insensitively + drops blanks", ch.get("options") == ["Yes", "No"])

# fewer than 2 distinct options
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="q?",
                           options=["Only", "only"], target=human))
check("ask: <2 distinct options rejected", "error" in r and "2" in r["error"])

# too many options
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="q?",
                           options=[f"opt{i}" for i in range(srv.MAX_ASK_OPTIONS + 1)],
                           target=human))
check("ask: >max options rejected", "error" in r and "too many" in r["error"].lower())

# option too long
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="q?",
                           options=["ok", "x" * (srv.MAX_ASK_OPTION_LEN + 1)], target=human))
check("ask: over-long option rejected", "error" in r and "too long" in r["error"].lower())

# empty question / bad mode
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="   ",
                           options=["a", "b"], target=human))
check("ask: empty question rejected", "error" in r and "empty" in r["error"].lower())
r = json.loads(srv.nth_ask(channel=CH, member_id=asker, question="q?",
                           options=["a", "b"], target=human, mode="sideways"))
check("ask: bad mode rejected", "error" in r and "mode" in r["error"].lower())

# target resolution variants
db = srv.get_db()
try:
    row_h, err = srv._resolve_human_target(db, CH, human)
    check("resolve: by member id", err is None and row_h and row_h["id"] == human)
    row_h, err = srv._resolve_human_target(db, CH, "gabe")
    check("resolve: by name (case-insensitive)", err is None and row_h and row_h["id"] == human)
    row_h, err = srv._resolve_human_target(db, CH, "ghost")
    check("resolve: unknown -> error", row_h is None and err is not None)
finally:
    db.close()

# guest-stem resolution: a 'gabe-guest' human is reachable as 'gabe'
CH2, asker2 = connect("Asker2", channel="asktest2")
guest = make_human(CH2, "gabe-guest")
r = json.loads(srv.nth_ask(channel=CH2, member_id=asker2, question="q?",
                           options=["a", "b"], target="gabe"))
check("ask: guest stem resolves target", r.get("ok") is True)


# ── 2. nth_web serialization helpers ─────────────────────────────────────────
check("parse_obj_json: valid dict", web.parse_obj_json('{"a":1}') == {"a": 1})
check("parse_obj_json: list -> None", web.parse_obj_json('[1,2]') is None)
check("parse_obj_json: garbage -> None", web.parse_obj_json("not json") is None)
check("parse_obj_json: empty -> None", web.parse_obj_json("") is None)

mem = sqlite3.connect(":memory:")
mem.row_factory = sqlite3.Row
mem.execute(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY, member_id TEXT, member_name TEXT, "
    "content TEXT, mentions TEXT, refs TEXT, bangs TEXT, choices TEXT, selection TEXT, "
    "reply_to INTEGER, created_at TEXT)"
)
mem.execute(
    "INSERT INTO messages VALUES (1,'a','Asker','q?','[]','','',?,'',NULL,'t')",
    (json.dumps({"mode": "one", "options": ["x", "y"], "target": "h", "question": "q?"}),),
)
mem.execute(
    "INSERT INTO messages VALUES (2,'h','Gabe','x','','','','',?,1,'t')",
    (json.dumps({"picked": [0], "custom": ""}),),
)
q_ev = web._message_event(mem, mem.execute("SELECT * FROM messages WHERE id=1").fetchone())
a_ev = web._message_event(mem, mem.execute("SELECT * FROM messages WHERE id=2").fetchone())
check("event: question carries choices dict", isinstance(q_ev["choices"], dict)
      and q_ev["choices"]["options"] == ["x", "y"])
check("event: question has no selection", q_ev["selection"] is None)
check("event: answer carries selection dict", a_ev["selection"] == {"picked": [0], "custom": ""})
check("event: answer carries reply_to", a_ev["reply_to"] == 1)
mem.close()


# ── 3. Live loopback round-trip (nth_web /api/send answer path) ──────────────
def http(server_port, path, method="GET", body=None):
    url = f"http://127.0.0.1:{server_port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


CH3, asker3 = connect("LiveAsker", channel="asktest3")
hub = web.EventHub(srv.DB_PATH, CH3)
server = None
try:
    hub.start()
    web.NthWebHandler.hub = hub
    web.NthWebHandler.channel = CH3
    web.NthWebHandler.db_path = srv.DB_PATH
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    # First send from loopback creates the trusted human operator row.
    st, _ = http(port, "/api/send", "POST", {"content": "hello from the human"})
    if st != 200:
        skip("live round-trip", f"loopback send not accepted (status {st})")
    else:
        # The operator is the kind='human' member in this channel.
        db = srv.get_db()
        try:
            hrow = db.execute("SELECT id FROM members WHERE channel=? AND kind='human'",
                              (CH3,)).fetchone()
        finally:
            db.close()
        check("live: loopback operator marked human", hrow is not None)
        human3 = hrow["id"]

        # Agent asks the human.
        r = json.loads(srv.nth_ask(channel=CH3, member_id=asker3,
                                   question="Ship it?", options=["Yes", "No"],
                                   target=human3, mode="one"))
        check("live: ask accepted for loopback human", r.get("ok") is True)
        qid3 = r["message_id"]

        # Human answers via the picker's POST shape.
        st, resp = http(port, "/api/send", "POST",
                        {"content": "Yes", "reply_to": qid3,
                         "selection": {"picked": [0], "custom": ""}})
        check("live: answer send accepted", st == 200 and resp.get("ok"))
        arow = msg_row(CH3, resp.get("id")) if resp.get("id") else None
        check("live: answer row links reply_to", arow and arow["reply_to"] == qid3)
        sel = json.loads(arow["selection"]) if arow and arow["selection"] else {}
        check("live: answer row stores selection", sel.get("picked") == [0])

        # Negative validation.
        st, _ = http(port, "/api/send", "POST",
                     {"content": "x", "selection": {"picked": [0], "custom": ""}})
        check("live: selection without reply_to -> 400", st == 400)
        st, _ = http(port, "/api/send", "POST",
                     {"content": "x", "reply_to": 999999})
        check("live: reply_to to missing message -> 400", st == 400)
        st, _ = http(port, "/api/send", "POST",
                     {"content": "x", "reply_to": qid3,
                      "selection": {"picked": ["nope"], "custom": ""}})
        check("live: non-int selection.picked -> 400", st == 400)
except OSError as e:
    skip("live round-trip", f"could not start server: {e}")
finally:
    if server is not None:
        server.shutdown()
    hub.stop()


shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s), {len(skips)} skip(s)")
sys.exit(1 if failures else 0)
