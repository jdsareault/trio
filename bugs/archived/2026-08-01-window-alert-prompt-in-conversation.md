# Bug: Conversation still uses `window.alert` and `window.prompt`

**Date:** 2026-08-01
**Severity:** Warning — UX/accessibility regression
**Discovered during:** LOTC review of `phase-7-ui-updates` (Frodo, UX; Gandalf, architecture)
**Branch:** `phase-7-ui-updates` at `d2582d7`

---

## Symptom

Message actions use native browser dialogs instead of the shared UI primitives:

- Answering a structured question shows `window.alert()` on send failure
  (`server/web/js/11-conversation.js:113`).
- Retracting (deleting) a message uses `window.prompt()` for an optional reason
  (`server/web/js/11-conversation.js:170`).
- Editing a message uses `window.prompt()` for the new content
  (`server/web/js/11-conversation.js:175`).

These are blocking, unstyled, origin-dependent dialogs that break focus
management, do not respect the Atrium theme, and are poor for accessibility.

## Root cause

The shared UI services in `server/web/js/06-ui.js` already provide
`Trio.ui.toast()` and `Trio.ui.modal()` / `Trio.ui.confirmAction()`, but
`11-conversation.js` was migrated before those primitives existed and still uses
the browser defaults. The Phase 1.9 checklist in `ATRIUM-UI-REFACTOR-PLAN.md`
calls for replacing `window.alert`, `window.prompt`, and ad-hoc dialogs.

## Fix

- Replace `window.alert()` with `Trio.ui.toast()`.
- Replace the `window.prompt()` in `retract()` with `Trio.ui.modal()` containing
  a `<textarea>` for the optional reason.
- Replace the `window.prompt()` in `edit()` with `Trio.ui.modal()` containing a
  `<textarea>` pre-filled with the current content.
- For the retry/confirmation in `submitAnswer()`, use `Trio.ui.toast()`.

## Verification

1. Post a structured question and submit an answer while the server is offline.
2. A themed toast should appear, not a native alert.
3. Edit or delete a message. A themed modal with a textarea should appear, not a
   native prompt.

## Reviewer notes

Frodo flagged the UX impact. Gandalf noted it as a reconciliation item (shared UI
services are not consistently used). Aragorn reviewed the `innerHTML` usage in
`Trio.ui.modal()` and confirmed current call sites escape user content, but any
new modal body built from user input must continue to do so.
