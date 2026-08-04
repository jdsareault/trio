#!/usr/bin/env python3
"""Identity reclaim (unified-interface): nth_connect(resume_member_id=...) must
re-attach to an existing member row instead of minting a new one (closes bug
B1), while leaving the normal connect path unchanged.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_server as srv  # noqa: E402

failures = 0


def check(label, cond):
    global failures
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures += 1


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="nth-reclaim-")
    srv.DB_DIR = Path(tmp)
    srv.DB_PATH = Path(tmp) / "nth.db"

    # Normal connect path is untouched.
    r = json.loads(srv.nth_connect(summary="s", name="Alice", channel="rt"))
    check("normal connect unchanged (action=created, id minted)",
          r.get("action") == "created" and bool(r.get("member_id")))

    # Hub pre-creates the agent's member row (and its supervisor-issued
    # reclaim secret), then the agent reclaims it.
    db = srv.get_db()
    db.execute("INSERT INTO members (id, channel, name, summary, skills, "
               "last_seen, joined_at, active) VALUES "
               "('ag_x','rt','Aragorn','','',?,?,1)", (srv.now_iso(), srv.now_iso()))
    db.execute("INSERT INTO agents (id, name, reclaim_secret, created_at) VALUES "
               "('ag_x','Aragorn','sekrit-x',?)", (srv.now_iso(),))
    db.commit(); db.close()
    before = srv.get_db().execute(
        "SELECT COUNT(*) FROM members WHERE channel='rt'").fetchone()[0]

    # SECURITY: without the reclaim secret, a caller who only knows the public
    # member_id must NOT be able to reclaim the identity.
    r2_nosecret = json.loads(srv.nth_connect(summary="agent", name="Aragorn",
                                             channel="rt", resume_member_id="ag_x"))
    check("reclaim without reclaim_secret is REFUSED", "error" in r2_nosecret)
    r2_wrongsecret = json.loads(srv.nth_connect(summary="agent", name="Aragorn",
                                                channel="rt", resume_member_id="ag_x",
                                                reclaim_secret="not-it"))
    check("reclaim with wrong reclaim_secret is REFUSED", "error" in r2_wrongsecret)

    r2 = json.loads(srv.nth_connect(summary="agent", name="Aragorn",
                                    channel="rt", resume_member_id="ag_x",
                                    reclaim_secret="sekrit-x"))
    after = srv.get_db().execute(
        "SELECT COUNT(*) FROM members WHERE channel='rt'").fetchone()[0]
    check("reclaim: connects AS the fixed id (no re-mint)", r2.get("member_id") == "ag_x")
    check("reclaim: action=reclaimed", r2.get("action") == "reclaimed")
    check("reclaim: NO duplicate member row (B1 closed)", before == after)
    check("reclaim: still mints a session token", bool(r2.get("session_token")))
    joins = srv.get_db().execute(
        "SELECT COUNT(*) FROM messages WHERE channel='rt' "
        "AND content LIKE '[joined] Aragorn%'").fetchone()[0]
    check("reclaim: silent re-attach (no [joined] spam)", joins == 0)

    # An unknown requested id is never honored: mint a new registered identity.
    r3 = json.loads(srv.nth_connect(summary="a", name="Gimli",
                                    channel="rt", resume_member_id="ag_y"))
    check("unknown reclaim: mints a fresh id, action=joined",
          r3.get("member_id") != "ag_y" and r3.get("action") == "joined")
    check("unknown reclaim: fresh id gets its own secret",
          bool(r3.get("reclaim_secret")))

    # The same rule applies when the requested channel does not exist.
    r4 = json.loads(srv.nth_connect(summary="a", name="Boromir",
                                    channel="fresh-chan", resume_member_id="ag_z"))
    check("unknown reclaim in new channel: fresh id preserved",
          r4.get("member_id") != "ag_z" and r4.get("action") == "created")

    # SECURITY: a human/operator row (kind='human') must NOT be reclaimable.
    db = srv.get_db()
    db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,"
               "joined_at,active,kind) VALUES ('_op_l_op','rt','Operator','','',"
               "?,?,1,'human')", (srv.now_iso(), srv.now_iso()))
    db.commit(); db.close()
    rh = json.loads(srv.nth_connect(summary="evil", name="Thief",
                                    channel="rt", resume_member_id="_op_l_op"))
    check("reclaim of a human/operator identity is REFUSED",
          rh.get("error") == "Cannot reclaim this identity.")

    # CAPACITY: filling a channel to MAX_MEMBERS must not block a reclaim of an
    # agent's OWN already-counted row.
    cap = "capfull"
    srv.nth_connect(summary="s", name="H", channel=cap)
    db = srv.get_db()
    db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,"
               "joined_at,active,kind) VALUES ('ag_cap',?,'CapBot','','',?,?,1,'agent')",
               (cap, srv.now_iso(), srv.now_iso()))
    db.execute("INSERT INTO agents (id, name, reclaim_secret, created_at) VALUES "
               "('ag_cap','CapBot','sekrit-cap',?)", (srv.now_iso(),))
    # pad up to MAX_MEMBERS distinct members (including host + ag_cap).
    have = db.execute("SELECT COUNT(*) FROM members WHERE channel=?", (cap,)).fetchone()[0]
    for i in range(srv.MAX_MEMBERS - have):
        db.execute("INSERT INTO members (id,channel,name,summary,skills,last_seen,"
                   "joined_at,active,kind) VALUES (?,?,?,'','',?,?,1,'agent')",
                   (f"pad{i}", cap, f"Pad{i}", srv.now_iso(), srv.now_iso()))
    db.commit(); db.close()
    rc = json.loads(srv.nth_connect(summary="a", name="CapBot",
                                    channel=cap, resume_member_id="ag_cap",
                                    reclaim_secret="sekrit-cap"))
    check("reclaim of own row succeeds even when channel is full",
          rc.get("action") == "reclaimed")

    print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
