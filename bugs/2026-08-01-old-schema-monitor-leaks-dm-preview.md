# Bug: Old-schema monitor fallback leaks private DM previews

**Date:** 2026-08-01
**Priority:** P1 — a monitor can expose another member's private message content
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

On an upgraded database missing newer sigil columns, an agent monitor can emit a
notification preview containing a DM addressed to a different member.

## Root cause

The primary query at `server/nth_monitor.py:363-369` selects `recipients` and
`member_id`, but both OperationalError fallbacks at lines 370-384 omit them.
The visibility filter at lines 396-403 substitutes an empty recipient list and
therefore treats every fallback row as a broadcast.

## Verification

Against a schema that takes the fallback path, a message with
`recipients=['m3']` caused the monitor for `m1` to emit the `TOP SECRET` preview.
No existing report covers this migration-path privacy failure.

## Suggested fix

Fallback queries must retain all privacy columns that exist at the schema level
being supported; only optional sigil columns should be removed. If recipients
cannot be read, fail closed instead of treating the row as broadcast.

