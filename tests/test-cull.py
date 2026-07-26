"""Tests for removing a channel participant from the web dashboard (/api/cull).

Live loopback round-trip: an operator removes a member; their claimed task is
released back to open, a [culled] message is posted, and self / unknown targets
are rejected. Drives the real nth_web server + nth_server DB logic.

Usage: python tests/test-cull.py
"""
import json
import tempfile
import threading
import time
import urllib.error
import urllib.request
import shutil
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv    # noqa: E402
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


_tmp = tempfile.mkdtemp(prefix="nth_cull_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def connect(name, channel=""):
    r = json.loads(srv.nth_connect(summary="t", name=name, channel=channel))
    return r["channel"], r["member_id"]


def http(port, path, method="GET", body=None):
    url = f"http://127.0.0.1:{port}{path}"
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


# ── unit: cull_member helper against an in-memory-ish real DB ────────────────
CH, asker = connect("Asker", channel="culltest")
_ch, victim = connect("Victim", channel=CH)
# Give the victim a claimed task so we can prove it gets released.
t = json.loads(srv.nth_send(channel=CH, member_id=asker, message="do a thing", task=True))
task_id = t["task_id"]
json.loads(srv.nth_claim(channel=CH, member_id=victim, task_id=task_id))

db = srv.get_db()
try:
    res, err = web.cull_member(db, CH, asker, "Asker", victim)
    db.commit()
    check("cull_member: ok", err is None and res and res["culled_id"] == victim)
    check("cull_member: released the claimed task", res and res["released_tasks"] == [task_id])
    gone = db.execute("SELECT 1 FROM members WHERE id=? AND channel=?", (victim, CH)).fetchone()
    check("cull_member: member row deleted", gone is None)
    tstatus = db.execute("SELECT status, claimed_by FROM tasks WHERE id=?", (task_id,)).fetchone()
    check("cull_member: task back to open", tstatus["status"] == "open" and tstatus["claimed_by"] is None)
    culled_msg = db.execute(
        "SELECT 1 FROM messages WHERE channel=? AND content LIKE '[culled]%'", (CH,)).fetchone()
    check("cull_member: posts [culled] system message", culled_msg is not None)
    # self / unknown guards
    _r, e_self = web.cull_member(db, CH, asker, "Asker", asker)
    check("cull_member: self rejected", e_self is not None and "yourself" in e_self.lower())
    _r, e_unk = web.cull_member(db, CH, asker, "Asker", "nope")
    check("cull_member: unknown rejected", e_unk is not None and "not found" in e_unk.lower())
finally:
    db.close()


# ── live: /api/cull round-trip ───────────────────────────────────────────────
CH2, asker2 = connect("LiveAsker", channel="culltest2")
_ch, victim2 = connect("LiveVictim", channel=CH2)
hub = web.EventHub(srv.DB_PATH, CH2)
server = None
try:
    hub.start()
    web.NthWebHandler.hub = hub
    web.NthWebHandler.channel = CH2
    web.NthWebHandler.db_path = srv.DB_PATH
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    # First send creates the loopback operator (kind='human').
    st, _ = http(port, "/api/send", "POST", {"content": "hi"})
    if st != 200:
        skip("live cull", f"loopback send not accepted ({st})")
    else:
        db = srv.get_db()
        try:
            op = db.execute("SELECT id FROM members WHERE channel=? AND kind='human'",
                            (CH2,)).fetchone()
        finally:
            db.close()
        op_id = op["id"]

        # missing target
        st, _ = http(port, "/api/cull", "POST", {})
        check("live: missing target -> 400", st == 400)
        # unknown target
        st, _ = http(port, "/api/cull", "POST", {"target_member_id": "ghost"})
        check("live: unknown target -> 400", st == 400)
        # self
        st, _ = http(port, "/api/cull", "POST", {"target_member_id": op_id})
        check("live: self-cull -> 400", st == 400)
        # real removal
        st, resp = http(port, "/api/cull", "POST", {"target_member_id": victim2})
        check("live: cull accepted", st == 200 and resp.get("culled_id") == victim2)
        db = srv.get_db()
        try:
            gone = db.execute("SELECT 1 FROM members WHERE id=? AND channel=?",
                              (victim2, CH2)).fetchone()
        finally:
            db.close()
        check("live: member removed from roster", gone is None)
except OSError as e:
    skip("live cull", f"could not start server: {e}")
finally:
    if server is not None:
        server.shutdown()
    hub.stop()


shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s), {len(skips)} skip(s)")
sys.exit(1 if failures else 0)
