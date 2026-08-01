# Bug: Tokenless spoke reuses stale aggregate flags for new messages

**Date:** 2026-08-01
**Priority:** P2 — ambient remote messages can falsely wake filtered agents
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

In tokenless polling mode, an old mention in the repeatedly-returned backlog can
make a later ambient-only message wake an `about`/`at` spoke.

## Root cause

`server/nth_spoke_monitor.py:523-555` correctly derives `new_msgs` using its
local high-water mark, but calls `should_emit_summary(poll, filter_mode)` on the
whole poll response. Its aggregate flags describe the full repeated backlog,
not just `new_msgs`.

## Verification

With old mention ID 1 followed by new ambient ID 2, the second emitted event
contained only message ID 2 and the ambient preview, but still carried
`has_mentions=true` and woke. No existing report matches this stale-flag issue.

## Suggested fix

Compute wake flags solely from `new_msgs` after deduplication (which also solves
schema drift in aggregate response flags).

