# Bug: Conversation render performance — full re-render and regex rebuild on every message

**Date:** 2026-08-01
**Severity:** Critical (performance) — O(n) DOM thrash and O(m×n×l) regex construction on hot path
**Discovered during:** LOTC review of `phase-7-ui-updates` (Legolas, performance)
**Branch:** `phase-7-ui-updates` at `cef66e0`

---

## Bug A: Full conversation re-render on every new message

### Symptom

When a new message arrives via SSE, the entire message list is rebuilt from
scratch. For a channel with hundreds or thousands of messages, this causes
visible scroll jank and UI stutter on every incoming message.

### Root Cause

`server/web/js/11-conversation.js:247-262` — the `upsert()` function:

```js
function upsert(msg) {
  ...
  const existing = state.messageDomById.get(msg.id);
  if (!existing) { render(); return; }  // line 260 — full re-render for new messages
  const replacement = cardFor(...); existing.replaceWith(replacement);  // line 261 — surgical update for existing
  ...
}
```

For a new message (no existing DOM node), `render()` is called, which does
`list.replaceChildren()` (line 221) and rebuilds every single message card via
`cardFor()`. For 500 messages, that's 500 DOM subtree constructions on every
new message.

For message updates (edits, retraction, confidence changes), the code correctly
does a surgical `replaceWith` on just the one card. But new messages always
trigger the full re-render.

### Fix

For new messages when near the bottom (the common case), append the new card
instead of re-rendering everything:

```js
if (!existing) {
  const card = cardFor(state.messages.get(msg.id));
  list.append(card);
  state.messageDomById.set(msg.id, card);
  if (wasNear) dom().scrollTop = dom().scrollHeight;
  return;
}
```

Only call full `render()` when a message arrives out of order (e.g., a
backfill that inserts into the middle of the timeline).

## Bug B: humanizeIdSigils regex rebuilt on every message line

### Symptom

The `humanizeIdSigils()` function constructs a new `RegExp` from all member IDs
on every call. It is called from `inlineFmt()` which runs on every line of every
message during rendering. For 50 members and 100 messages with 5 lines each,
that's 25,000 regex constructions during a single render pass — multiplied by
the full re-render on every new message (Bug A).

### Root Cause

`server/web/js/10-markdown.js:336-352`:

```js
function humanizeIdSigils(text) {
  if (!text) return text;
  if (!state.members || !state.members.size) return text;
  const ids = Array.from(state.members.keys())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ids.length) return text;
  const re = new RegExp('([@#!])(' + ids.join('|') + ')(?=\\b|$)', 'g');
  return text.replace(re, ...);
}
```

The regex is rebuilt from scratch on every call, even though `state.members`
changes infrequently (only on roster updates).

### Fix

Cache the regex and invalidate it when the roster changes:

```js
let sigilRegex = null;
let sigilRegexVersion = -1;
function buildSigilRegex() {
  if (!state.members || !state.members.size) { sigilRegex = null; return; }
  const ids = Array.from(state.members.keys())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  sigilRegex = ids.length ? new RegExp('([@#!])(' + ids.join('|') + ')(?=\\b|$)', 'g') : null;
}
function humanizeIdSigils(text) {
  if (!text || !sigilRegex) return text;
  return text.replace(sigilRegex, (match, sigil, id) => {
    const mem = state.members.get(id);
    const name = mem && mem.name ? escapeHtml(mem.name) : id;
    return sigil + name;
  });
}
```

Call `buildSigilRegex()` on init and whenever the roster event fires.

## Bug C: State Maps grow unbounded in long-lived sessions

### Symptom

`state.messages`, `state.messageDomById`, and `state.answers` Maps grow
indefinitely for the lifetime of the page. In a long-lived channel session with
thousands of messages, memory consumption increases without bound.

### Root Cause

`server/web/js/11-conversation.js` — messages are added to `state.messages` via
`upsert()` but never removed. The Maps are only cleared in
`loadConversation()` (`20-workspace.js:38`) when switching conversations. Since
navigation uses full page reloads (see router bug), the Maps are effectively
cleared on each navigation — but if the router is fixed to avoid page reloads,
this becomes a real leak.

### Fix

Implement message pruning: keep the last N messages (e.g., 500) and remove
older entries from all three Maps. This should be done when the router is
activated (since that's when long-lived sessions become possible).

## Bug D: Agents refresh every 15s on workspace:updated

### Symptom

The agent roster refreshes every 15 seconds even when no agents have changed,
causing unnecessary API calls and potential UI flicker.

### Root Cause

`server/web/js/30-agents.js:14`:
```js
function init() { refresh(); workspaceListener = () => refresh(); Trio.events.addEventListener('workspace:updated', workspaceListener); }
```

`workspace:updated` is dispatched by `20-workspace.js:157` on every 15-second
refresh cycle, unconditionally triggering `agents.refresh()`.

### Fix

Add a dirty check — only refresh agents if the agent list has actually changed
(compare IDs/states), or move agent refresh to a separate, longer interval.

## Verification

**Bug A:** Load a channel with 500+ messages. Send a new message. The render
should be instantaneous (append one card), not a visible jank (rebuild 501 cards).

**Bug B:** Profile a render of 100 messages with 50 members. The regex
construction count should be 0 (cached), not 500+.

## Reviewer notes

Legolas flagged all four. Bug A and B compound each other — the full re-render
triggers the regex rebuild on every line of every message on every new message
arrival. Bug C is latent (mitigated by page-reload navigation) but becomes real
once the router is fixed. Bug D is minor but wasteful.
