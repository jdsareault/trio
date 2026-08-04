"""Tests for the DM UX bundle — auto-scoped DM replies + the is_dm signal.

Builds on the real-DMs visibility engine (see test-dms.py). Covers the locked
design:

  Reply-scope inheritance (nth_send, code-enforced):
    (R1) a reply to a DM inherits the DM's scope — same participants, no more
    (R2) the replier itself is dropped from recipients (sees own posts)
    (R3) a reply to a BROADCAST stays a broadcast (recipients empty)
    (R4) a NON-participant's reply does NOT inherit — cannot widen/narrow a
         thread they were never in; it degrades to an ordinary broadcast, never
         a privately-scoped injection, and never leaks the DM
    (R5) a group DM reply reaches every original participant but the replier
    (R6) inheritance only ever NARROWS — a DM reply is never a broadcast
    + direct unit checks of _inherited_dm_recipients (incl. operator + self-DM)

  is_dm signal (nth_poll + monitor):
    (D1) a recipient's poll entry is flagged is_dm with dm.from = sender
    (D2) a broadcast poll entry carries NO is_dm flag
    (D3) the monitor new_messages path exposes has_dms for a recipient only

Usage: python tests/test-dm-ux.py
"""
import json
import tempfile
import shutil
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER))
import nth_server as srv          # noqa: E402
from nth_constants import AGENT_INBOX_CHANNEL, can_see, parse_recipients  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


_tmp = tempfile.mkdtemp(prefix="nth_dmux_")
srv.DB_DIR = Path(_tmp)
srv.DB_PATH = Path(_tmp) / "nth.db"


def poll(member_id):
    """Return topic + global-inbox entries visible to a member."""
    out = []
    for channel in (CH, AGENT_INBOX_CHANNEL):
        r = json.loads(srv.nth_poll(channel=channel, member_id=member_id, wait_seconds=0))
        if r.get("event") == "new_messages":
            out.extend(r.get("messages", []))
    return out


def poll_ids(member_id):
    return [m["id"] for m in poll(member_id)]


def row_recipients(msg_id):
    db = srv.get_db()
    try:
        r = db.execute("SELECT recipients FROM messages WHERE id=?", (msg_id,)).fetchone()
        return parse_recipients(r["recipients"]) if r else None
    finally:
        db.close()


def row_mentions(msg_id):
    db = srv.get_db()
    try:
        r = db.execute("SELECT mentions FROM messages WHERE id=?", (msg_id,)).fetchone()
        return json.loads(r["mentions"] or "[]") if r else []
    finally:
        db.close()


# ── Roster: Alice, Bob, Carol, Dave ──
A = json.loads(srv.nth_connect(summary="a", name="Alice", channel="dmuxtest"))
CH = A["channel"]
alice = A["member_id"]
bob = json.loads(srv.nth_connect(summary="b", name="Bob", channel=CH))["member_id"]
carol = json.loads(srv.nth_connect(summary="c", name="Carol", channel=CH))["member_id"]
dave = json.loads(srv.nth_connect(summary="d", name="Dave", channel=CH))["member_id"]

# Drain join chatter so later polls are clean.
for mid in (alice, bob, carol, dave):
    srv.nth_poll(channel=CH, member_id=mid, wait_seconds=0)


# ═══ Reply-scope inheritance ═══════════════════════════════════════════

# Alice DMs Bob.
dm = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="secret", to="Bob"))
DM_ID = dm["message_id"]
check("setup: DM to Bob scoped to [bob]", row_recipients(DM_ID) == [bob])

# (R1/R2) Bob replies to the DM via trio_send (no explicit recipients).
rep = json.loads(srv.nth_send(channel=CH, member_id=bob, message="got it", reply_to=DM_ID))
REP_ID = rep["message_id"]
check("(R1) reply-to-DM inherits scope = original participants minus replier",
      row_recipients(REP_ID) == [alice])
check("(R2) replier (Bob) not listed in own reply recipients", bob not in (row_recipients(REP_ID) or []))
# Delivery: Alice (participant) sees it, Carol (non-participant) does not.
check("(R1) participant Alice sees the scoped reply via poll", REP_ID in poll_ids(alice))
check("(R1) non-participant Carol does NOT see the scoped reply", REP_ID not in poll_ids(carol))
check("(R1) predicate withholds scoped reply from Carol",
      can_see(carol, "agent", bob, json.dumps(row_recipients(REP_ID))) is False)
# The inherited recipients are auto-woken (added to the ping set), mirroring trio_dm.
check("(R1) inherited recipient Alice auto-woken (in mentions)", alice in row_mentions(REP_ID))

# Alice replies to her OWN DM → scoped back to Bob.
rep2 = json.loads(srv.nth_send(channel=CH, member_id=alice, message="ok", reply_to=DM_ID))
check("(R1) original sender's reply scoped to the recipient", row_recipients(rep2["message_id"]) == [bob])

