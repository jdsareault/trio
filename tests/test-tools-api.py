"""HTTP coverage for GET /api/tools — the recent-subagent drawer reader and
the wider `kind=all` slice the per-agent activity panel reads."""
import json
import os
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
import nth_web as web     # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def http(port, path):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode())
        except Exception:
            return exc.code, {}


tmp = Path(tempfile.mkdtemp(prefix="nth_tools_api_"))
old_fingerprint = os.environ.get("CLAUDE_CODE_SESSION_ID")
server = None
try:
    srv.DB_DIR = tmp
    srv.DB_PATH = tmp / "nth.db"
    web.NthWebHandler._default_channel = ""
    web.NthWebHandler.landing_mode = True
    web.NthWebHandler.db_path = srv.DB_PATH
    web._DB_PATH_GLOBAL = srv.DB_PATH

    # Two identities from one Claude session reproduce reconnect accumulation.
    # Only the newest session/member may own that fingerprint's activity ring.
    os.environ["CLAUDE_CODE_SESSION_ID"] = "fp-shared"
    old = json.loads(srv.nth_connect(summary="old", name="Old", channel="tools"))
    time.sleep(0.002)
    current = json.loads(srv.nth_connect(summary="new", name="Current", channel="tools"))

    os.environ["CLAUDE_CODE_SESSION_ID"] = "fp-other"
    other = json.loads(srv.nth_connect(summary="other", name="Other", channel="elsewhere"))

    db = srv.get_db()
    now = srv.now_iso()
    db.executemany(
        "INSERT INTO tool_events (fingerprint,tool_name,target,created_at) VALUES (?,?,?,?)",
        [
            ("fp-shared", "Task", "review auth", now),
            ("fp-shared", "Read", "secrets.txt", now),
            ("fp-shared", "Agent", "sauron", now),
            ("fp-other", "Agent", "wrong channel", now),
            ("fp-orphan", "Agent", "no session", now),
        ],
    )
    db.commit()
    db.close()

    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.1)

    st, data = http(port, f"/api/tools?channel=tools&member={current['member_id']}")
    check("current member: endpoint returns the client contract",
          st == 200 and data.get("ok") is True and data.get("count") == 2
          and isinstance(data.get("subagents"), list))
    check("current member: only Task/Agent starts are exposed",
          [row["tool_name"] for row in data.get("subagents", [])] == ["Agent", "Task"]
          and all("secrets.txt" not in str(row) for row in data.get("subagents", [])))
    check("current member: response carries renderable fields",
          all(set(row) == {"id", "tool_name", "target", "created_at"}
              for row in data.get("subagents", [])))

    st, data = http(port, f"/api/tools?channel=tools&member={old['member_id']}")
    check("stale reconnect identity cannot read the current fingerprint ring",
          st == 200 and data.get("subagents") == [])

    st, data = http(port, f"/api/tools?channel=tools&member={current['member_id']}&limit=1")
    check("limit is honored", st == 200 and data.get("count") == 1)
    st, _ = http(port, "/api/tools?channel=tools")
    check("member is required", st == 400)
    st, _ = http(port, "/api/tools?channel=tools&member=not-here")
    check("member must belong to the requested channel", st == 404)
    st, _ = http(port, f"/api/tools?channel=tools&member={other['member_id']}")
    check("a member from another channel cannot be enumerated", st == 404)

    # ── kind=all: the activity panel's slice ──────────────────────────────
    # fp-shared holds Task, Read, Agent (ids ascending in that order), so the
    # ring answers newest-first as Agent, Read, Task.
    st, data = http(port, f"/api/tools?channel=tools&member={current['member_id']}&kind=all")
    check("kind=all exposes every recorded call, newest first",
          st == 200 and data.get("kind") == "all" and data.get("count") == 3
          and [r["tool_name"] for r in data.get("events", [])] == ["Agent", "Read", "Task"])
    check("kind=all still carries `subagents` for the existing drawer caller",
          data.get("subagents") == data.get("events"))
    check("kind=all reports every call's timestamp",
          all(r.get("created_at") for r in data.get("events", [])))

    # The default must stay narrow, and an unrecognised kind must fall back to
    # the narrow slice rather than the wide one: a typo should under-share.
    st, data = http(port, f"/api/tools?channel=tools&member={current['member_id']}")
    check("kind defaults to the narrow subagent slice", data.get("kind") == "subagents"
          and data.get("count") == 2)
    st, data = http(port, f"/api/tools?channel=tools&member={current['member_id']}&kind=ALL")
    check("an unrecognised kind under-shares rather than over-shares",
          data.get("kind") == "subagents" and data.get("count") == 2
          and all("secrets.txt" not in str(r) for r in data.get("events", [])))

    # ── keyset pagination ─────────────────────────────────────────────────
    st, page1 = http(port, f"/api/tools?channel=tools&member={current['member_id']}&kind=all&limit=2")
    check("a full page advertises a cursor",
          st == 200 and page1.get("count") == 2
          and page1.get("next_before") == page1["events"][-1]["id"])
    st, page2 = http(port,
                     f"/api/tools?channel=tools&member={current['member_id']}"
                     f"&kind=all&limit=2&before={page1.get('next_before')}")
    check("the cursor returns the next page with no overlap",
          st == 200 and page2.get("count") == 1
          and [r["tool_name"] for r in page2["events"]] == ["Task"]
          and not ({r["id"] for r in page1["events"]} & {r["id"] for r in page2["events"]}))
    # A short page is the end of the ring. Advertising a cursor there would make
    # the panel fetch one guaranteed-empty page every time it hit the bottom.
    check("a short page advertises no cursor", "next_before" not in page2)
    st, data = http(port, f"/api/tools?channel=tools&member={current['member_id']}&kind=all&before=bogus")
    check("a garbage cursor is page one, not an error",
          st == 200 and data.get("count") == 3)

    # Scoping is enforced for the wide slice too — widening WHAT is returned
    # must not widen WHO may read it.
    st, data = http(port, f"/api/tools?channel=tools&member={old['member_id']}&kind=all")
    check("kind=all is still scoped to the current fingerprint identity",
          st == 200 and data.get("events") == [])
    st, _ = http(port, f"/api/tools?channel=tools&member={other['member_id']}&kind=all")
    check("kind=all cannot enumerate a member from another channel", st == 404)

    original = web.NthWebHandler._resolve_identity

    class Pending:
        source = web.IDENTITY_SOURCE_PENDING

    web.NthWebHandler._resolve_identity = lambda self: ("", Pending(), False)
    try:
        st, data = http(port, f"/api/tools?channel=tools&member={current['member_id']}")
        check("pending viewers receive no activity data",
              st == 403 and not data.get("subagents"))
    finally:
        web.NthWebHandler._resolve_identity = original
finally:
    if server is not None:
        server.shutdown()
        server.server_close()
    if old_fingerprint is None:
        os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
    else:
        os.environ["CLAUDE_CODE_SESSION_ID"] = old_fingerprint
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(("FAILED" if failures else "OK") + f" — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
