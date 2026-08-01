# Bug: Agent creation reads unset store.session.channel — new agents get no channel

**Date:** 2026-08-01
**Severity:** Critical — agent creation silently broken
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness)
**Branch:** `phase-7-ui-updates` at `cef66e0`

---

## Symptom

When the operator creates a new agent via the "New agent" dialog, the agent is
created with an empty `channels` array. The agent is not placed in any channel
and cannot receive messages from any channel. The creation appears to succeed
(no error toast), but the agent is effectively inert.

## Root Cause

`server/web/js/30-agents.js:12` (the `create()` function) reads the channel from
the store:

```js
channels: [Trio.store.get('session.channel')].filter(Boolean)
```

The store's initial state (`01-store.js:6`) sets `session.channel` to an empty
string:
```js
session: { operator: null, token: '', channel: '', dmKey: '', ... },
```

No module ever calls `Trio.store.set('session.channel', value)`. The
`session.channel` slice is initialized to `''` and never updated. When `create()`
reads it, it gets `''`, which `.filter(Boolean)` removes, resulting in `[]`.

The legacy `state.channel` IS populated (by `00-core.js:14,28`), but the agent
module was migrated to read from the store in commit `d2582d7` (task 1.10)
without ensuring `session.channel` is written.

## Fix

Either:
1. Write to `session.channel` when the channel changes. In `00-core.js::boot()`
   after setting `root.state.channel`, also call
   `Trio.store?.set?.('session.channel', root.state.channel)`.
2. Or read from `Trio.state.channel` (the legacy state) in the agent create
   function, as it was before the migration.

Option 1 is preferred — it keeps the store as the single source of truth, which
is the architectural direction.

## Verification

1. Open a channel (e.g., `?channel=general`).
2. Open Agent roster → New agent.
3. Create an agent with any name/provider.
4. Check the API request body — `channels` should be `['general']`, not `[]`.
5. Verify the agent appears in the channel's roster.

## Reviewer notes

Sauron traced this precisely. This is a regression introduced by the task 1.10
migration (commit `d2582d7`) which moved `30-agents.js` from
`Trio.state.channel` to `Trio.store.get('session.channel')` without ensuring the
store slice is populated. The same pattern likely affects
`40-preferences.js:26` (`diagnostics()`) which also reads
`Trio.store.get('session.channel')` — the diagnostics panel will always show an
empty channel.
