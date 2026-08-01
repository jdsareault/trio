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

    # Hub pre-creates the agent's member row, then the agent reclaims it.
    db = srv.get_db()
    db.execute("INSERT INTO members (id, channel, name, summary, skills, "
               "last_seen, joined_at, active) VALUES "
               "('ag_x','rt','Aragorn','','',?,?,1)", (srv.now_iso(), srv.now_iso()))
    db.commit(); db.close()
    before = srv.get_db().execute(
        "SELECT COUNT(*) FROM members WHERE channel='rt'").fetchone()[0]
    r2 = json.loads(srv.nth_connect(summary="agent", name="Aragorn",
                                    channel="rt", resume_member_id="ag_x"))
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

    # Reclaim with an id that has no row yet: create with THAT id, action=joined.
    r3 = json.loads(srv.nth_connect(summary="a", name="Gimli",
                                    channel="rt", resume_member_id="ag_y"))
    check("reclaim absent-row: creates with fixed id, action=joined",
          r3.get("member_id") == "ag_y" and r3.get("action") == "joined")

    # Reclaim into a BRAND-NEW channel (create branch) keeps the fixed id.
    r4 = json.loads(srv.nth_connect(summary="a", name="Boromir",
                                    channel="fresh-chan", resume_member_id="ag_z"))
    check("reclaim in new channel: fixed id preserved",
          r4.get("member_id") == "ag_z" and r4.get("action") == "created")

    print(f"\n{'OK' if failures == 0 else 'FAILED'} — {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
