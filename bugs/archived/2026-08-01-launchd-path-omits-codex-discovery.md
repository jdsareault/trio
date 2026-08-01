# Bug: LaunchAgent PATH discovery omits the Codex executable directory

**Date:** 2026-08-01
**Priority:** P2 — Codex agents can fail only when the hub runs as a service
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

A Codex CLI installed outside the hardcoded system/Homebrew directories may be
available in the user's shell but unavailable to the installed nth LaunchAgent.

## Root cause

`service_path()` at `server/nth_launchd.py:24-33` adds the directory discovered
by `shutil.which('claude')`, but never performs the equivalent discovery for
`codex`. LaunchAgents do not inherit the interactive shell PATH.

## Verification

With a mocked Codex path in a custom bin directory, `service_path()` queried only
`claude` and omitted the Codex directory from the generated PATH. No existing
report covers Codex service discovery.

## Suggested fix

Include the resolved parent directories of every supported runtime executable,
including both `claude` and `codex`, with deterministic deduplication.

