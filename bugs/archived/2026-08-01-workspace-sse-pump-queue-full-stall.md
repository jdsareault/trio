# Bug: Workspace SSE pump can stall on `queue.Full`

**Date:** 2026-08-01
**Severity:** Warning — message loss across all channels when SSE client is slow
**Discovered during:** LOTC review of `phase-7-ui-updates` (Gandalf, architecture)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The workspace SSE endpoint (`/api/workspace/events`) merges multiple channel event streams into a single SSE feed. If the client is slow to consume (network congestion, browser tab backgrounded), the pump threads that move messages from per-channel queues to the merged queue can stall or fail silently, causing message loss across all channels.

## Root cause

`server/nth_web.py:2556-2562`:

```python
merged: queue.Queue = queue.Queue(maxsize=500)
...
def pump(q):
    while not stop.is_set():
        try:
            payload = q.get(timeout=0.5)
            merged.put(payload)
        except queue.Empty:
            continue
```

The `merged.put(payload)` call on line 2560 is a **blocking** put on a bounded queue (maxsize=500). If the client is slow and the merged queue fills up, the pump thread blocks indefinitely. The `except queue.Empty` only catches the `get` timeout, not a `queue.Full` from `put`.

If the SSE connection dies while pumps are blocked, the `stop.set()` in the finally block (line 2584) will eventually unblock them, but messages that were in the per-channel queues but not yet merged are lost.

## Fix

Use `merged.put(payload, timeout=1.0)` and handle `queue.Full`:

```python
def pump(q):
    while not stop.is_set():
        try:
            payload = q.get(timeout=0.5)
            try:
                merged.put(payload, timeout=1.0)
            except queue.Full:
                if not stop.is_set():
                    sys.stderr.write("[nth_web] workspace SSE pump: merged queue full, dropping payload\n")
        except queue.Empty:
            continue
```

## Verification

1. Open the workspace SSE connection.
2. Throttle the client (e.g., devtools network throttling or background the tab).
3. Send a burst of messages across multiple channels.
4. If the bug is present, the pump threads stall and messages are lost.
5. After the fix, the pump should log a warning and drop the payload rather than blocking forever.

## Reviewer notes

Gandalf traced the pump function and the merged queue. The `EventHub._broadcast` method (line 881-885) already handles `queue.Full` by removing dead subscribers — this is the same pattern that should be applied here.
