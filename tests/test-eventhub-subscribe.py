"""EventHub.subscribe race regression.

The old subscribe() built the prime snapshot BEFORE registering the
subscriber. A message committed (and _broadcast) in that window was
permanently lost: the snapshot missed it and _broadcast couldn't see the
sub yet. The fix registers the subscriber first, then primes — so a
mid-priming broadcast is also enqueued live (a benign duplicate the client
dedupes by id). This test deterministically reproduces the race by
injecting a broadcast inside _build_prime_payloads and asserting the
message is NOT lost.

Usage: python tests/test-eventhub-subscribe.py
"""
import json
import tempfile
import threading
import time
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv      # noqa: E402
import nth_web as web          # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_hub_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"

CH = "hubrace"
r = json.loads(srv.nth_connect(summary="t", name="Op", channel=CH))
OP = r["member_id"]
# Seed a couple of broadcasts so the prime snapshot is non-empty.
srv.nth_send(channel=CH, member_id=OP, message="seed one")
srv.nth_send(channel=CH, member_id=OP, message="seed two")

hub = web.EventHub(srv.DB_PATH, CH)
hub.start()
try:
    # The race message: committed + broadcast in the middle of subscribe's
    # priming window. We inject it by wrapping _build_prime_payloads so it
    # fires a real broadcast (via hub._broadcast) exactly once, after the
    # snapshot query would have run but before the sub is (was) registered.
    race_msg_id = [None]
    original_build = hub._build_prime_payloads
    fired = {"n": 0}

    def racing_build(viewer_id, all_seeing):
        # Reproduce the lost-message race: take the snapshot FIRST (without
        # the RACE msg), THEN commit + broadcast the RACE msg, THEN return the
        # now-stale payloads. In the old (snapshot-first) subscribe order, the
        # sub is registered only AFTER this returns — so the broadcast (fired
        # before registration) never reaches the sub, and the stale snapshot
        # doesn't contain the RACE msg → permanently lost. With the fix, the
        # sub is already registered before this runs, so the broadcast
        # enqueues to q (a duplicate the client dedupes).
        if fired["n"] == 0:
            fired["n"] = 1
            payloads = original_build(viewer_id, all_seeing)  # snapshot: NO race msg
            out = json.loads(srv.nth_send(channel=CH, member_id=OP, message="RACE msg"))
            race_msg_id[0] = out.get("message_id")
            db = None
            try:
                db = __import__("sqlite3").connect(str(srv.DB_PATH), timeout=5)
                db.row_factory = __import__("sqlite3").Row
                row = db.execute(
                    "SELECT id, member_id, member_name, content, mentions, refs, "
                    "bangs, choices, selection, reply_to, confidence, recipients, "
                    "retracted_at, retraction_reason, edited_at, created_at "
                    "FROM messages WHERE id = ?",
                    (race_msg_id[0],),
                ).fetchone()
                if row:
                    race_ev = web._message_event(db, row)
                    race_ev["channel"] = CH  # mirrors the real broadcast call sites in nth_web.py
                    hub._broadcast(race_ev)
            finally:
                if db is not None:
                    db.close()
            return payloads  # stale: does NOT include the RACE msg
        return original_build(viewer_id, all_seeing)

    hub._build_prime_payloads = racing_build
    q = hub.subscribe(viewer_id=OP, all_seeing=True)
    # Drain the queue.
    got = []
    try:
        while True:
            got.append(json.loads(q.get_nowait()))
    except Exception:
        pass

    ids = [e.get("id") for e in got if e.get("type") == "message"]
    rid = race_msg_id[0]
    check("race: subscribe registered before snapshot (RACE msg not lost)",
          rid is not None and rid in ids)
    # The RACE msg may also appear in the prime snapshot (duplicate) — that's
    # the expected benign outcome the client dedupes. Assert it appears AT
    # LEAST once (the live copy); duplication is acceptable, loss is not.
    check("race: RACE msg present at least once in feed", ids.count(rid) >= 1)

    # Sanity: the seeded messages are primed (subscribe still delivers history).
    seeds = json.loads(srv.nth_history(channel=CH, last_n=10, member_id=OP))
    seed_ids = [m["id"] for m in seeds.get("messages", [])]
    check("prime: seeded history still delivered to subscriber",
          all(sid in ids for sid in seed_ids if sid != rid))

    # Every message event this hub emits (prime AND live) must carry the
    # channel it belongs to — the cross-channel workspace SSE stream
    # (_serve_workspace_sse) multiplexes several hubs' queues into one
    # connection with no other way for the client to tell which channel a
    # given message came from (see nth_web.py's _build_prime_payloads /
    # _watch_loop comments).
    check("every message event in the feed is stamped with this hub's channel",
          all(e.get("channel") == CH for e in got if e.get("type") == "message"))

    # Same requirement for the roster event the prime snapshot includes —
    # LOTC bug: this was unstamped, so the client's dispatch() applied ANY
    # roster tick (from any multiplexed channel) unconditionally, letting
    # a viewer's member list get replaced by a completely different
    # channel's (worst case: AGENT_INBOX_CHANNEL's — every agent ever
    # created) roster mid-view.
    check("the roster event in the feed is stamped with this hub's channel",
          any(e.get("type") == "roster" and e.get("channel") == CH for e in got))
finally:
    hub.stop()

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
