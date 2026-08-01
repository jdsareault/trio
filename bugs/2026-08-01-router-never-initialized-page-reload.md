# Bug: Router never initialized — all navigation uses full page reload

**Date:** 2026-08-01
**Severity:** Critical — Phase 1 exit criteria not met; UX regression
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, Frodo, Gandalf — converged)
**Branch:** `phase-7-ui-updates` at `cef66e0`

---

## Symptom

Clicking a channel in the workspace rail triggers a full page reload
(`location.assign`). The user loses scroll position, in-progress compose drafts,
and the EventSource connection is torn down and re-established. The Phase 1 exit
criteria explicitly states "channel and DM navigation do not reload the page" —
this is not met.

The router module (`server/web/js/03-router.js`) implements client-side
navigation with `history.pushState`/`replaceState` and `popstate` handlers, but
it is never initialized. The `router.init()` function that registers `popstate`
and `data-route` click delegation is never called by any module.

## Root Cause

Two issues converge:

### 1. Router has no `mount()` method

`server/web/js/90-boot.js:6-9` mounts features via:
```js
['conversation', 'workspace', 'agents', 'preferences', 'router'].forEach(name => {
  const feature = Trio[name];
  if (feature) Trio.lifecycle?.mount?.(name, feature);
});
```

`Trio.lifecycle.mount()` (in `07-lifecycle.js:9`) calls `feature.mount(ctx)` or
falls back to `feature.init(ctx)`. The router (`03-router.js`) exposes `init()`
but NOT `mount()`. The lifecycle fallback calls `feature.init(ctx)`, but
`router.init()` ignores the `ctx` parameter and does run `init()` — however,
`router.init()` calls `addEventListener('popstate', ...)` and
`addEventListener('click', ...)` on the global scope, which registers the
handlers. So `router.init()` IS called via the fallback.

**Wait — re-verify:** The lifecycle `mount()` function calls
`if (feature.mount) feature.mount(ctx); else if (feature.init) feature.init(ctx);`.
Since router has `init` but not `mount`, it calls `router.init(ctx)`. So
`router.init()` IS called. The popstate and click handlers ARE registered.

### 2. Navigation bypasses the router

Even though `router.init()` runs, `server/web/js/20-workspace.js:21-24` bypasses
it entirely:
```js
function openChannel(code, extra = '') {
  const query = new URLSearchParams({channel: code});
  if (extra) query.set(extra, '1');
  location.assign('/?' + query);  // full page reload
}
```

No module calls `Trio.router.navigate()`. The router's `navigate()` function
uses `history.pushState`, but it is never invoked. The `data-route` click
handler in `router.init()` would handle `<a data-route="channel:general">` links,
but the workspace rail uses dynamically created `<button>` elements with
`addEventListener('click', () => openChannel(c.code))`, not `data-route` anchors.

Similarly, `00-core.js:31` uses `location.replace()` for the single-channel
redirect, and `openDm` in `20-workspace.js` mutates state directly without
calling `router.navigate('dm', {key})`.

## Fix

1. Replace `location.assign()` in `openChannel()` with
   `Trio.router.navigate('channel', {code})`.
2. Replace direct state mutation in `openDm()` with
   `Trio.router.navigate('dm', {key: dm.key})` (or `'audit'` for read-only).
3. Have features subscribe to `Trio.router.on(route => ...)` to handle route
   changes instead of calling `openChannel`/`openDm` directly.
4. Add `mount()` to the router module that calls `init()`, for consistency with
   the lifecycle contract.

## Verification

- Click a channel in the rail → URL changes via `pushState`, no page reload,
  scroll position preserved, EventSource stays connected.
- Click a DM → URL changes to `/?dm=<key>`, no page reload.
- Browser back/forward → `popstate` handler fires, route changes, conversation
  updates without reload.

## Reviewer notes

Sauron, Frodo, and Gandalf all independently flagged this. Sauron noted the
router is never initialized (partially incorrect — `init()` IS called via the
lifecycle fallback, but the router is never USED for navigation). Gandalf noted
the router is dead code. Frodo noted the UX impact (lost scroll/drafts). This is
the single largest gap between the Phase 1 plan and the shipped implementation.
