# Bug: Private fallback replies can be sent to the wrong human

**Date:** 2026-08-01
**Priority:** P1 — private response content can cross conversation boundaries
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

When two people message the same managed agent in quick succession, a plain
model result for the first person's turn can be posted privately to the second
person.

## Root cause

The router queue at `server/nth_web.py:2095-2121` retains agent, channel, text,
and attachments, but not the source message ID/sender/recipients. When a model
does not use Trio tools, both fallback bridges reconstruct the recipient by
scanning for the newest inbox DM addressed to the agent:

- Claude: `server/nth_supervisor.py:417-459`
- Codex: `server/nth_codex_runtime.py:925-955`

That newest DM need not be the turn that produced the result.

## Verification

With Alice's question active, enqueueing a later Bob question before Alice's
plain result caused `answer intended for Alice` to be inserted with recipients
`['bob']`. No existing report covers fallback reply correlation.

## Suggested fix

Carry the originating message ID and sender in the queued turn context and use
that immutable context when bridging a result. Never infer a private recipient
from current inbox history.

