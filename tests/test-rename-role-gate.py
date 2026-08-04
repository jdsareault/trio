#!/usr/bin/env python3
"""nth_rename must enforce the primary-role capability gate (like send/dm/ask/
claim). A read_only sub-agent token could otherwise rename the member — a
mutation, and (post-P1 global name resolution) a lever for display-name
squatting / DM misdirection. Surfaced during the P3 review pass.
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_server as srv  # noqa: E402

failures = []


def check(label, cond):
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures.append(label)


tmp = Path(tempfile.mkdtemp(prefix="nth-rename-role-"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
try:
    c = json.loads(srv.nth_connect(summary="a", name="A", channel="ch"))
    mid, primary = c["member_id"], c["session_token"]
    db = srv.get_db()
    ro = srv._mint_session_token(db, mid, "ch", role="read_only")
    db.commit()
    db.close()

    r_ro = json.loads(srv.nth_rename(channel="ch", member_id=mid, new_name="Hacker", session_token=ro))
    check("read_only token cannot rename",
          "error" in r_ro and "cannot rename" in r_ro["error"])

    r_pr = json.loads(srv.nth_rename(channel="ch", member_id=mid, new_name="Renamed", session_token=primary))
    check("primary token can rename", r_pr.get("ok") is True and r_pr.get("name") == "Renamed")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
