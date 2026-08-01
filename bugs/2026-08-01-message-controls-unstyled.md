# Bug: Message edit/delete controls have no CSS styling

**Date:** 2026-08-01
**Severity:** Warning — unstyled interactive elements, poor visual affordance
**Discovered during:** LOTC review of `phase-7-ui-updates` (Frodo, UX)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The edit and delete buttons on own messages render as unstyled plain text with no padding, background, border, or hover state. They look like inline text rather than interactive controls, making them easy to miss and hard to click.

## Root cause

`server/web/js/11-conversation.js:274-279` creates a `.message-controls` div with edit/delete buttons:

```js
const controls = document.createElement('div'); controls.className = 'message-controls';
for (const [label, fn] of [['edit', () => edit(msg, body)], ['delete', () => retract(msg)]]) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
  button.addEventListener('click', () => fn().catch(error => window.alert(error.message))); controls.append(button);
}
```

A search across all CSS files in `server/web/css/` confirms there is no `.message-controls` rule anywhere. The buttons inherit default browser styling only.

## Fix

Add CSS for `.message-controls` and its buttons in `server/web/css/20-conversation.css`:

```css
.message-controls { display:flex; gap:6px; margin-top:6px; }
.message-controls button { padding:3px 8px; border:0; border-radius:6px; background:var(--bg-sink); color:var(--ink-3); font-size:11px; cursor:pointer; }
.message-controls button:hover { background:var(--surface-hover); color:var(--ink); }
```

## Verification

1. Post a message as the operator.
2. Hover over the message — edit and delete buttons should appear with clear interactive styling.
3. If the bug is present, the buttons are plain unstyled text.

## Reviewer notes

Frodo flagged the missing CSS. The buttons are functional but visually invisible without styling. This is a Phase 3/4 polish gap — the controls were implemented but the matching CSS was never written.
