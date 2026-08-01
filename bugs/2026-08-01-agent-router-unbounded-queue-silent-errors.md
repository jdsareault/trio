# Bug: AgentRouter queue is unbounded and silently swallows errors

**Date:** 2026-08-01
**Severity:** Warning — unbounded memory growth under load, silent message loss on errors
**Discovered during:** LOTC review of `phase-7-ui-updates` (Gandalf, architecture)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The `AgentRouter` in `server/nth_web.py` uses an unbounded `queue.Queue()` for routing messages to agents, and both its poll loop and worker loop swallow all exceptions with bare `except Exception: pass`. Under high message volume, the queue can grow without limit. If message routing fails (e.g., database corruption, provider crash), the failure is completely silent — messages are dropped with no log entry.

## Root cause

**Unbounded queue** — `server/nth_web.py:2040`:
```python
self._q: "queue.Queue" = queue.Queue()
```
Compare to `EventHub.subscribe` (line 819) which uses `queue.Queue(maxsize=200)` and `_broadcast` (lines 881-885) which removes dead subscribers on `queue.Full`.

**Silent error swallowing** — `server/nth_web.py:2057`:
```python
except Exception:
    pass
```
And `server/nth_web.py:2122`:
```python
except Exception:
    pass
```

Compare to `EventHub._run` (line 1060-1061) which logs poll errors, and `StallWatchdog._run` (line 1174-1175) which logs tick errors.

## Impact

- **Unbounded queue:** A burst of messages across many channels (e.g., 20 agents in 10 channels) can cause the queue to grow indefinitely if the single worker thread can't keep up (cold-start wake blocks for up to ~10s per agent). This consumes unbounded memory.
- **Silent errors:** If `wake_agent` or `self.sup.feed` fails (e.g., provider runtime crash, MCP config error), the error is silent and the agent never receives the message. The operator has no way to know routing failed.

## Fix

1. Add a `maxsize` to `AgentRouter._q` (e.g., 1000) and handle `queue.Full` by logging a warning.
2. Add logging to both `except Exception: pass` blocks:
   ```python
   except Exception as exc:
       logging.warning("AgentRouter tick failed: %s", exc)
   ```
   ```python
   except Exception as exc:
       logging.warning("AgentRouter worker failed for agent %s: %s", aid, exc)
   ```

## Verification

1. Under high message volume, monitor the queue size — it should not grow without bound.
2. Force a routing failure (e.g., stop the Codex App Server) and verify a warning is logged.

## Reviewer notes

Gandalf traced the queue creation and exception handling. The EventHub and StallWatchdog already follow the bounded-queue + logging pattern, so this is an inconsistency rather than a new design decision.
