# Bug: Message-numbers preference has no effect

**Date:** 2026-08-01
**Priority:** P2 — a visible preference cannot control its advertised behavior
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`

## Symptom

Message IDs are always displayed, including with the default-false **message
numbers** preference. Toggling the setting produces no visual change.

## Root cause

`server/web/js/11-conversation.js:242` always builds the timestamp as
`#<id> · <time>`. Preferences toggles only `body.message-numbers` at
`server/web/js/40-preferences.js:21-22`; no renderer or shipped CSS selector
consumes that class.

## Verification

The DOM harness renders `#42` for a message while `messageNumbers` is false.
Repository searches find `message-numbers` only at the class toggle, with no
consumer, and no existing report covers the ineffective preference.

## Suggested fix

Render the ID in a dedicated element and hide/show it from the preference, or
conditionally include it in `cardFor()`. Cover both preference values.

