#!/usr/bin/env python3
"""AgentRouter: a message DIRECTED at a placed agent (@it) is fed to the agent's
process, [#channel]-tagged; ambient chatter is not. Driven against the fake
stream-json agent (echoes what it's fed), so no real billed session.
"""
import json
import os
import shutil
import sqlite3
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
os.environ["TRIO_AGENT_CMD"] = f"{sys.executable} {HERE / 'fake_agent.py'}"

import nth_server as srv   # noqa: E402
import nth_web as web      # noqa: E402
import nth_supervisor as nsup  # noqa: E402

failures = 0


def check(label, cond):
    global failures
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures += 1


def main() -> int:
    tmp = Path(__import__("tempfile").mkdtemp(prefix="nth-route-"))
    srv.DB_DIR = tmp
    srv.DB_PATH = tmp / "nth.db"
    web._DB_PATH_GLOBAL = srv.DB_PATH

    # Host + channel.
    host = json.loads(srv.nth_connect(summary="t", name="Host", channel="rt"))

    # Register a managed agent placed in the channel (member_id == agent_id).
    aid = "ag_route1"
    now = srv.now_iso()
    db = srv.get_db()
    db.execute("INSERT INTO agents (id, name, model, state, managed, created_at) "
               "VALUES (?, 'Router', 'sonnet', 'stopped', 1, ?)", (aid, now))
    db.execute("INSERT INTO members (id, channel, name, summary, skills, last_seen, "
               "joined_at, active, kind) VALUES (?, 'rt', 'Router', '', '', ?, ?, 1, 'agent')",
               (aid, now, now))
    db.execute("INSERT INTO agent_channels (agent_id, channel, member_id, joined_at) "
               "VALUES (?, 'rt', ?, ?)", (aid, aid, now))
    db.commit(); db.close()

    echoes = []
    got = threading.Event()

    def on_event(agent_id, evt):
        if evt.get("type") == "assistant":
            echoes.append(evt["message"]["content"]); got.set()

    sup = nsup.AgentSupervisor(db_path=srv.DB_PATH, on_event=on_event)
    sup.spawn(aid, model="sonnet")

    router = web.AgentRouter(srv.DB_PATH, sup, interval=0.2)
    router.start()
    time.sleep(0.3)  # let router capture the baseline max id

    # Ambient message (no mention) — must NOT be fed.
    srv.nth_send(channel="rt", member_id=host["member_id"], message="just chatting")
    time.sleep(0.6)
    check("ambient message is NOT routed to the agent",
          not any("just chatting" in e for e in echoes))

    # Directed message (@<agent_id>) — MUST be fed, channel-tagged.
    got.clear()
    srv.nth_send(channel="rt", member_id=host["member_id"],
                 message=f"@{aid} please help")
    got.wait(3.0)
    check("directed @agent message is routed + [#channel]-tagged",
          any("[#rt]" in e and "please help" in e for e in echoes))

    # Membership scope: a message mentioning the agent in a channel it is NOT
    # placed in must NOT be fed (inject mentions directly, bypassing sigil parse).
    d = srv.get_db()
    d.execute("INSERT INTO channels (code,status,created_at,updated_at) "
              "VALUES ('other','active',?,?)", (srv.now_iso(), srv.now_iso()))
    d.execute("INSERT INTO messages (channel,member_id,member_name,content,mentions,created_at) "
              "VALUES ('other',?,?,?,?,?)",
              (host["member_id"], "Host", "hello elsewhere",
               json.dumps([aid]), srv.now_iso()))
    d.commit(); d.close()
    echoes.clear(); time.sleep(0.8)
    check("agent mentioned in a channel it is NOT placed in is NOT fed",
          not any("hello elsewhere" in e for e in echoes))

    # Wake path: hibernate, then a directed message must wake + feed, and the
    # woken agent must be re-launched WITH its Trio MCP (Sauron/Ents crit).
    sup.hibernate(aid)
    time.sleep(0.3)
    check("agent hibernated (not running)", not sup.is_running(aid))
    got.clear(); echoes.clear()
    srv.nth_send(channel="rt", member_id=host["member_id"], message=f"@{aid} wake up please")
    got.wait(8.0)
    check("router wakes a hibernated agent and feeds the message",
          any("wake up please" in e for e in echoes) and sup.is_running(aid))
    check("woken agent re-launched WITH --mcp-config (not deaf-mute)",
          "--mcp-config" in (sup._procs.get(aid).argv if sup._procs.get(aid) else []))

    router.stop()
    sup.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
