# Bug: EventHub can enqueue live messages ahead of primed history

**Date:** 2026-08-01
**Priority:** P2 — a new SSE connection can render conversation history out of order
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

If a message arrives while a subscriber is being initialized, the new message
can appear before older primed history, and it can be delivered twice.

## Root cause

`EventHub.subscribe()` publishes the queue in `_subs` under the lock at
`server/nth_web.py:819-823`, releases the lock, and only then primes roster and
history at lines 824 and 843-857. `_broadcast()` can therefore enqueue message N
before priming enqueues the roster, older messages, and N again.

The conversation client deduplicates IDs, but its incremental path at
`server/web/js/11-conversation.js:318-340` appends unseen cards rather than
sorting them. The duplicate N replaces its existing card in place, so it does
not repair older cards appended after it.

## Verification

Simulating the permitted interleaving produced queue order
`[message 10, roster, message 9, message 10]`. Tracing `upsert()` leaves message
10 before message 9 until an unrelated full render. No current bug report
describes this subscription/prime race.

## Suggested fix

Create a consistent snapshot/cursor before publishing the subscriber, or hold a
suitable lock while priming and registering so live delivery begins strictly
after the snapshot. The client should also re-sort on out-of-order insertion as
defense in depth.

