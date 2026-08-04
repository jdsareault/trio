#!/usr/bin/env python3
"""Unit 4: one agent keeps one identity across channels end to end."""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_server as srv  # noqa: E402
from nth_web import resolve_display_name  # noqa: E402


failures = []


def check(label, condition):
    print(("PASS" if condition else "FAIL") + ": " + label)
    if not condition:
        failures.append(label)


tmp = Path(tempfile.mkdtemp(prefix="nth-global-e2e-"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
try:
    first = json.loads(srv.nth_connect(
        summary="one identity", name="Alice", channel="e2e-a", model="opus"))
    member_id = first["member_id"]
    secret = first["reclaim_secret"]
    # Establish a second channel independently, then reclaim into it with a
    # changed local display name to prove the global agent name wins.
    json.loads(srv.nth_connect(summary="channel owner", name="Bob", channel="e2e-b"))
    second = json.loads(srv.nth_connect(
        summary="same identity", name="Alice Reconnected", channel="e2e-b",
        resume_member_id=member_id, reclaim_secret=secret))
    check("reclaim across channels keeps one canonical member id",
          second.get("member_id") == member_id)
    check("reclaim across channels succeeds with the captured secret",
          second.get("reclaim_secret") == secret)

    db = srv.get_db()
    agent_rows = db.execute(
        "SELECT id, name, reclaim_secret FROM agents WHERE id=?", (member_id,)
    ).fetchall()
    placements = db.execute(
        "SELECT channel FROM members WHERE id=? AND channel != ? ORDER BY channel",
        (member_id, srv.AGENT_INBOX_CHANNEL),
    ).fetchall()
    check("one global agents row backs both channel placements",
          len(agent_rows) == 1 and [row[0] for row in placements] == ["e2e-a", "e2e-b"])
    check("web resolver uses the global name from either channel",
          resolve_display_name(db, member_id) == "Alice")
    db.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
