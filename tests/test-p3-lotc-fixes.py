#!/usr/bin/env python3
"""P3 phase-end LOTC fixes:
  - CRITICAL (Aragorn): global display-name squatting must not silently
    misdirect a DM — an ambiguous name (>1 global identity) is REJECTED.
  - WARNING (Sauron): the global DM inbox transport cannot be ended, and is
    hidden from nth_list.
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_server as srv  # noqa: E402
from nth_constants import AGENT_INBOX_CHANNEL  # noqa: E402

failures = []


def check(label, cond):
    print(("PASS" if cond else "FAIL") + ": " + label)
    if not cond:
        failures.append(label)


tmp = Path(tempfile.mkdtemp(prefix="nth-p3-lotc-"))
srv.DB_DIR = tmp
srv.DB_PATH = tmp / "nth.db"
try:
    # ── name-squatting: two identities named "Bob", DM by name must reject ──
    attacker = json.loads(srv.nth_connect(summary="x", name="Bob", channel="throwaway"))["member_id"]
    real_bob = json.loads(srv.nth_connect(summary="x", name="Bob", channel="topic-y"))["member_id"]
    alice = json.loads(srv.nth_connect(summary="x", name="Alice", channel="topic-y"))["member_id"]
    r = json.loads(srv.nth_dm(channel="topic-y", member_id=alice, message="secret", to="Bob"))
    check("ambiguous global name is rejected, not silently misdirected",
          "error" in r and "ambiguous" in r["error"].lower())
    check("no DM row was created for the squatter", "message_id" not in r)

    # A unique name still resolves; addressing by member_id always works.
    r2 = json.loads(srv.nth_dm(channel="topic-y", member_id=alice, message="hi", to="Alice"))
    # Alice is the only "Alice" → resolves to alice (self-DM allowed).
    check("a unique display name still resolves", "message_id" in r2)
    r3 = json.loads(srv.nth_dm(channel="topic-y", member_id=alice, message="hi bob", to=real_bob))
    check("addressing by exact member_id disambiguates past the squatter",
          r3.get("recipients") == [real_bob])

    # ── inbox transport protection ──
    ended = json.loads(srv.nth_end(channel=AGENT_INBOX_CHANNEL, member_id=alice))
    check("the global DM inbox cannot be ended",
          "error" in ended and "cannot be ended" in ended["error"])
    listed = json.loads(srv.nth_list())
    codes = [c["channel"] for c in listed.get("channels", [])]
    check("the global DM inbox is hidden from nth_list", AGENT_INBOX_CHANNEL not in codes)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
