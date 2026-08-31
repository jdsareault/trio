"""Tests for POST /api/archives/stale — bulk archive by idle time.

This endpoint sweeps the sidebar and the roster in one shot, so the properties
worth pinning are the ones that stop it from sweeping something the operator
still wanted:

  * dry_run defaults to TRUE — a body that forgets the key previews and
    archives nothing, the same contract /api/prune has;
  * the preview NAMES every candidate, because "show me before you do it" is
    the entire feature;
  * a RUNNING agent is never a candidate, however idle, and is reported under
    `skipped` rather than silently omitted — archiving one would kill a live
    process to tidy a list;
  * excluded ids survive a real run — this is the per-row "keep this" opt-out;
  * a channel with NO messages ages from its creation date rather than being
    invisible to the scan forever;
  * the agent inbox is never a candidate;
  * a malformed exclusion list is a 400, not "excluded nothing".

Driven against the fake stream-json agent (tests/fake_agent.py) — no real
billed Claude session.

Usage: python tests/test-archive-stale.py
"""
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
from datetime import datetime, timedelta, timezone
from http.client import RemoteDisconnected
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER = HERE.parent / "server"
sys.path.insert(0, str(SERVER))
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"

_tmp = Path(tempfile.mkdtemp(prefix="nth_stale_"))
os.environ["NTH_HOME"] = str(_tmp / "home")
(_tmp / "home").mkdir(parents=True, exist_ok=True)

import nth_server as srv    # noqa: E402
import nth_web as web       # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


srv.DB_DIR = _tmp
srv.DB_PATH = _tmp / "nth.db"