# (R3) A reply to a BROADCAST stays a broadcast.
bc = json.loads(srv.nth_send(channel=CH, member_id=alice, message="hello all"))
BC_ID = bc["message_id"]
rb = json.loads(srv.nth_send(channel=CH, member_id=bob, message="hi back", reply_to=BC_ID))
check("(R3) reply-to-broadcast stays broadcast (recipients empty)", row_recipients(rb["message_id"]) == [])
check("(R3) broadcast reply reaches non-participant Carol", rb["message_id"] in poll_ids(carol))

# (R4) A NON-participant (Carol) replies to Alice→Bob DM. The global inbox
#      cannot safely degrade this into an inbox broadcast, so it rejects the
#      injection rather than leaking a topic message or widening the DM.
for mid in (alice, bob, carol, dave):
    srv.nth_poll(channel=CH, member_id=mid, wait_seconds=0)
rc = json.loads(srv.nth_send(channel=CH, member_id=carol, message="butting in", reply_to=DM_ID))
check("(R4) non-participant reply is rejected", "error" in rc)

# (R5) Group DM: Alice → Bob + Carol. Bob's reply reaches every participant but Bob.
gdm = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="team secret", to="Bob, Carol"))
GDM_ID = gdm["message_id"]
grep_ = json.loads(srv.nth_send(channel=CH, member_id=bob, message="ack team", reply_to=GDM_ID))
GREP_ID = grep_["message_id"]
check("(R5) group-DM reply scoped to {alice, carol} (all participants minus Bob)",
      set(row_recipients(GREP_ID)) == {alice, carol})
check("(R5) group-DM reply excludes the replier Bob", bob not in row_recipients(GREP_ID))
for mid in (alice, bob, carol, dave):
    srv.nth_poll(channel=CH, member_id=mid, wait_seconds=0)
grep2 = json.loads(srv.nth_send(channel=CH, member_id=bob, message="again", reply_to=GDM_ID))
GREP2 = grep2["message_id"]
check("(R5) participant Carol sees group-DM reply", GREP2 in poll_ids(carol))
check("(R5) outsider Dave does NOT see group-DM reply", GREP2 not in poll_ids(dave))

# (R6) Sanity: no DM reply ever degraded to a broadcast.
for rid in (REP_ID, GREP_ID, GREP2):
    check(f"(R6) DM reply #{rid} never a broadcast", row_recipients(rid) != [])

# (R7) Depth-2 chain: reply to a REPLY. Bob's reply REP_ID is scoped [alice]
#      (sender Bob, recips [alice]). Alice now replies to REP_ID → the participant
#      set reconstructs as {Bob} ∪ {alice} minus Alice = {Bob}. This guards the
#      inductive {sender}∪recips property — a bug that used only `recips` would
#      drop the original sender at depth 2 and this would fail.
chain = json.loads(srv.nth_send(channel=CH, member_id=alice, message="chained", reply_to=REP_ID))
CHAIN_ID = chain["message_id"]
check("(R7) depth-2 reply reconstructs the full participant set (scoped to Bob)",
      row_recipients(CHAIN_ID) == [bob])
for mid in (alice, bob, carol, dave):
    srv.nth_poll(channel=CH, member_id=mid, wait_seconds=0)
chain2 = json.loads(srv.nth_send(channel=CH, member_id=alice, message="chained2", reply_to=REP_ID))
CHAIN2 = chain2["message_id"]
check("(R7) depth-2 reply reaches original participant Bob", CHAIN2 in poll_ids(bob))
check("(R7) depth-2 reply still hidden from outsider Carol", CHAIN2 not in poll_ids(carol))

# (R8) Wake ⊆ visibility: an @mention of a NON-participant in an auto-scoped
#      (DM) reply is INERT — it neither wakes (mentions) nor reveals
#      (recipients). narrow_wake drops any wake target that isn't a recipient,
#      so a message can never wake someone who can't see it. Bob replies to the
#      Alice→Bob DM with "@Dave look"; Dave is outside the DM.
davedm = json.loads(srv.nth_send(channel=CH, member_id=bob, message="@Dave look", reply_to=DM_ID))
DAVEDM = davedm["message_id"]
check("(R8) @non-participant is NOT added to mentions (not woken — narrow_wake)",
      dave not in row_mentions(DAVEDM))
check("(R8) @non-participant is NOT added to recipients (visibility unchanged)",
      dave not in (row_recipients(DAVEDM) or []))
check("(R8) @non-participant Dave still cannot see the scoped reply",
      can_see(dave, "agent", bob, json.dumps(row_recipients(DAVEDM))) is False)

