#!/usr/bin/env python3
"""bugs/2026-08-01-spoke-about-filter-drops-references.md: should_emit_summary()
must honor a real trio_poll response shape, where has_mentions/has_refs/
has_bangs are three INDEPENDENT top-level flags (matching nth_monitor.py's
wake-event contract) — not has_mentions conflating mentions and bangs while
has_refs never appears at all.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_server as srv  # noqa: E402
import nth_spoke_monitor as spoke  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS" if condition else "FAIL") + ": " + name)
    if not condition:
        failures.append(name)


# A real poll response shape for a message that only #references this member
# (no @mention, no !bang): has_refs is the only aggregate flag set.
pound_only = {"event": "new_messages", "has_refs": True}
mention_only = {"event": "new_messages", "has_mentions": True}
bang_only = {"event": "new_messages", "has_bangs": True}
ambient = {"event": "new_messages"}

woke, kind = spoke.should_emit_summary(pound_only, "about")
check("about mode wakes on a real has_refs=True response", woke)
check("about-mode pound wake is tagged 'pound'", kind == "pound")

woke, _ = spoke.should_emit_summary(pound_only, "at")
check("at mode does NOT wake on a pound-only response", not woke)

woke, kind = spoke.should_emit_summary(mention_only, "about")
check("about mode still wakes on has_mentions=True", woke)
check("about-mode mention wake is tagged 'at'", kind == "at")

woke, kind = spoke.should_emit_summary(bang_only, "about")
check("about mode wakes on has_bangs=True regardless of filter", woke)
check("bang wake is tagged 'bang'", kind == "bang")

woke, _ = spoke.should_emit_summary(ambient, "about")
check("about mode does NOT wake on a purely ambient response", not woke)

woke, _ = spoke.should_emit_summary(ambient, "all")
check("all mode wakes on ambient traffic", woke)

# --- End-to-end: the real trio_poll response must carry has_refs ------------
tmp = tempfile.mkdtemp(prefix="nth-spoke-about-")
srv.DB_DIR = Path(tmp)
srv.DB_PATH = Path(tmp) / "nth.db"
alice = json.loads(srv.nth_connect(summary="a", name="Alice", channel="spk"))["member_id"]
bob = json.loads(srv.nth_connect(summary="b", name="Bob", channel="spk"))["member_id"]
srv.nth_poll(channel="spk", member_id=bob, wait_seconds=0)  # clear the join backlog
srv.nth_send(channel="spk", member_id=alice, message=f"hey #{bob} check this out")
real_resp = json.loads(srv.nth_poll(channel="spk", member_id=bob, wait_seconds=0))
check("real trio_poll response for a #ref carries top-level has_refs",
      real_resp.get("has_refs") is True)
woke, kind = spoke.should_emit_summary(real_resp, "about")
check("about-mode spoke wakes on the real #ref poll response", woke)
check("real #ref response wake is tagged 'pound'", kind == "pound")

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
