# Bug: History replay with `from_id` has no response limit

**Date:** 2026-08-01
**Priority:** P2 — one history call can materialize and serialize the full channel
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

`trio_history(from_id=0)` returns every message in a channel, with response size
and query cost growing without bound.

## Root cause

Although `last_n` is capped to 100 at `server/nth_server.py:2605`, both
`from_id` query branches at lines 2625-2631 and 2641-2647 call `fetchall()` with
no `LIMIT`. `from_id` intentionally changes the selection point, but there is no
independent maximum page size or continuation cursor.

## Verification

Against a temporary database containing 251 messages, normal
`last_n=100` returned 100 while `from_id=0` returned all 251. The same unbounded
SQL appears in both current-schema and fallback-schema paths. No existing report
matches this behavior.

## Suggested fix

Apply a fixed page limit to `from_id` replay and return a continuation marker so
callers can page deliberately.

