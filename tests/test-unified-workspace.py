#!/usr/bin/env python3
"""Workspace rail backend: channel creation + cross-channel DM aggregation."""
import http.cookiejar
import json
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv  # noqa: E402
import nth_web as web  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + ": " + name)
    if not cond:
        failures.append(name)


tmp = Path(tempfile.mkdtemp(prefix="nth_workspace_"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
json.loads(srv.nth_connect(summary="a", name="SeedA", channel="chan-a"))
json.loads(srv.nth_connect(summary="b", name="SeedB", channel="chan-b"))

aid = "ag_workspace"
now = srv.now_iso()
db = srv.get_db()
db.execute("INSERT INTO agents (id,name,model,state,managed,created_at) "
           "VALUES (?, 'Workspace Agent', 'sonnet', 'sleeping', 1, ?)", (aid, now))
for channel in ("chan-a", "chan-b"):
    db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,joined_at,active,kind) "
               "VALUES (?,?, 'Workspace Agent','','',?,?,1,'agent')", (aid, channel, now, now))
    db.execute("INSERT INTO agent_channels (agent_id,channel,member_id,joined_at) VALUES (?,?,?,?)",
               (aid, channel, aid, now))
web.ensure_agent_inboxes(db)
db.commit()
db.close()

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


server = None
try:
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.15)

    st, meta = http(port, "/api/meta?channel=chan-a")
    operator_id = meta.get("operator", {}).get("id")
    check("meta resolves the loopback operator", st == 200 and bool(operator_id))

    st, made = http(port, "/api/channels", "POST",
                    {"code": "fresh-room", "topic": "Ship the workspace"})
    check("POST /api/channels creates a channel", st == 201 and made.get("channel", {}).get("code") == "fresh-room")
    st, _ = http(port, "/api/channels", "POST", {"code": "fresh-room"})
    check("duplicate channel is a conflict", st == 409)
    st, _ = http(port, "/api/channels", "POST", {"code": "Bad channel"})
    check("invalid channel code is rejected", st == 400)
    st, _ = http(port, "/api/channels", "POST", {"code": web.AGENT_INBOX_CHANNEL})
    check("private agent inbox name is reserved", st == 400)
    st, listed = http(port, "/api/channels")
    check("private agent inbox is hidden from the channel list",
          st == 200 and web.AGENT_INBOX_CHANNEL not in
          {c.get("code") for c in listed.get("channels", [])})

    # Operator messages the same durable agent in two different placements.
    for channel, content in (("chan-a", "from operator A"), ("chan-b", "from operator B")):
        st, _ = http(port, f"/api/send?channel={channel}", "POST",
                     {"content": content, "recipients": [aid]})
        check(f"operator can DM agent in {channel}", st == 200)
    # Agent replies in both channels. These rows intentionally use the same
    # durable agent id, which is what the unified view groups above channels.
    db = sqlite3.connect(str(srv.DB_PATH))
    for channel, content in (("chan-a", "reply A"), ("chan-b", "reply B")):
        db.execute("INSERT INTO messages (channel,member_id,member_name,content,recipients,created_at) "
                   "VALUES (?,?,?,?,?,?)",
                   (channel, aid, "Workspace Agent", content, json.dumps([operator_id]), srv.now_iso()))
    db.commit()
    db.close()

    st, inbox = http(port, "/api/dms")
    threads = inbox.get("your_dms", [])
    check("unified inbox returns one thread for the agent across channels",
          st == 200 and len(threads) == 1 and threads[0].get("member_ids") == [aid])
    targets = {t["id"]: t for t in inbox.get("targets", [])}
    check("newly-created agent is directly DM-addressable from the global picker",
          aid in targets and targets[aid]["channels"] == ["chan-a", "chan-b"]
          and targets[aid]["dm_channel"] == web.AGENT_INBOX_CHANNEL)

    st, thread = http(port, "/api/dms?with=" + aid)
    messages = thread.get("messages", [])
    check("merged DM history includes both source channels",
          st == 200 and {m.get("channel") for m in messages} == {"chan-a", "chan-b"})
finally:
    if server is not None:
        server.shutdown()
    web.stop_all_runtimes()
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