def http(port, path, method="POST", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except (RemoteDisconnected, ConnectionError) as exc:
        return 0, {"dropped": str(exc)}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:                                   # noqa: BLE001
            return e.code, {}


def db_conn():
    d = sqlite3.connect(str(srv.DB_PATH))
    d.row_factory = sqlite3.Row
    return d


def backdate_channel(code, days):
    """Age a channel by moving its messages AND its creation stamp back."""
    when = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    d = db_conn()
    try:
        with d:
            d.execute("UPDATE messages SET created_at=? WHERE channel=?",
                      (when, code))
            d.execute("UPDATE channels SET created_at=? WHERE code=?",
                      (when, code))
    finally:
        d.close()


def backdate_agent(agent_id, days):
    when = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    d = db_conn()
    try:
        with d:
            d.execute("UPDATE agents SET last_active_at=?, created_at=? "
                      "WHERE id=?", (when, when, agent_id))
    finally:
        d.close()


def archived_channels():
    d = db_conn()
    try:
        return {r["code"] for r in d.execute(
            "SELECT code FROM channels WHERE archived_at IS NOT NULL")}
    finally:
        d.close()


def agent_row(agent_id):
    d = db_conn()
    try:
        return d.execute("SELECT * FROM agents WHERE id=?",
                         (agent_id,)).fetchone()
    finally:
        d.close()


def codes(payload):
    return {c["code"] for c in payload.get("channels", [])}


def agent_ids(payload):
    return {a["id"] for a in payload.get("agents", [])}


# ── fixture ─────────────────────────────────────────────────────────────────
# Three channels: two ancient (one chatty, one that never saw a message at
# all), one fresh. The empty one is the case a MAX(messages.created_at) scan
# cannot see, and it is exactly the kind of room that clutters a sidebar.
_ch, alice = (lambda r: (r["channel"], r["member_id"]))(
    json.loads(srv.nth_connect(summary="t", name="Alice", channel="oldroom")))
srv.nth_send(channel="oldroom", member_id=alice, message="ancient business")
json.loads(srv.nth_connect(summary="t", name="Bob", channel="emptyroom"))
# Genuinely zero messages, not just quiet: connect posts a "[channel created]"
# line, and leaving it in would make this fixture test the ordinary path.
_d = sqlite3.connect(str(srv.DB_PATH))
with _d:
    _d.execute("DELETE FROM messages WHERE channel='emptyroom'")
_d.close()
_fresh, carol = (lambda r: (r["channel"], r["member_id"]))(
    json.loads(srv.nth_connect(summary="t", name="Carol", channel="freshroom")))
srv.nth_send(channel="freshroom", member_id=carol, message="happening now")

backdate_channel("oldroom", 40)
backdate_channel("emptyroom", 40)

web.NthWebHandler._default_channel = ""
web.NthWebHandler.db_path = srv.DB_PATH
web._DB_PATH_GLOBAL = srv.DB_PATH
web._SUPERVISOR = None

server = None
try:
    server = web.QuietThreadingHTTPServer(("127.0.0.1", 0), web.NthWebHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    time.sleep(0.2)

    # ── validation ──────────────────────────────────────────────────────────
    st, d = http(port, "/api/archives/stale", body={})
    check("validation: older_than_days is required", st == 400)
    st, d = http(port, "/api/archives/stale", body={"older_than_days": True})
    check("validation: a bool is not a day count (bool is an int subclass)",
          st == 400)
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": -1})
    check("validation: a negative threshold is refused", st == 400)
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 7, "kinds": ["channel", "planet"]})
    check("validation: an unknown kind is refused", st == 400)
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 7, "kinds": []})
    check("validation: an empty kinds list is refused", st == 400)
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 7, "exclude_channels": "oldroom"})
    check("validation: a non-list exclusion is a 400, NOT 'excluded nothing'",
          st == 400)
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 7, "exclude_agents": [1, 2]})
    check("validation: a list of non-strings is refused too", st == 400)

    # ── preview is the default ──────────────────────────────────────────────
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 30, "kinds": ["channel"]})
    check("preview: a body with no dry_run key is a DRY RUN",
          st == 200 and d.get("dry_run") is True)
    check("preview: names the stale channels", codes(d) == {"oldroom", "emptyroom"})
    check("preview: leaves the fresh channel alone", "freshroom" not in codes(d))
    check("preview: archived nothing", archived_channels() == set())
    check("preview: reports each candidate's idle age",
          all(isinstance(c["idle_days"], (int, float)) and c["idle_days"] >= 30
              for c in d["channels"]))
    empty = [c for c in d["channels"] if c["code"] == "emptyroom"][0]
    check("preview: a channel that never saw a message is still a candidate, "
          "aged from its creation date", empty["never_active"] is True)
    check("preview: reports the cutoff it used", "cutoff" in d)
    check("preview: the agent inbox is never a candidate",
          web.AGENT_INBOX_CHANNEL not in codes(d))

    # ── exclusions survive a real run ───────────────────────────────────────
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 30, "kinds": ["channel"],
                       "exclude_channels": ["emptyroom"], "dry_run": False})
    check("apply: succeeds", st == 200 and d.get("ok") is True)
    check("apply: archived the channel that was not excluded",
          archived_channels() == {"oldroom"})
    check("apply: the excluded channel survives",
          "emptyroom" not in archived_channels())
    check("apply: echoes what was kept back, so the response documents the "
          "decision", d["excluded"]["channels"] == ["emptyroom"])
    check("apply: marks each row archived", d["channels"][0]["archived"] is True)

    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 30, "kinds": ["channel"]})
    check("apply: an already-archived channel is no longer a candidate",
          codes(d) == {"emptyroom"})

    # ── agents: running is never a candidate ────────────────────────────────
    st, made = http(port, "/api/agents", body={
        "model": "sonnet", "channels": ["freshroom"], "prompt": "hi"})
    check("fixture: an agent was created", st == 200 and "agent" in made)
    live = made["agent"]["id"]
    st, made2 = http(port, "/api/agents", body={
        "model": "sonnet", "channels": ["freshroom"], "prompt": "hi"})
    dead = made2["agent"]["id"]
    http(port, f"/api/agents/{dead}/stop")
    time.sleep(0.3)
    backdate_agent(live, 60)
    backdate_agent(dead, 60)

    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 30, "kinds": ["agent"]})
    check("agents: a stopped, long-idle agent is a candidate",
          st == 200 and dead in agent_ids(d))
    check("agents: a RUNNING agent is never a candidate, however idle",
          live not in agent_ids(d))
    skipped_ids = {a["id"] for a in d["skipped"]["agents"]}
    check("agents: the running one is reported as SKIPPED rather than "
          "silently dropped", live in skipped_ids)
    check("agents: with a reason the operator can read",
          all(a.get("reason") == "running" for a in d["skipped"]["agents"]))
    check("agents: the preview archived nothing",
          agent_row(dead)["archived_at"] is None)

    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 30, "kinds": ["agent"],
                       "dry_run": False})
    check("agents: a real run archives the stale one",
          st == 200 and agent_row(dead)["archived_at"] is not None)
    check("agents: and leaves the running one alone",
          agent_row(live)["archived_at"] is None)
    check("agents: archiving went through the real teardown path — the "
          "agent's inbox membership is gone",
          db_conn().execute(
              "SELECT COUNT(*) FROM members WHERE id=? AND channel=?",
              (dead, web.AGENT_INBOX_CHANNEL)).fetchone()[0] == 0)

    # ── scope ───────────────────────────────────────────────────────────────
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 30, "kinds": ["channel"]})
    check("scope: kinds=[channel] returns no agent rows", d["agents"] == [])
    st, d = http(port, "/api/archives/stale", body={"older_than_days": 30})
    check("scope: the default covers both kinds",
          "channels" in d and "agents" in d)

    # ── nothing stale ───────────────────────────────────────────────────────
    st, d = http(port, "/api/archives/stale",
                 body={"older_than_days": 3650})
    check("empty sweep: an unreachable threshold finds nothing and still "
          "answers ok", st == 200 and d["ok"] is True
          and d["counts"]["channels"] == 0 and d["counts"]["agents"] == 0)

finally:
    if server is not None:
        server.shutdown()
        server.server_close()
    try:
        sup = web.get_supervisor()
        for a in list(getattr(sup, "_procs", {})):
            try:
                sup.stop(a)
            except Exception:                               # noqa: BLE001
                pass
    except Exception:                                       # noqa: BLE001
        pass
    shutil.rmtree(_tmp, ignore_errors=True)

print()
if failures:
    print(f"{len(failures)} FAILED: " + ", ".join(failures))
    sys.exit(1)
print("all archive-stale checks passed")
