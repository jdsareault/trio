# Bug: `Trio.ui.modal()` does not escape the `body` parameter

**Date:** 2026-08-01
**Severity:** Warning — XSS if any caller passes user-controlled content as `body`
**Discovered during:** LOTC review of `phase-7-ui-updates` (Aragorn, security)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The `Trio.ui.modal()` function interpolates the `body` parameter directly into `innerHTML` without escaping. While the `title` parameter is properly escaped via `esc(title)`, the `body` is not. If any caller passes user-controlled content to `modal()`, an attacker could inject arbitrary HTML/JavaScript.

## Root cause

`server/web/js/06-ui.js:14`:

```js
node.innerHTML = `<form method="dialog" class="control-modal"><button class="modal-close" value="cancel">×</button><h2>${esc(title)}</h2>${body}<footer>...`;
```

The `title` is escaped (`esc(title)`) but `body` is interpolated raw. This is by design for callers that pass pre-built HTML (e.g., `30-agents.js` builds HTML with `esc()` calls inside), but the function itself is unsafe if a caller passes un-escaped user input.

**Current call sites are safe:**
- `06-ui.js:18` — `confirmAction` passes `esc(message)` — safe.
- `20-workspace.js` — passes HTML built with `esc()` calls — safe.
- `30-agents.js` — passes HTML built with `esc()` calls — safe.
- `40-preferences.js` — passes HTML built with `esc()` calls — safe.

**The risk is future callers** that may pass user-controlled content without escaping, since the function signature does not enforce or document the escaping contract.

## Fix

Document the contract explicitly in the function:

```js
/**
 * Show a modal dialog. The `body` parameter is raw HTML — callers MUST escape
 * any user-controlled content before passing it. Use `esc()` from 06-ui.js
 * or `Trio.markdown.escapeHtml` for text content.
 */
function modal(title, body, submit) { ... }
```

Alternatively, provide a safe variant:
```js
function modalText(title, text, submit) {
  modal(title, esc(text), submit);
}
```

## Verification

1. Search all `Trio.ui.modal()` call sites and verify each escapes user-controlled content.
2. Add a lint rule or code review checklist item: "modal body must be pre-escaped."

## Reviewer notes

Aragorn flagged this as a defense-in-depth gap. The current code is not exploitable because all callers escape their content, but the function's API is a footgun — the asymmetry between escaped `title` and raw `body` is surprising. This is the same class of issue as the search results XSS (filed separately in `bugs/2026-08-01-search-results-raw-content-xss.md`).
