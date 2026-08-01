"""Regression test: the spoke monitor's keepalive/cadence emit must not crash
for a never-engaged member.

bugs/2026-08-01-spoke-keepalive-rounds-infinity.md: engaged_gap starts as
float('inf') and the old spoke code did round(engaged_gap) directly at emit
time, raising OverflowError for any remote spoke member with old own activity
but no prior @/#/! engagement. The local monitor already fixed the same class
of bug with gap_for_emit(); the spoke now imports and uses that same helper.

Usage: python test-spoke-keepalive-overflow.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_spoke_monitor as spoke  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


# 1. The inf sentinel originates from the real seconds_since(None) — the exact
#    state of a member who was never sigil-engaged.
engaged_gap = spoke.seconds_since(None)
check("seconds_since(None) is inf sentinel", engaged_gap == float("inf"))

# 2. Confirm the regression is real: round(inf) genuinely raises.
raised = False
try:
    round(engaged_gap)
except OverflowError:
    raised = True
check("round(inf) still raises OverflowError (regression guard)", raised)

# 3. The fix: gap_for_emit (imported from nth_monitor) maps inf -> None.
check("gap_for_emit(inf) is None", spoke.gap_for_emit(engaged_gap) is None)
check("gap_for_emit(3600.4) == 3600", spoke.gap_for_emit(3600.4) == 3600)

# 4. End-to-end: build the actual keepalive event shape the spoke emits and
#    confirm it serializes cleanly for a one-hour-old own activity + never
#    engaged member (the bug's exact repro).
own_gap = 3600.0
event = {
    "event": "keepalive",
    "gap_seconds": spoke.gap_for_emit(own_gap),
    "threshold_seconds": spoke.KEEPALIVE_THRESHOLD,
    "engaged_gap_seconds": spoke.gap_for_emit(engaged_gap),
}
serialized = None
try:
    serialized = json.dumps(event)
except (OverflowError, ValueError, TypeError) as e:
    check(f"keepalive event serializes (raised {e!r})", False)
if serialized is not None:
    payload = json.loads(serialized)
    check("keepalive event serializes cleanly", True)
    check("engaged_gap_seconds serializes as null", payload["engaged_gap_seconds"] is None)
    check("gap_seconds serializes as rounded int", payload["gap_seconds"] == 3600)

if failures:
    print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
    sys.exit(1)
print("\nAll checks passed.")
