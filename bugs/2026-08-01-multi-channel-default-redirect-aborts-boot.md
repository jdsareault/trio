# Bug: Multi-channel default redirect aborts boot when the router is present

**Date:** 2026-08-01
**Severity:** Warning — first visit to multi-channel hub renders no UI
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

On a fresh load of `/` when no channel is selected and the hub is in
multi-channel mode, the browser URL is rewritten to `/?channel=<first-channel>`
but the Atrium UI is never mounted. The page shows the static shell with
"Connecting…" and no rail, conversation, or composer. A manual refresh is
required before the app starts.

## Root cause

`server/web/js/00-core.js:31-36` handles the empty-channel, multi-channel case:

```js
if (!root.state.channel && meta.multi) {
  const channels = await root.api.get('/api/channels', false);
  if (channels.channels?.[0]?.code) {
    if (root.router?.replace) { root.router.replace('channel', { code: channels.channels[0].code }); }
    else { location.replace('/?channel=' + encodeURIComponent(channels.channels[0].code)); }
    return false;
  }
}
```

When the router module is loaded, `root.router?.replace` is present, so the code
calls `history.replaceState` and returns `false`. `server/web/js/90-boot.js:4-5`
then aborts:

```js
async function boot() {
  if (!(await Trio.boot())) return;
  ...
}
```

Unlike the `location.replace` branch, the `router.replace` branch does not
reload the page, so `90-boot.js` must continue and mount the features. Returning
`false` leaves the user on a page with no mounted UI.

## Fix

The two simplest options:

1. Always use `location.replace` for this redirect so the browser reloads with
   the selected channel. This is consistent with the no-router branch.
2. Continue the boot after `router.replace`. Since `state.channel` is already
   populated, the rest of `boot()` can call `startEvents` and return `true`, and
   `90-boot.js` will mount the features.

Option 1 is the safest minimal change because the app is already designed around
booting from a concrete channel URL.

## Verification

1. Start the hub in multi-channel mode with at least one channel.
2. Open `http://127.0.0.1:8000/` with no `?channel=` parameter.
3. The URL should change to `/?channel=<first-channel>`.
4. The rail, conversation, and composer should appear immediately.
5. Currently the URL changes but the page remains an unmounted shell.

## Reviewer notes

Sauron found this by tracing `00-core.js::boot()` against the `90-boot.js`
control flow. The router branch was added to avoid a full page reload, but it
fails to continue mounting, so the redirect effectively dead-ends.
