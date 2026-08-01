# Bug: UX defects — archive confirmation, silent no-op, disabled buttons, agent activity

**Date:** 2026-08-01
**Severity:** Warning — confusing/broken user-facing interactions
**Discovered during:** LOTC review of `phase-7-ui-updates` (Frodo, UX)
**Branch:** `phase-7-ui-updates` at `cef66e0`

---

## Bug A: Archive action has no confirmation dialog

### Symptom

Clicking the archive button in the topbar immediately archives the current
conversation without asking for confirmation. This is a destructive action —
the conversation disappears from the active rail and must be manually restored
from the archive browser. An accidental click causes confusion.

### Root Cause

`server/web/js/20-workspace.js:148-151` (the `archiveCurrent()` function):
```js
async function archiveCurrent() {
  if (state.dmKey) { await archive('dm', state.dmKey, !state.readOnly); state.readOnly = !state.readOnly; }
  else if (state.channel) { await archive('channel', state.channel, !state.readOnly); state.readOnly = !state.readOnly; }
}
```

No confirmation is requested before calling `archive()`. The `Trio.ui.confirmAction()`
helper exists (`06-ui.js:17-19`) but is not used.

### Fix

Wrap the archive call in a confirmation:
```js
async function archiveCurrent() {
  const target = state.dmKey ? 'this DM' : (state.channel ? 'this channel' : '');
  if (!target) { Trio.ui.toast('No conversation to archive'); return; }
  Trio.ui.confirmAction(`Archive ${target}?`, () => {
    if (state.dmKey) { archive('dm', state.dmKey, !state.readOnly).then(() => state.readOnly = !state.readOnly); }
    else if (state.channel) { archive('channel', state.channel, !state.readOnly).then(() => state.readOnly = !state.readOnly); }
  });
}
```

## Bug B: Archive button is a silent no-op when no conversation is active

### Symptom

If the user clicks the archive button while on the Home view (or any non-
conversation view), nothing happens. No feedback, no error, no toast. The user
clicks and the app appears to ignore them.

### Root Cause

`server/web/js/20-workspace.js:148-151` — `archiveCurrent()` checks
`if (state.dmKey)` and `else if (state.channel)`. If neither is true, the
function returns silently. There is no `else` clause with user feedback.

### Fix

Add an else clause:
```js
else { Trio.ui.toast('No conversation to archive'); }
```

## Bug C: Disabled search/details buttons have no visual disabled state

### Symptom

The search and details buttons in the topbar are disabled (via `90-boot.js:22-25`)
with a tooltip saying "not yet implemented", but they look identical to enabled
buttons. The user has to hover to discover they're disabled. They appear
clickable but don't respond.

### Root Cause

`server/web/css/10-shell.css:76-82` defines `.icon-btn` styles but has no
`:disabled` rule:
```css
.icon-btn{ width:34px; height:34px; ... }
.icon-btn:hover{ background:var(--surface-hover); color:var(--ink); }
.icon-btn:active{ transform:scale(.92); }
```

The `.send-btn:disabled` rule exists (line 338) with `opacity:.45;
cursor:not-allowed`, but `.icon-btn:disabled` does not.

### Fix

Add a disabled rule to the CSS:
```css
.icon-btn:disabled{ opacity:.45; cursor:not-allowed; }
.icon-btn:disabled:hover{ background:transparent; }
```

## Bug D: Agent activity shows raw JSON dump

### Symptom

When the user clicks "Activity" on an agent, a modal opens showing a `<pre>`
block with raw event content or `JSON.stringify(e)` output. This is not human-
readable. The user sees something like:
```
{"type":"message","content":"Processing...","ts":"2026-08-01T12:00:00Z"}
```
instead of a readable activity timeline.

### Root Cause

`server/web/js/30-agents.js:11`:
```js
async function activity(id) {
  const d = await Trio.api.get(`/api/agents/${encodeURIComponent(id)}/activity`);
  Trio.ui.modal('Agent activity', `<pre>${esc((d.events || []).slice(0, 20)
    .map(e => e.content || e.message || JSON.stringify(e)).join('\n') || 'No activity')}</pre>`);
}
```

The fallback `JSON.stringify(e)` is used when `e.content` and `e.message` are
both absent. Even when `e.content` is present, it's displayed as raw text in a
`<pre>` block without any formatting, timestamps, or event type labels.

### Fix

Format the events into a readable timeline:
```js
const formatted = (d.events || []).slice(0, 20).map(e => {
  const time = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
  const type = e.type || 'event';
  const content = e.content || e.message || '';
  return `[${time}] ${type}: ${content}`;
}).join('\n') || 'No activity';
```

## Verification

**Bug A:** Click the archive button on an active conversation. A confirmation
dialog should appear before archiving.

**Bug B:** Navigate to Home view. Click the archive button. A toast should
appear saying "No conversation to archive".

**Bug C:** Observe the search/details buttons — they should appear dimmed
(opacity ~0.45) with a not-allowed cursor.

**Bug D:** Click "Activity" on an agent. The output should be a formatted
timeline, not raw JSON.

## Bug E: Home/Attention/Tasks panels overlay the conversation without hiding the composer

### Symptom

Selecting Home, Attention, or Tasks renders a full-screen panel over the
message list, but the `messages` region, `private-banner`, and `composer-shell`
(textarea, Send, attach, dictate) remain in the DOM and interactive. A user can
be in the Attention view and accidentally send a message to the current channel.

### Root cause

`server/web/js/20-workspace.js:112-129` (`showView()`) only hides
`[data-trio-view]` panels and prepends a new panel. It does not hide the
conversation body or the composer, and it does not set a `readOnly` or
`composer.disabled` state. `30-workspace.css` positions workspace views with
`position: absolute; inset: 64px 0 0; z-index: 3`, so they visually cover the
message list but do not disable the underlying composer.

### Fix

`showView()` should hide `messages`, `private-banner`, and `composer-shell`
while non-conversation views are active, or these views should render in a
separate mount point that does not share the conversation layout.

## Reviewer notes

Frodo flagged all four. Bugs A and B are the most impactful — destructive
actions without confirmation and silent no-ops are both confusing UX. Bug C is
a CSS oversight. Bug D is a placeholder that should be improved as part of the
agent details work in Phase 2+. Bug E was flagged in a separate LOTC pass at
`d2582d7` and is a distinct navigation-view defect.
