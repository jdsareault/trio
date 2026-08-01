# Bug: CSS token duplication and dead prototype selectors in `10-shell.css`

**Date:** 2026-08-01
**Severity:** Warning — bundle bloat and token ownership drift
**Discovered during:** LOTC review of `phase-7-ui-updates` (Gandalf, architecture; Gollum, style; Legolas, performance)
**Branch:** `phase-7-ui-updates` at `d2582d7`

---

## Symptom

The shipped CSS bundle is not modular by component:

- `server/web/css/00-tokens.css` defines the canonical design tokens.
- `server/web/css/10-shell.css` (around 66 KB, minified/concatenated) defines the
  same tokens again in a second `:root` block and also contains selector blocks
  for DOM that does not exist in the shipped `server/web/index.html`.
- `server/web/css/30-workspace.css` is a single minified line, while
  `10-shell.css` contains many workspace/preference/agent/detail/drawer/home
  selectors that do not match current markup.

This makes token ownership unclear and ships a large amount of unused CSS.

## Root cause

The prototype stylesheet from `02B-atrium.html` was copied wholesale into
`10-shell.css` rather than being split into owned layers (tokens, reset, shell,
components, feature, responsive). The bundle order in `server/nth_web.py:4562`
loads `00-tokens.css` first, then `10-shell.css`, so the duplicate
`:root`/`[data-palette]`/`[data-theme]` definitions in `10-shell.css` override or
shadow the canonical tokens.

Specific issues observed:

- `server/web/css/10-shell.css:558-580` redeclares `:root` tokens and additional
  `nord`/`dracula`/`solarized` palettes not referenced by the current shell.
- Selectors such as `.view-pad`, `.view-hero`, `.agent-card`, `.pref-group`,
  `.modal-head`, `.detail-hero`, `.drawer`, `.home-grid`, `.hcard`, `.sec-head`,
  `.hello`, and others match the prototype but not the shipped `index.html`.
- `server/web/css/30-workspace.css` is a single line, while many workspace rules
  still live in `10-shell.css`.

## Fix

Before Phase 2 visual expansion:

1. Inventory every selector block in `10-shell.css` and map it to one of:
   - supported component in the shipped markup,
   - later approved feature (Phase 3+),
   - dead prototype CSS.
2. Move still-needed rules into owned files:
   - tokens stay in `00-tokens.css`,
   - shell layout in `10-shell.css`,
   - conversation in `20-conversation.css`,
   - workspace in `30-workspace.css`,
   - responsive in `40-responsive.css`.
3. Delete dead selector blocks and duplicate token definitions.
4. Add a bundle check that rejects duplicate `:root` token definitions.

## Verification

1. Inspect the served bundle. No `:root` block should appear after `00-tokens.css`.
2. Search `10-shell.css` for dead selectors and confirm they have no matches in
   `index.html` and the currently mounted feature views.
3. Load the page. Token values should come only from `00-tokens.css`.
4. Run `python3 tests/test-web-bundle.py` and ensure the bundle still inlines all
   required CSS files.

## Reviewer notes

Gandalf flagged the architectural risk: building Phase 2 feature styles on top of
a shell file that contains prototype rules and duplicate tokens will recreate the
monolith in CSS. Legolas noted the bundle size. Gollum flagged the style
inconsistency.
