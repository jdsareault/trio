# Bug: Claude crash retains stale result-routing context

**Date:** 2026-08-01
**Priority:** P2 — a post-restart result can be bridged to an earlier channel
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

If a managed Claude process dies during a turn and is later woken, its next
plain result can consume the dead turn's context and be posted to the wrong
channel.

## Root cause

Lifecycle stop/hibernate paths call `_forget_pending()`, but out-of-band crash
reaping in `server/nth_supervisor.py:700-713` removes the process and marks it
errored without clearing `_pending`. `wake()` at lines 574-593 also preserves
the deque. `_bridge_result()` then pops the oldest entry at lines 417-421.

## Verification

A dead process passed through `reconcile()` was removed and marked errored while
its pending deque remained unchanged. After a new turn is appended, the next
result pops the stale entry first. No existing report covers this routing state.

## Suggested fix

Clear pending turn contexts whenever a process is reaped, and test crash → wake
→ new result across two channels.

