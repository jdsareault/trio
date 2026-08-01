# Bug: Task board drops task descriptions from the API

**Date:** 2026-08-01
**Priority:** P2 — every task is rendered with the generic label “Task”
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

The Tasks view shows IDs and statuses but replaces the actual task text with the
literal fallback `Task`.

## Root cause

The `/api/tasks` response exposes `description` at
`server/nth_web.py:3884-3907`. The selector in
`server/web/js/20-workspace.js:25-34` only reads `t.message || t.title` and never
reads `t.description`. The blocked-attention adapter at lines 43-45 has the same
schema drift.

## Verification

Passing an actual response-shaped task such as
`{id:1, status:'open', description:'Ship the release'}` to `taskItems()` yields
`title === 'Task'`. Source inspection confirms the endpoint does not add a
`title` or `message` alias. No existing bug report covers this field mismatch.

## Suggested fix

Use `description` as the primary task title/body and add client contract tests
against the real `/api/tasks` shape.