# ── Direct unit checks of _inherited_dm_recipients ──
db = srv.get_db()
try:
    # broadcast target → None
    check("(unit) inherit over broadcast target → None",
          srv._inherited_dm_recipients(db, CH, BC_ID, bob, "agent") is None)
    # DM target, participant → participants minus replier
    got = srv._inherited_dm_recipients(db, AGENT_INBOX_CHANNEL, DM_ID, bob, "agent")
    check("(unit) inherit over DM by participant → [alice]", json.loads(got) == [alice])
    # DM target, non-participant → None
    check("(unit) inherit over DM by non-participant → None",
          srv._inherited_dm_recipients(db, AGENT_INBOX_CHANNEL, DM_ID, dave, "agent") is None)
    # SECURITY: a forged/caller-supplied operator id is NOT trusted as an
    # all-seeing participant on the unauthenticated MCP path (default
    # allow_all_seeing=False) — it must NOT auto-scope into a DM it isn't in.
    check("(unit) forged operator id gets NO inheritance on MCP path (leak closed)",
          srv._inherited_dm_recipients(db, AGENT_INBOX_CHANNEL, DM_ID, "_op_l_host", "human") is None)
    # Only an AUTHENTICATED surface (allow_all_seeing=True) grants the operator
    # all-seeing participant status — and even then it only narrows scope.
    op_got = srv._inherited_dm_recipients(db, AGENT_INBOX_CHANNEL, DM_ID, "_op_l_host", "human",
                                          allow_all_seeing=True)
    check("(unit) all-seeing operator inherits full set only when authenticated",
          op_got is not None and set(json.loads(op_got)) == {alice, bob})
    # missing target → None (never crashes)
    check("(unit) inherit over missing reply_to → None",
          srv._inherited_dm_recipients(db, AGENT_INBOX_CHANNEL, 999999, alice, "agent") is None)
    # None reply_to → None
    check("(unit) inherit over None reply_to → None",
          srv._inherited_dm_recipients(db, AGENT_INBOX_CHANNEL, None, alice, "agent") is None)
    # self-DM edge: a DM Alice addressed to herself, Alice replies → falls back
    # to the participant set rather than degrading to a broadcast.
    selfdm = db.execute(
        "INSERT INTO messages (channel, member_id, member_name, content, recipients, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (AGENT_INBOX_CHANNEL, alice, "Alice", "note to self", json.dumps([alice]), srv.now_iso()))
    db.commit()
    self_id = selfdm.lastrowid
    self_got = srv._inherited_dm_recipients(db, AGENT_INBOX_CHANNEL, self_id, alice, "agent")
    check("(unit) self-DM reply falls back to participants (never broadcast)",
          self_got is not None and json.loads(self_got) == [alice])
finally:
    db.close()


# ═══ is_dm signal ══════════════════════════════════════════════════════

# Fresh watermarks, then Alice DMs Bob and broadcasts.
for mid in (alice, bob, carol):
    srv.nth_poll(channel=CH, member_id=mid, wait_seconds=0)
sig_dm = json.loads(srv.nth_dm(channel=CH, member_id=alice, message="ping-bob", to="Bob"))
SIG_DM = sig_dm["message_id"]
sig_bc = json.loads(srv.nth_send(channel=CH, member_id=alice, message="ping-all"))
SIG_BC = sig_bc["message_id"]

bob_msgs = {m["id"]: m for m in poll(bob)}
check("(D1) recipient's DM entry carries is_dm=True", bob_msgs.get(SIG_DM, {}).get("is_dm") is True)
check("(D1) recipient's DM entry carries dm.from = sender name",
      (bob_msgs.get(SIG_DM, {}).get("dm") or {}).get("from") == "Alice")
check("(D2) recipient's broadcast entry has NO is_dm flag", "is_dm" not in bob_msgs.get(SIG_BC, {}))

# Carol (non-recipient) never sees the DM at all, so it can't be flagged for her.
carol_msgs = {m["id"]: m for m in poll(carol)}
check("(D2) non-recipient never receives the DM to flag", SIG_DM not in carol_msgs)
check("(D2) non-recipient's broadcast entry has NO is_dm flag", "is_dm" not in carol_msgs.get(SIG_BC, {}))

# (D3) Monitor path: replicate its unread→can_see→has_dms computation and
#      confirm has_dms is True only for the recipient.
def monitor_has_dms(member_id):
    db = srv.get_db()
    try:
        rows = db.execute(
            "SELECT id, recipients, member_id FROM messages "
            "WHERE channel=? AND id>? AND member_id!=? ORDER BY id",
            (AGENT_INBOX_CHANNEL, SIG_DM - 1, member_id)).fetchall()
    finally:
        db.close()
    vis = [m for m in rows
           if can_see(member_id, "agent", m["member_id"], m["recipients"], allow_all_seeing=False)]
    return any(member_id in parse_recipients(m["recipients"]) for m in vis)


check("(D3) monitor has_dms True for recipient Bob", monitor_has_dms(bob) is True)
check("(D3) monitor has_dms False for non-recipient Carol", monitor_has_dms(carol) is False)

shutil.rmtree(_tmp, ignore_errors=True)
print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
sys.exit(1 if failures else 0)
