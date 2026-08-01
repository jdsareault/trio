# Bug: Valid non-object JSON crashes object-body handlers

**Date:** 2026-08-01
**Priority:** P3 — valid JSON arrays/scalars cause uncaught request exceptions
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

Posting valid JSON such as `[1]` to several JSON endpoints drops the connection
with `AttributeError` instead of returning a client error.

## Root cause

`_read_json_body` is annotated to return a dictionary at
`server/nth_web.py:2588`, but lines 2593-2595 return any value accepted by
`json.loads`. Multiple callers immediately use `.get`, including identify
(`2602-2607`), send (`2630-2636`), channel creation (`3199-3203`), and archive
handlers (`3375-3380`), without checking the decoded type.

## Verification

A decoded `[1]` passes `_read_json_body` and then raises `AttributeError` at the
identify handler's `.get("name")`. Source inspection confirms the same pattern
in the other cited callers. No existing report covers this body-shape contract.

## Suggested fix

Have `_read_json_body` reject non-dictionary top-level values with 400, or make
the expected top-level type an explicit parameter and validate it centrally.

