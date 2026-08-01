# Bug: Spoke POST failures leak pending request entries

**Date:** 2026-08-01
**Priority:** P3 — repeated transport failures grow the pending map indefinitely
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

Each immediate HTTP POST failure in the spoke MCP client leaves an unreachable
request queue stored in `_pending`.

## Root cause

`server/nth_spoke_monitor.py:386-398` inserts `_pending[rid]` before calling
`_post(body)`. Cleanup exists only in the later `queue.Empty` timeout handler;
if `_post` raises, control never reaches that handler.

## Verification

Simulating three immediate `_post` failures left all three request IDs in
`_pending`. No existing report covers this transport-error path.

## Suggested fix

Wrap both POST and wait in `try/finally` and remove the exact request entry on
every success or failure path.
