"""Tests for the operator-adjustable wake filter endpoint (POST
/api/member/<id>/filter). Feature #4 — the write side of the wake filter the
monitor reads from members.filter_mode each tick.

Live loopback (trusted operator): setting a valid mode updates the column;
invalid modes / bodies are rejected 400; an unknown member is 404; and each of
all/about/at round-trips into the DB.
Usage: python tests/test-web-filter.py
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


_tmp = tempfile.mkdtemp(prefix="nth_filter_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def http(port, path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def filter_mode(mid):
    db = srv.get_db()
    try:
        r = db.execute("SELECT filter_mode FROM members WHERE id=?", (mid,)).fetchone()
        return r["filter_mode"] if r else None
    finally:
        db.close()


r = json.loads(srv.nth_connect(summary="t", name="Worker", channel="filtertest"))
CH, agent = r["channel"], r["member_id"]

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

    base = f"/api/member/{agent}/filter"

    # Probe: is loopback trusted here? A trusted operator send is the same gate.
    st, _ = http(port, "/api/send", {"content": "probe"})
    if st != 200:
        skip("web filter", f"loopback not trusted here ({st})")
    else:
        # Valid mode → 200 and the column is updated.
        st, resp = http(port, base, {"filter_mode": "at"})
        check("set 'at' accepted", st == 200 and resp.get("filter_mode") == "at")
        check("set 'at' persisted to DB", filter_mode(agent) == "at")

        # Every valid mode round-trips.
        for mode in ("all", "about", "at"):
            st, _ = http(port, base, {"filter_mode": mode})
            check(f"set '{mode}' accepted", st == 200)
            check(f"set '{mode}' persisted", filter_mode(agent) == mode)

        # Invalid mode → 400 and the column is NOT changed (still 'at' from last loop).
        st, _ = http(port, base, {"filter_mode": "bogus"})
        check("invalid mode rejected 400", st == 400)
        check("invalid mode did not change the column", filter_mode(agent) == "at")

        # Non-string / missing filter_mode → 400.
        for bad in (None, 123, ["at"], {"x": 1}, True):
            st, _ = http(port, base, {"filter_mode": bad})
            check(f"non-string mode {bad!r} -> 400", st == 400)
        st, _ = http(port, base, {})
        check("missing filter_mode -> 400", st == 400)

        # Unknown member id → 404 (valid mode, but no such row).
        st, _ = http(port, "/api/member/nope-not-a-member/filter", {"filter_mode": "all"})
        check("unknown member -> 404", st == 404)

        # A valid mode on the real member still works after the error cases.
        st, _ = http(port, base, {"filter_mode": "about"})
        check("recovers after errors — set 'about'", st == 200 and filter_mode(agent) == "about")
except OSError as e:
    skip("web filter", f"could not start server: {e}")
finally:
    if server is not None:
        server.shutdown()
    hub.stop()

shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s), {len(skips)} skip(s)")
sys.exit(1 if failures else 0)
