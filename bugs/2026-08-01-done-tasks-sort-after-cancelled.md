# Bug: Done tasks sort after cancelled tasks

**Date:** 2026-08-01
**Priority:** P3 — task-board ordering contradicts its documented priority
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

The task API orders done tasks after cancelled tasks, despite documenting active
work followed by completed work and then cancellations.

## Root cause

The CASE expression at `server/nth_web.py:3875-3889` assigns priority 3 to the
status string `completed`. Task completion actually stores `done` at
`server/nth_server.py:2991-2995`, so done rows fall into the `ELSE 5` bucket,
after cancelled rows at priority 4.

## Verification

Executing the current CASE expression over rows with statuses `done` and
`cancelled` orders `cancelled` first. Repository searches confirm production
task transitions use `done`, not `completed`, and no existing report matches.

## Suggested fix

Use `done` in the sort expression (and align the handler docstring with the
canonical status vocabulary).
