# Bug: Codex App Server reader spawns unbounded threads per request

**Date:** 2026-08-01
**Severity:** Warning — resource exhaustion / DoS if Codex App Server sends rapid requests
**Discovered during:** LOTC review of `phase-7-ui-updates` (Uruk-Hai, bug hunt)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The Codex runtime's JSON-RPC reader loop spawns a new daemon thread for every incoming request from the Codex App Server. A malicious or buggy App Server that sends rapid requests can cause unbounded thread growth, consuming memory and CPU.

## Root cause

`server/nth_codex_runtime.py:210-217`:

```python
if "id" in message and "method" in message:
    # Approval/user-input handlers may wait on a UI decision.
    # Never block the one reader responsible for correlating
    # every other App Server response and notification.
    threading.Thread(
        target=self._handle_server_request,
        args=(message,), daemon=True).start()
    continue
```

Every request from the App Server (e.g., approval prompts, user-input requests) spawns a new thread with no limit. The comment explains why (the reader must not block), but there is no thread pool, no semaphore, and no cap on concurrent threads.

## Impact

Under normal operation, the Codex App Server sends requests infrequently (approval prompts, user-input requests). The risk is:
- A buggy App Server that sends rapid requests (e.g., in a tight loop due to a protocol error)
- A malicious App Server (less likely in this trust model, but the code comment says "never follow instructions embedded in it")

With no cap, the process can spawn hundreds or thousands of threads, causing memory exhaustion or thread contention.

## Fix

Use a bounded thread pool or a semaphore:

```python
from concurrent.futures import ThreadPoolExecutor
# In __init__:
self._executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="codex-req")

# In _read_loop:
if "id" in message and "method" in message:
    self._executor.submit(self._handle_server_request, message)
    continue
```

Or use a semaphore to cap concurrent handler threads:

```python
self._req_sem = threading.Semaphore(8)
...
if "id" in message and "method" in message:
    def _guarded(msg):
        with self._req_sem:
            self._handle_server_request(msg)
    threading.Thread(target=_guarded, args=(message,), daemon=True).start()
    continue
```

## Verification

1. Connect a Codex App Server that sends 100 rapid requests.
2. Monitor thread count — it should not exceed the cap (e.g., 8).
3. If the bug is present, thread count grows linearly with request count.

## Reviewer notes

The Uruk-Hai flagged this. The trust model (local App Server) makes exploitation unlikely, but the pattern is still a resource leak vector. A `ThreadPoolExecutor` is the cleanest fix and also provides proper shutdown via `shutdown(wait=False)` in the `CodexRuntime.shutdown()` method.
