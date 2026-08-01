# Bug: Spoke monitor crashes when keepalive rounds an infinite gap

**Date:** 2026-08-01
**Priority:** P1 — remote monitoring terminates for never-engaged members
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

A remote spoke member with old own activity but no prior @/#/! engagement can
crash its monitor when the keepalive event fires.

## Root cause

`engaged_gap` begins as `float('inf')` at
`server/nth_spoke_monitor.py:639-650`. Lines 655-663 pass it to `round()`, which
raises `OverflowError`. The local monitor already fixed the same bug with
`gap_for_emit()` and has a regression test, but the spoke implementation did
not receive the guard.

## Verification

Driving the keepalive condition with one-hour-old own activity and no sigil
engagement raises `OverflowError: cannot convert float infinity to integer`.
No current bug report covers the spoke path.

## Suggested fix

Share the local monitor's finite-gap serialization helper with the spoke monitor
and add the same never-engaged regression case for the remote path.

