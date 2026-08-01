"""bugs/2026-08-01-spoke-post-failure-leaks-pending-request.md: each immediate
_post() failure (connection refused, DNS, "not connected") must not leave an
unreachable entry in _pending — nothing will ever arrive on the SSE stream to
resolve it, since the POST never went out.

Usage: python test-spoke-post-failure-pending-leak.py
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


client = spoke.MCPSSEClient("http://127.0.0.1:1")
# endpoint_url is None until the SSE stream delivers the server's `endpoint`
# event, so _post() always raises "Not connected" here — a deterministic,
# offline stand-in for any immediate POST failure.
check("client starts with no endpoint (pre-connect)", client.endpoint_url is None)

for i in range(3):
    rid = client._next_request_id()
    raised = False
    try:
        client._post_and_wait({"jsonrpc": "2.0", "id": rid, "method": "ping"}, timeout=1)
    except RuntimeError:
        raised = True
    check(f"immediate POST failure #{i + 1} raises", raised)

check("no pending request entries leaked after 3 immediate failures",
      len(client._pending) == 0)

print()
print(f"{'FAILED' if failures else 'OK'} — {len(failures)} failure(s)")
raise SystemExit(1 if failures else 0)
