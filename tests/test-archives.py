#!/usr/bin/env python3
"""Reversible channel archives and per-operator DM archive watermarks."""
import http.cookiejar
import json
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv  # noqa: E402
import nth_web as web  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + ": " + name)
    if not condition:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth_archives_"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
json.loads(srv.nth_connect(summary="archive test", name="Seed", channel="keep-room"))
json.loads(srv.nth_connect(summary="archive test", name="Seed", channel="archive-room"))

web.NthWebHandler._default_channel = ""
web.NthWebHandler.db_path = srv.DB_PATH
web._DB_PATH_GLOBAL = srv.DB_PATH

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def http(port, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with opener.open(req, timeout=8) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode())
        except Exception:
            return exc.code, {}


def codes(payload):
    return {item.get("code") for item in payload.get("channels", [])}


server = None
try:
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.15)

    st, meta = http(port, "/api/meta?channel=keep-room")
    operator_id = meta.get("operator", {}).get("id")
    check("loopback operator identity is established", st == 200 and bool(operator_id))

    st, active = http(port, "/api/channels")
    check("active channel list initially includes archive target",
          st == 200 and "archive-room" in codes(active))
    st, archived = http(port, "/api/channels?archived=1")
    check("archive channel list initially excludes active target",
          st == 200 and "archive-room" not in codes(archived))

    st, result = http(port, "/api/archives", "POST", {
        "kind": "channel", "key": "archive-room", "archived": True})
    check("channel can be archived", st == 200 and result.get("archived") is True)
    _, active = http(port, "/api/channels")
    _, archived = http(port, "/api/channels?archived=1")
    check("archived channel leaves the main list", "archive-room" not in codes(active))
    check("archived channel appears in archive browser data",
          "archive-room" in codes(archived))

    st, result = http(port, "/api/archives", "POST", {
        "kind": "channel", "key": "archive-room", "archived": False})
    _, active = http(port, "/api/channels")
    check("channel can be restored", st == 200 and result.get("archived") is False
          and "archive-room" in codes(active))

    peer_id = "ag_archive_peer"
    db = sqlite3.connect(str(srv.DB_PATH))
    db.execute(
        "INSERT INTO agents (id,name,model,state,managed,created_at) "
        "VALUES (?, 'Archive Peer', 'sonnet', 'sleeping', 1, ?)",
        (peer_id, srv.now_iso()))
    db.execute(
        "INSERT INTO messages "
        "(channel,member_id,member_name,content,recipients,created_at) "
        "VALUES ('keep-room',?, 'Archive Peer','first DM',?,?)",
        (peer_id, json.dumps([operator_id]), srv.now_iso()))
    db.commit()
    db.close()

    st, inbox = http(port, "/api/dms")
    check("active DM inbox initially contains peer",
          st == 200 and peer_id in {item.get("key") for item in inbox.get("your_dms", [])})
    st, result = http(port, "/api/archives", "POST", {
        "kind": "dm", "key": peer_id, "archived": True})
    check("DM can be archived", st == 200 and result.get("archived") is True)
    _, inbox = http(port, "/api/dms")
    _, archive_inbox = http(port, "/api/dms?archived=1")
    check("archived DM leaves the main inbox",
          peer_id not in {item.get("key") for item in inbox.get("your_dms", [])})
    check("archived DM appears in archive browser data",
          peer_id in {item.get("key") for item in archive_inbox.get("your_dms", [])})
    _, hidden_history = http(port, "/api/dms?with=" + urllib.parse.quote(peer_id))
    _, archived_history = http(
        port, "/api/dms?archived=1&with=" + urllib.parse.quote(peer_id))
    check("archived DM history is hidden from active mode",
          hidden_history.get("messages") == [])
    check("archived DM history remains viewable in archive mode",
          [item.get("content") for item in archived_history.get("messages", [])] == ["first DM"])

    # A new message above the archive watermark automatically resurfaces the
    # thread, avoiding a hidden unread conversation.
    db = sqlite3.connect(str(srv.DB_PATH))
    db.execute(
        "INSERT INTO messages "
        "(channel,member_id,member_name,content,recipients,created_at) "
        "VALUES ('keep-room',?, 'Archive Peer','new DM',?,?)",
        (peer_id, json.dumps([operator_id]), srv.now_iso()))
    db.commit()
    db.close()
    _, inbox = http(port, "/api/dms")
    check("new DM automatically resurfaces an archived thread",
          peer_id in {item.get("key") for item in inbox.get("your_dms", [])})

    # Re-archive at the new watermark, then restore explicitly.
    http(port, "/api/archives", "POST", {
        "kind": "dm", "key": peer_id, "archived": True})
    st, result = http(port, "/api/archives", "POST", {
        "kind": "dm", "key": peer_id, "archived": False})
    _, inbox = http(port, "/api/dms")
    check("DM can be restored", st == 200 and result.get("archived") is False
          and peer_id in {item.get("key") for item in inbox.get("your_dms", [])})

    st, _ = http(port, "/api/archives", "POST", {
        "kind": "folder", "key": "x", "archived": True})
    check("unknown archive kind is rejected", st == 400)
    st, _ = http(port, "/api/archives", "POST", {
        "kind": "dm", "key": "missing", "archived": True})
    check("unknown DM thread is rejected", st == 404)
    st, _ = http(port, "/api/archives", "POST", {
        "kind": "channel", "key": web.AGENT_INBOX_CHANNEL, "archived": True})
    check("internal agent inbox cannot be archived", st == 400)
finally:
    if server is not None:
        server.shutdown()
    web.stop_all_runtimes()
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
