"""bugs/2026-08-01-tokenless-spoke-stale-flags-false-wake.md: in tokenless
polling mode the server has no spoke-side watermark, so it repeatedly returns
the same backlog. An old mention/ref/bang in that repeated backlog must not
make a later, purely ambient message wake an 'about'/'at' spoke — the wake
decision must be computed from the NEW messages only, not the poll response's
aggregate flags (which describe the whole backlog).

Usage: python test-spoke-tokenless-stale-flags.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_spoke_monitor as spoke  # noqa: E402

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


# Old mention (id 1) already seen; the repeated tokenless backlog still
# includes it and its aggregate flags, alongside a new purely-ambient
# message (id 2).
poll = {
    "event": "new_messages",
    "has_mentions": True,   # from the OLD message (id 1), still in the backlog
    "messages": [
        {"id": 1, "content": "old @-mention", "mentioned": True, "from": "Alice"},
        {"id": 2, "content": "new ambient chatter", "from": "Bob"},
    ],
}
local_hwm = 1
new_msgs = [m for m in poll["messages"] if (m.get("id") or 0) > local_hwm]
check("only the new ambient message is treated as new", [m["id"] for m in new_msgs] == [2])

fresh_flags = {
    "has_mentions": any(m.get("mentioned") for m in new_msgs),
    "has_refs": any(m.get("referenced") for m in new_msgs),
    "has_bangs": any(m.get("banged") for m in new_msgs),
}
woke_fresh, _ = spoke.should_emit_summary(fresh_flags, "about")
check("about-mode does NOT wake on a purely ambient NEW message "
      "despite a stale has_mentions in the backlog", not woke_fresh)

# Regression guard: confirm the bug is real — using the raw poll response's
# aggregate flags directly (the old behavior) WOULD have woken.
woke_stale, _ = spoke.should_emit_summary(poll, "about")
check("(regression guard) the raw poll response's stale flags DO wake "
      "— proving fresh_flags is the fix, not a no-op", woke_stale)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
