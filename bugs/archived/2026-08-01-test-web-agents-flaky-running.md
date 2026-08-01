# Bug: `tests/test-web-agents.py` is flaky on `create: agents row running`

**Date:** 2026-08-01
**Severity:** Low — test reliability
**Discovered during:** LOTC review of `phase-7-ui-updates` (Uruk-Hai, bug hunt)
**Branch:** `phase-7-ui-updates` at `d2582d7`

---

## Symptom

`python3 tests/test-web-agents.py` occasionally fails at:

```
FAIL: create: agents row running
```

Re-running the test usually passes. The failure was observed once during the
LOTC review and passed on the next run.

## Root cause

`tests/test-web-agents.py:95-96` reads the `agents` DB row immediately after the
`POST /api/agents` returns 200:

```python
r = row(aid)
check("create: agents row running", r and r["state"] == "running")
```

`server/nth_web.py:3719-3747` spawns the agent through the supervisor and then
returns. The supervisor's `_set_state(agent_id, ST_RUNNING, ...)` in
`nth_supervisor.py:557` runs inside `spawn()` after the process proves it is
alive, but there is a small window between the HTTP response and the DB
`UPDATE` committing. On a loaded machine the test can win the race and read the
row while `state` is still `spawning`.

## Fix

Two options, both low risk:

1. **Make the test robust:** add a short retry around the state check (e.g.,
   `time.sleep(0.1)` or poll for up to 1 second) before failing.
2. **Make the endpoint deterministic:** have `create_agent` wait until the
   supervisor has persisted `running` before returning the HTTP response. This is
   heavier but makes the contract predictable.

Option 1 is preferred for a test-only race.

## Verification

1. Run `python3 tests/test-web-agents.py` ten times.
2. The `create: agents row running` check should pass every time.
3. If the fix is a retry, instrument the retry to confirm it occasionally needs
   one extra poll.

## Reviewer notes

Uruk-Hai found the failure during adversarial testing. The test was run again
immediately after the failure and passed. It is not a product bug, but a flaky
assertion that could mask real agent lifecycle regressions in CI.
