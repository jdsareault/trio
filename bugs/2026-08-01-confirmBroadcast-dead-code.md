# Bug: `confirmBroadcast` flag is never set — broadcast confirmation is dead code

**Date:** 2026-08-01
**Severity:** Warning — dead code, intended safety feature silently disabled
**Discovered during:** LOTC review of `phase-7-ui-updates` (Frodo, UX)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The composer has code intended to show a confirmation dialog before broadcasting a message to the channel, but the flag that gates it (`state.confirmBroadcast`) is never initialized or set anywhere in the codebase. The confirmation never appears.

## Root cause

`server/web/js/12-composer.js:103`:

```js
if (!body.recipients?.length && state.confirmBroadcast && !window.confirm('Send this message to the channel?')) { updateSendState(); return false; }
```

`state.confirmBroadcast` is never assigned. A search across the entire `server/web/` tree confirms it appears only on this one line — never in `01-store.js` (the initial state), never in `40-preferences.js` (which would be the natural place for a preference toggle), and never in any other module.

## Fix

Either:
1. **Remove the dead code** if broadcast confirmation is not a desired feature, or
2. **Wire it up** by adding `confirmBroadcast: false` to the store's `composer` slice in `01-store.js` and exposing a preference toggle in `40-preferences.js`.

## Verification

1. Type a message and press Enter.
2. If the flag were set, a `window.confirm` dialog would appear asking "Send this message to the channel?"
3. Currently, no dialog appears — the message sends immediately.

## Reviewer notes

Frodo flagged this as a UX gap. The code also uses `window.confirm` (already filed in `bugs/2026-08-01-window-alert-prompt-in-conversation.md`), so if this feature is wired up, it should use `Trio.ui.confirmAction()` instead.
