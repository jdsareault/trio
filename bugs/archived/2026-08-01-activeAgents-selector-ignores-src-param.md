# Bug: `activeAgents` selector ignores its `src` parameter

**Date:** 2026-08-01
**Severity:** Warning — selector is not composable, breaks test/preview use
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The `selectors.activeAgents()` function accepts a `src` parameter (intended to allow operating on alternate state sources, e.g. in tests or previews) but ignores it, always reading from the module-level `state.agents`. This makes the selector non-composable — calling `selectors.activeAgents({ agents: [...] })` returns the count from the real state, not the provided fixture.

## Root cause

`server/web/js/20-workspace.js:22`:

```js
activeAgents(src = state) { return (state.agents || []).filter(a => ['working','active','idle'].includes(a.status)).length; },
```

The parameter is `src` but the body uses `state.agents` instead of `src.agents`. Compare to the neighboring selectors on lines 19-21 which correctly use `src`:

```js
pendingApprovals(src = state) { return (src.approvals || []).filter(...).length; },
openTasks(src = state) { return (src.tasks || []).filter(...).length; },
blockedAgents(src = state) { return (src.agents || []).filter(...).length; },
```

## Fix

Change `state.agents` to `src.agents` on line 22:

```js
activeAgents(src = state) { return (src.agents || []).filter(a => ['working','active','idle'].includes(a.status)).length; },
```

## Verification

1. Call `selectors.activeAgents({ agents: [{ status: 'working' }] })` in a test.
2. If the bug is present, it returns the count from the real `state.agents` instead of `1`.
3. After the fix, it returns `1`.

## Reviewer notes

Sauron traced the parameter usage. The `unreadDms` (line 23) and `recentChannels` (line 24) selectors correctly use `src`, so this is an isolated oversight in `activeAgents`.
