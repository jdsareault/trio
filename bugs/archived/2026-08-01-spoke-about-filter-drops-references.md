# Bug: Remote `about` filter drops pound references

**Date:** 2026-08-01
**Priority:** P1 — remote agents miss messages their selected filter promises to deliver
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

A remote spoke using filter mode `about` is not notified when a message
`#`-references it.

## Root cause

`should_emit_summary()` at `server/nth_spoke_monitor.py:131-156` relies on
top-level `has_refs` and `has_bangs`. The poll producer at
`server/nth_server.py:2313-2400` emits only top-level `has_mentions`; references
and bangs are represented only by per-message `referenced` / `banged` fields
(and bangs also set `has_mentions`).

## Verification

A server-shaped response containing a message with `referenced: true` but no
top-level `has_refs` evaluates to `(False, None)` in `about` mode. No existing
report covers this producer/consumer mismatch.

## Suggested fix

Emit the three documented aggregate flags independently, or derive them from
the deduplicated message entries in the spoke. Add contract tests using actual
poll response shapes.

