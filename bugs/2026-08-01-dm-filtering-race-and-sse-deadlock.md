# Bug: DM message filtering race and DM-only SSE connection failure

**Date:** 2026-08-01
**Severity:** Warning — DM messages can be silently dropped; DM-only URLs may have no live events
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness)
**Branch:** `phase-7-ui-updates` at `cef66e0`

---

## Bug A: DM message filtering race condition

### Symptom

When the operator opens a DM thread, messages that arrive via SSE before the DM
metadata is loaded are silently dropped. The user sees an incomplete conversation
history until they manually refresh.

### Root Cause

`server/web/js/11-conversation.js:249-255` — the `upsert()` function filters
messages when `state.dmKey` is set:

```js
if (state.dmKey) {
  const op = state.operator?.id;
  const recips = new Set([...(msg.recipients || []), msg.member_id].filter(Boolean));
  if (!op || !recips.has(op)) return;
  const others = [...recips].filter(id => id !== op);
  const expected = state.dmMemberIds || [];
  if (others.length !== expected.length || others.some(id => !expected.includes(id))) return;
}
```

`openDm()` (`20-workspace.js:42-48`) sets `state.dmKey` and `state.dmMemberIds`
synchronously, then calls `loadConversation()` which calls `Trio.startEvents()`.
The DM metadata fetch is async (line 52). If an SSE message arrives between the
synchronous state setup and the async DM metadata response, `state.dmMemberIds`
IS populated (line 43 sets it synchronously from `dm.member_ids`).

**However**, if `dm.member_ids` is empty or missing in the rail data (which
provides the DM row), then `state.dmMemberIds` is `[]` and the filter at line
255 rejects all messages where `others.length !== 0`. This happens when the rail
data doesn't include member_ids (the `/api/dms` response may not include them in
the summary list).

### Fix

Either:
1. Defer the DM filter until the full DM metadata (including member_ids) is
   loaded from `/api/dms?with=<key>`.
2. Or relax the filter: if `state.dmMemberIds` is empty, accept the message
   (the server already validates DM visibility).

## Bug B: DM-only URLs may fail to establish SSE connection

### Symptom

When the operator opens a DM-only URL (`/?dm=<key>` with no `?channel=`), the
DM history loads correctly but live SSE events may never connect. The connection
indicator shows "offline" and new messages don't appear in real-time.

### Root Cause

`server/web/js/00-core.js:35` calls `Trio.startEvents(root.state.channel)`.
For a DM-only URL, `state.channel` is empty (line 14 sets it from
`parseParam('channel')` which returns `''`). `startEvents()` (in `04-events.js:25`)
returns early if channel is null/empty:

```js
function startEvents(channel = null) {
  if (!channel) { notify('offline', { reason: 'no channel' }); return; }
  ...
}
```

Then `90-boot.js:28-29` calls `Trio.workspace.openDmByKey(key)`, which calls
`openDm(dm)`, which calls `loadConversation(dm.channel || state.channel, ...)`.
If `dm.channel` is present in the DM metadata, `state.channel` is set to it
(line 33 of `20-workspace.js`) and `Trio.startEvents()` is called (line 40)
with no argument — which defaults to `null` and returns early again.

The `loadConversation` call at line 40 is:
```js
Trio.startEvents?.();
```
This passes no argument, so `channel` defaults to `null`, and `startEvents`
returns early with `notify('offline', { reason: 'no channel' })`.

### Fix

`loadConversation` should call `Trio.startEvents(state.channel)` (passing the
channel that was just set at line 33), not `Trio.startEvents()` with no args.

```js
// 20-workspace.js line 40 — change:
Trio.startEvents?.();
// to:
Trio.startEvents?.(state.channel);
```

## Verification

**Bug A:** Open a DM with a message arriving within 500ms of the DM metadata
fetch. The message should appear. Currently it may be dropped if `dm.member_ids`
is empty in the rail data.

**Bug B:** Navigate to `/?dm=<key>` (no channel param). The connection indicator
should show "live" and new DM messages should appear in real-time. Currently it
shows "offline" and no live updates occur.

## Bug C: Cross-channel DM updates cannot stay live on a single channel-scoped SSE

### Symptom

A unified DM can contain messages whose actual backing channel is different from
the channel on the newest row. The operator client subscribes to
`/api/events?channel=<dm.channel>`, so it will not receive messages that were
sent in another backing channel. The server already exposes a multiplexed
operator-only workspace SSE at `/api/workspace/events` (`server/nth_web.py:2534-2587`),
but the client never connects to it.

### Root cause

`20-workspace.js:42-61` (`openDm()`) sets `state.channel = dm.channel` and then
`loadConversation()` calls `Trio.startEvents()` (via `04-events.js:25`), which
builds a channel-scoped EventSource from `api.url('/api/events')`. A merged
thread may span several channels, so one channel-scoped stream cannot keep the
whole DM live. The temporary 5-second DM polling in `20-workspace.js` was
removed during the review, leaving no fallback.

### Fix

For operator sessions, connect to `/api/workspace/events` and route each
incoming event to the active conversation by thread key. Continue using
`_event_visible_to()` on the server so privacy is not weakened.

## Additional context from a separate LOTC pass at `d2582d7`

A later review confirmed the same DM SSE gaps and noted the workspace SSE
endpoint is already implemented on the server but unused on the client. The
client-side routing needed is: identify the conversation (channel/dm/audit) from
each event and upsert it into the right view.

## Reviewer notes

Sauron traced both of these. Bug B is the most impactful — DM-only deep links
have no live event connection at all. Bug C becomes the long-term fix once the
client adopts the workspace SSE endpoint. Bug A is lower probability but can
cause confusing message loss.
