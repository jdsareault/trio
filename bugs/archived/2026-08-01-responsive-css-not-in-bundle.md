# Bug: `40-responsive.css` is not included in the web bundle

**Date:** 2026-08-01
**Severity:** Warning — mobile/responsive styles are missing from the served page
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, correctness; Frodo, UX)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The served Atrium page has no responsive CSS. On viewports under 880px, the sidebar does not collapse, the nav toggle does not appear, and the layout is broken on mobile/tablet. The `40-responsive.css` file exists in the source tree but is never inlined into the page.

## Root cause

`server/nth_web.py:4562-4565` defines `WEB_CSS_FILES`:

```python
WEB_CSS_FILES = (
    "css/00-tokens.css", "css/10-shell.css", "css/20-conversation.css",
    "css/30-workspace.css",
)
```

`css/40-responsive.css` is absent from this tuple. The file exists at `server/web/css/40-responsive.css` (1 line, a `@media (max-width:880px)` block) but is never composed into the served HTML.

The `90-boot.js` code at lines 11-15 wires up the nav toggle and scrim, but the CSS that actually shows/hides them is in the missing file:

```js
const nav = document.getElementById('nav-toggle');
const scrim = document.getElementById('scrim-nav');
const closeNav = () => { app?.classList.remove('nav-open'); if (scrim) scrim.hidden = true; };
nav?.addEventListener('click', () => { app?.classList.add('nav-open'); if (scrim) scrim.hidden = false; });
```

## Fix

Add `"css/40-responsive.css"` to the `WEB_CSS_FILES` tuple in `server/nth_web.py:4562`.

## Verification

1. Load the Atrium page.
2. Resize the browser window to under 880px.
3. The sidebar should collapse, the nav toggle (hamburger) should appear, and the scrim overlay should work.
4. If the bug is present, the layout does not change at narrow widths.

## Reviewer notes

The file was created as part of the Phase 2 responsive work but was never added to the bundle composition list. The `test-web-bundle.py` test does not check for `40-responsive.css` specifically, so the omission was not caught.
