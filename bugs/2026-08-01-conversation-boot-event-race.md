# Bug: Conversation is mounted after SSE starts, so primed events are lost

**Date:** 2026-08-01
**Severity:** Critical — message loss on cold load
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness)
**Branch:** `phase-7-ui-updates` at `d2582d7`

---

## Symptom

On a fresh page load, the server may "prime" the `/api/events` SSE stream with
the most recent messages for the active channel or DM. Those messages can be
dispatched before the conversation feature has attached its event listeners, so
they are silently dropped. The message list can appear empty until a new live
event arrives or the user refreshes.

## Root cause

`server/web/js/90-boot.js:4-9` boots and mounts features in this order:

```js
async function boot() {
  if (!(await Trio.boot())) return;
  ['conversation', 'workspace', 'agents', 'preferences', 'router'].forEach(name => {
    const feature = Trio[name];
    if (feature) Trio.lifecycle?.mount?.(name, feature);
  });
```

`Trio.boot()` in `server/web/js/00-core.js:26-36` fetches `/api/meta` and then
conditionally calls `root.startEvents(root.state.channel)` at line 35. That is
`Trio.startEvents()` from `server/web/js/04-events.js:25-40`, which opens the
EventSource immediately.

`11-conversation.js:273-280` does not attach its `message`,
`message_update`, and `roster` listeners until `init()` is called. But `init()`
is only invoked via `Trio.lifecycle.mount('conversation', ...)` *after*
`Trio.boot()` has already started the stream. Any primed events that arrive in
that window are dispatched into an empty listener set.

## Fix

Mount the conversation feature (and register its event listeners) before
starting the EventSource:

1. Move conversation mounting before `Trio.boot()` starts events, or
2. Have `04-events.js` buffer incoming payloads until at least one consumer
   listener is attached.

Option 1 is simpler and aligns with the lifecycle contract from task 1.8.

## Verification

1. Open a channel with existing messages.
2. Clear the client-side state and reload.
3. Observe the timeline. All primed messages should be visible immediately.
4. If the bug is present, only messages that arrive *after* the mount will
   appear.

## Reviewer notes

Sauron traced the boot order. This is the SSE-side counterpart to the DM SSE
connection bugs in `bugs/2026-08-01-dm-filtering-race-and-sse-deadlock.md` — in
both cases the client starts or relies on an event stream before the consumer is
ready.
