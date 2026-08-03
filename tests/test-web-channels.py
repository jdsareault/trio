"""Tests for the multi-channel hub: /api/channels, per-request ?channel=
resolution, the _authorize_channel guard (existence + operator/guest scoping),
and cross-channel data isolation.

Unlike the older web tests (test-search/cull/...), this one does NOT pin
web.NthWebHandler.channel to a fixed string — that would replace the per-request
`channel` property and bypass exactly what we want to test. It drives the real
?channel= resolution path. Usage: python tests/test-web-channels.py
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

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv    # noqa: E402
import nth_web as web       # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_chan_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def http(port, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


# Two real channels with distinct messages.
ra = json.loads(srv.nth_connect(summary="t", name="Aa", channel="chan-a"))
srv.nth_send(channel="chan-a", member_id=ra["member_id"], message="alpha-only-msg")
rb = json.loads(srv.nth_connect(summary="t", name="Bb", channel="chan-b"))
srv.nth_send(channel="chan-b", member_id=rb["member_id"], message="beta-only-msg")

# Multi-channel mode: no default channel pinned; both path sources point at the
# temp DB so the guard (self.db_path) and the runtime registry (_DB_PATH_GLOBAL)
# agree.
web.NthWebHandler._default_channel = ""
web.NthWebHandler.db_path = srv.DB_PATH
web._DB_PATH_GLOBAL = srv.DB_PATH

server = None
try:
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    # /api/channels lists both (loopback = operator = all-seeing).
    st, d = http(port, "/api/channels")
    codes = {c["code"] for c in d.get("channels", [])}
    check("/api/channels: 200 for operator", st == 200 and d.get("ok"))
    check("/api/channels: lists both channels", {"chan-a", "chan-b"} <= codes)

    # Unread count: chan-a has a [joined] message + alpha-only-msg, both
    # authored by Aa (never marked read by the operator) — /api/channels
    # should report both, and marking them read should zero it out.
    # Regression check for a badge that existed in the UI but always rendered
    # empty because the API never sent the field.
    import sqlite3 as _sqlite3
    _db = _sqlite3.connect(str(srv.DB_PATH))
    chan_a_ids = [r[0] for r in
                  _db.execute("SELECT id FROM messages WHERE channel='chan-a'")]
    _db.close()
    by_code = {c["code"]: c for c in d.get("channels", [])}
    check("/api/channels: chan-a starts with all its messages unread",
          by_code.get("chan-a", {}).get("unread") == len(chan_a_ids))
    check("/api/channels: chan-a has unread > 0 to begin with",
          by_code.get("chan-a", {}).get("unread", 0) > 0)

    # A private DM into chan-a must NOT inflate the channel's unread badge —
    # DMs have their own separate unread mechanism (dms.your_dms[].unread).
    # Cc joins first (that [joined] broadcast is expected to count) so the
    # DM sent after is the only variable being isolated.
    rc = json.loads(srv.nth_connect(summary="t", name="Cc", channel="chan-a"))
    st, d = http(port, "/api/channels")
    by_code = {c["code"]: c for c in d.get("channels", [])}
    unread_before_dm = by_code.get("chan-a", {}).get("unread")
    srv.nth_dm(channel="chan-a", member_id=ra["member_id"],
               message="alpha-private-dm", to=rc["member_id"])
    st, d = http(port, "/api/channels")
    by_code = {c["code"]: c for c in d.get("channels", [])}
    check("/api/channels: a DM into chan-a does not inflate its unread count",
          by_code.get("chan-a", {}).get("unread") == unread_before_dm)
    chan_a_ids = [r[0] for r in
                  _sqlite3.connect(str(srv.DB_PATH)).execute(
                      "SELECT id FROM messages WHERE channel='chan-a' "
                      "AND (recipients IS NULL OR recipients='' OR recipients='[]')")]

    st, d = http(port, "/api/messages/mark-read", method="POST",
                 body={"ids": chan_a_ids})
    check("mark-read: 200", st == 200)
    st, d = http(port, "/api/channels")
    by_code = {c["code"]: c for c in d.get("channels", [])}
    check("/api/channels: marking every message read drops chan-a to 0",
          by_code.get("chan-a", {}).get("unread") == 0)
    check("/api/channels: chan-b unread is untouched by marking chan-a read",
          by_code.get("chan-b", {}).get("unread", 0) > 0)

    # Per-request scoping: tasks/search read only the requested channel.
    st, d = http(port, "/api/tasks?channel=chan-a")
    check("tasks?channel=chan-a: scoped + 200", st == 200 and d.get("channel") == "chan-a")

    st, d = http(port, "/api/search?channel=chan-a&q=alpha-only")
    hitsA = [x["content"] for x in d.get("results", [])]
    check("search on chanA finds chanA message", "alpha-only-msg" in hitsA)
    st, d = http(port, "/api/search?channel=chan-a&q=beta-only")
    check("search on chanA does NOT leak chanB message (isolation)",
          d.get("count") == 0)

    # Bogus channel: 404 on read AND write, and no orphan rows written.
    st, _ = http(port, "/api/tasks?channel=__ghost__")
    check("read bogus channel -> 404", st == 404)
    st, _ = http(port, "/api/send?channel=__ghost__", method="POST",
                 body={"content": "should be rejected"})
    check("write bogus channel -> 404", st == 404)
    db = __import__("sqlite3").connect(str(srv.DB_PATH))
    orphan_m = db.execute("SELECT COUNT(*) FROM messages WHERE channel='__ghost__'").fetchone()[0]
    orphan_mem = db.execute("SELECT COUNT(*) FROM members WHERE channel='__ghost__'").fetchone()[0]
    db.close()
    check("no orphan message/member rows for bogus channel",
          orphan_m == 0 and orphan_mem == 0)

    # Guest confinement: with a non-all-seeing identity, only the default channel
    # is reachable. Monkeypatch is_all_seeing (loopback always resolves operator
    # otherwise) and pin a default channel.
    _orig = web.is_all_seeing
    web.is_all_seeing = lambda mid: False
    web.NthWebHandler._default_channel = "chan-a"
    try:
        st, _ = http(port, "/api/tasks?channel=chan-b")
        check("guest confined: non-default channel -> 403", st == 403)
        st, d = http(port, "/api/tasks?channel=chan-a")
        check("guest allowed: default channel -> 200", st == 200)
        st, _ = http(port, "/api/channels")
        check("guest: /api/channels -> 403 (operator only)", st == 403)
    finally:
        web.is_all_seeing = _orig
        web.NthWebHandler._default_channel = ""
finally:
    if server is not None:
        server.shutdown()
    web.stop_all_runtimes()

shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
