# Bug: Nonnumeric Content-Length drops JSON requests without a response

**Date:** 2026-08-01
**Priority:** P3 — malformed requests escape normal 400 handling
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

A JSON endpoint request with a nonnumeric `Content-Length` causes an uncaught
exception and connection drop instead of a structured 400 response.

## Root cause

At `server/nth_web.py:2588-2590`, `int(self.headers.get(...))` runs before the
`try` block that catches malformed bodies. Its `ValueError` is therefore not
handled by `_read_json_body`.

## Verification

Directly invoking `_read_json_body` with `Content-Length: not-a-number` raises
`ValueError`. The exception handler begins only at line 2593. No existing report
covers malformed length parsing.

## Suggested fix

Parse and validate `Content-Length` inside the guarded block and return the same
400 response used for missing or oversized bodies.

