#!/usr/bin/env python3
"""LOTC C: global and local names both wake a channel member."""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_server as srv  # noqa: E402
from nth_web import _parse_sigils_against_roster  # noqa: E402


tmp = Path(tempfile.mkdtemp(prefix="nth-global-wake-"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
failures = []


def check(label, condition):
    print(("PASS" if condition else "FAIL") + ": " + label)
    if not condition:
        failures.append(label)


try:
    local = json.loads(srv.nth_connect(
        summary="wake target", name="Local Alice", channel="wake-room"))
    outsider = json.loads(srv.nth_connect(
        summary="other", name="Global Alice", channel="other-room"))
    target_id = local["member_id"]
    db = srv.get_db()
    db.execute("UPDATE agents SET name='Global Alice' WHERE id=?", (target_id,))
    db.commit()

    at_global, ref_global, bang_global = srv._parse_sigils(
        db, "wake-room", "@Global Alice #Global Alice !Global Alice")
    at_local, ref_local, bang_local = srv._parse_sigils(
        db, "wake-room", "@Local Alice #Local Alice !Local Alice")
    web_at, web_ref, web_bang = _parse_sigils_against_roster(
        db, "wake-room", "@Global Alice #Global Alice !Global Alice")
    check("MCP parser wakes global display name", at_global == [target_id])
    check("MCP parser preserves local display name", at_local == [target_id])
    check("MCP parser unions global/local # and ! names",
          ref_global == [target_id] and bang_global == [target_id] and
          ref_local == [target_id] and bang_local == [target_id])
    check("web parser wakes global display name", web_at == [target_id])
    check("web parser unions global # and ! names",
          web_ref == [target_id] and web_bang == [target_id])
    check("global name never wakes a non-member",
          outsider["member_id"] not in at_global)
    db.close()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
