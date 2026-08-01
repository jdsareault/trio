# Bug: Archive/unarchive toggle does not refresh the conversation read-only UI

**Date:** 2026-08-01
**Severity:** Warning — archived conversations still show edit/delete/send controls
**Discovered during:** LOTC review of `phase-7-ui-updates` (Frodo, UX; Sauron, correctness)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

Clicking the archive/restore button in the topbar (or the details dialog)
toggles the channel's archived state, but the conversation view does not
refresh. The composer textarea remains enabled-looking, the topbar still says
"Live agent workspace" or "Private conversation", and the message edit/delete
controls remain visible. The user can attempt edits or new messages until they
refresh or navigate away.

## Root cause

`server/web/js/20-workspace.js:286-292` archives or restores and flips
`state.readOnly`:

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

After `state.readOnly` changes, no code calls `Trio.conversation.render()`,
`Trio.composer` update, or `loadConversation()` again. The UI is left in the old
state.

Additionally, `server/web/js/11-conversation.js:273-279` renders message
controls without checking `state.readOnly`:

```js
if (isOwn(msg) && !msg.retracted_at) {
  const controls = document.createElement('div'); controls.className = 'message-controls';
  for (const [label, fn] of [['edit', () => edit(msg, body)], ['delete', () => retract(msg)]]) {
    const button = document.createElement('button'); ...
  }
  card.append(controls);
}
```

Even when an archived conversation is loaded through `openChannel(...,
'archived')` or after the archive toggle, those buttons remain. The composer does
check `state.readOnly` in `validate()`, so sending fails, but the textarea is not
visually disabled.

## Fix

In `archiveCurrent`, after `state.readOnly` flips, re-render the conversation:

```js
archive(...).then(() => {
  state.readOnly = !state.readOnly;
  const title = state.dmKey ? 'DM ' + state.dmName : 'trio#' + state.channel;
  const subtitle = state.readOnly
    ? (state.dmKey ? 'Archived private conversation' : 'Archived channel — read only')
    : (state.dmKey ? 'Private conversation' : 'Live agent workspace');
  updateTopbar(title, subtitle);
  loadConversation(state.channel, title, subtitle, state.readOnly, !!state.dmKey);
});
```

Also guard `cardFor` so edit/delete controls only appear when `!state.readOnly`:

```js
if (isOwn(msg) && !msg.retracted_at && !state.readOnly) { ... }
```

## Verification

1. Open a live channel with a message you authored.
2. Click the archive button and confirm.
3. The topbar should change to "Archived channel — read only".
4. The composer textarea should become disabled or show the archived
   placeholder.
5. The edit/delete buttons on existing messages should disappear.
6. Unarchiving should restore all of the above.

## Reviewer notes

Frodo flagged the UX (the app looks editable after archive), and Sauron traced
it to the missing re-render and the `cardFor` control guard. The new
`Trio.ui.confirmAction` path is an improvement over the old native dialog, but
the confirmation callback still needs to drive the view update.
