# Bug: App doctor fails healthy Codex-only workspaces

**Date:** 2026-08-01
**Priority:** P2 — dual-provider installations receive a false failure result
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

`nth_app.py doctor` exits 1 and reports runtime trouble when Claude is missing,
even if the workspace and hub are healthy and Codex is the available provider.

## Root cause

`doctor_report()` at `server/nth_app.py:72-79` probes only `ClaudeRuntime`.
`main()` at lines 121-128 makes Claude readiness mandatory for success and does
not consult provider readiness from hub health.

## Verification

With mocked healthy database and Codex-capable hub health but unavailable
Claude, the current success predicate returns exit code 1. No existing report
matches the post-dual-provider diagnostic contract.

## Suggested fix

Report each configured provider and succeed when the database is healthy and at
least one enabled runtime is usable (or use an explicitly configured required
provider set).

