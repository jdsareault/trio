# Bug: Router serializes archived channel/DM URLs without the archived flag

**Date:** 2026-08-01
**Severity:** Warning — archived state is lost on refresh/share
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

Navigating to an archived channel or DM and then refreshing the page loads the
conversation in live (read/write) mode. The `archived=1` query parameter is
dropped by client-side navigation, so archived URLs cannot be shared or
bookmarked.

## Root cause

`server/web/js/03-router.js:16-20` serializes routes like this:

```js
function serialize(route) {
  if (route.name === 'dm') return '/?dm=' + encodeURIComponent(route.params.key);
  if (route.name === 'audit') return '/?dm=' + encodeURIComponent(route.params.key) + '&archived=1';
  if (route.name === 'channel') return '/?channel=' + encodeURIComponent(route.params.code);
  return '/';
}
```

The `channel` and `dm` branches ignore `route.params.archived`. `parse()` reads
`archived` from the query string, but `serialize()` never writes it for those
routes.

`20-workspace.js:57` and `:84` call `Trio.router.navigate` with `archived` set
for archived views:

```js
Trio.router.navigate('channel', { code, archived: readOnly });
Trio.router.navigate('dm', { key: dm.key, archived: readOnly });
```

The resulting URL is `/?channel=foo` or `/?dm=foo` even when `archived` is
`true`. A refresh drops the archived state.

## Fix

Include the `archived` flag in `serialize()`:

```js
function serialize(route) {
  const extra = route.params.archived ? '&archived=1' : '';
  if (route.name === 'dm' || route.name === 'audit') {
    return '/?dm=' + encodeURIComponent(route.params.key) + extra;
  }
  if (route.name === 'channel') {
    return '/?channel=' + encodeURIComponent(route.params.code) + extra;
  }
  return '/';
}
```

`parse()` already turns `?dm=foo&archived=1` into the `audit` route, so DM
archives will round-trip correctly.

## Verification

1. Open an archived channel or archived DM.
2. Copy the URL from the address bar.
3. Paste the URL into a new tab and load it.
4. The conversation should still render as archived (read-only subtitle,
   disabled composer, archive button labeled "Restore").
5. Currently it renders as live.

## Reviewer notes

Sauron traced this from the route-handling path. `20-workspace.js` correctly
passes the `archived` flag into `navigate`, but `03-router.js` drops it before
writing history, so the store and the URL disagree.
