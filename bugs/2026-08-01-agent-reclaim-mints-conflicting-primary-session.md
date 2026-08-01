# Bug: Agent identity reclaim mints a conflicting primary session

**Date:** 2026-08-01
**Priority:** P1 — an unrelated caller can assume another agent's private identity
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

Any tool caller that knows an existing agent ID can reconnect with that ID,
receive the agent's targeted recent messages, and obtain a second primary token
that can post as the agent.

## Root cause

The reclaim path at `server/nth_server.py:868-904` verifies only that the target
row has `kind='agent'`. It has no reconnect secret or proof that the caller owns
the existing session. The normal connect response then gathers history and
mints another `role='primary'` session at lines 1015-1075.

## Verification

After creating `ag_v` and sending it a targeted private work item, an unrelated
connect using `resume_member_id='ag_v'` returned `action='reclaimed'`, a new
primary token, and the private item in `recent_messages`; the new token was then
accepted for a send as `ag_v`. This is not covered by the existing sentinel tool
scope report.

## Suggested fix

Bind reclaim to a supervisor-issued one-time capability (or an existing session
credential), and revoke/rotate it after use. Do not treat a public member ID as
proof of ownership.

