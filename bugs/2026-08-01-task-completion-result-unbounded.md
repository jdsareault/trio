# Bug: Task completion stores and broadcasts an unbounded result

**Date:** 2026-08-01
**Priority:** P2 — oversized input is duplicated into persistent and live data
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

A caller can complete a task with an arbitrarily large result. The full value is
stored in the task and copied into a synthetic channel message, expanding the
database and every downstream history/SSE/client representation.

## Root cause

`server/nth_server.py:2991-2996` writes `result.strip()` without a length cap.
Lines 3040-3051 then concatenate the same unbounded value into `[done #…]` and
insert it as a message. Normal send paths enforce message-size limits, but task
completion bypasses them.

## Verification

Completing a temporary task with a 100,000-character result succeeded. SQLite
stored 100,000 characters in `tasks.result` and 100,017 characters in the
generated message. No existing report describes this amplification path.

## Suggested fix

Define and enforce a result limit before either write, and ensure the synthetic
message remains within the normal message-size contract.

