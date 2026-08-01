# Bug: Dead event listener, null dereference, and inconsistent esc() — minor code defects

**Date:** 2026-08-01
**Severity:** Warning — dead code, potential crash, and inconsistent security helper
**Discovered during:** LOTC review of `phase-7-ui-updates` (Sauron, Uruk-Hai, Aragorn, Gandalf)
**Branch:** `phase-7-ui-updates` at `cef66e0`

---

## Bug A: Dead 'messages' (plural) event listener

### Symptom

The conversation module registers a listener for the `'messages'` (plural)
event, but the event system never dispatches this event type. The listener is
dead code that will never fire.

### Root Cause

`server/web/js/11-conversation.js:276`:
```js
events.addEventListener('messages', onMessage); listeners.messages = onMessage;
```

`server/web/js/04-events.js:18-22` dispatches events with `type = payload.type || 'message'`.
The SSE adapter dispatches `'message'` (singular), `'message_update'`, and
`'roster'`. No code dispatches `'messages'` (plural).

### Fix

Remove line 276. The `'message'` and `'message_update'` listeners on lines
277-278 already cover all message events.

## Bug B: Null dereference in composer send

### Symptom

If the `#input` element is removed from the DOM during an async send operation
(e.g., by a route change or view switch), `input().value = ''` throws
"Cannot read properties of null". The error is uncaught and breaks the send
flow's success path.

### Root Cause

`server/web/js/12-composer.js:84`:
```js
const result = await api.post(apiUrl('/api/send'), body);
input().value = ''; state.pendingAttachments = []; ...
```

`input()` returns `document.getElementById('input')` which can be null. Other
lines in the same file use `input()?.` (optional chaining) — lines 31, 33, 103,
111 — but line 84 does not. The inconsistency suggests an oversight.

### Fix

Use optional chaining:
```js
input().value = '';  // line 84
// change to:
const inp = input(); if (inp) inp.value = '';
```

## Bug C: Inconsistent esc() missing '>' escape in 06-ui.js

### Symptom

The `esc()` function in `06-ui.js` escapes `& < " '` but NOT `>`. Two other
copies of `esc()` (in `20-workspace.js:6` and `10-markdown.js:8`) escape all
five characters including `>`. The `06-ui.js` version is used in `modal()`
(line 14) for `innerHTML` construction.

### Root Cause

`server/web/js/06-ui.js:4`:
```js
const esc = value => String(value ?? '').replace(/[&<"']/g, c => ({'&':'&amp;','<':'&lt;','"':'&quot;',"'":'&#39;'}[c]));
```

Compare with `20-workspace.js:6`:
```js
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
```

The missing `>` escape is a defense-in-depth gap. While `>` is less commonly
used for XSS breakout (it requires a specific context like an unquoted
attribute value), it should be escaped for consistency and completeness.

### Fix

Add `>` to the escape set in `06-ui.js:4`:
```js
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
```

**Better fix:** Extract a single shared `esc()` into a utilities module and
import it everywhere. See the reconciliation document.

## Bug D: humanizeIdSigils double-escapes member names

### Symptom

Member names containing HTML special characters (e.g., `<`, `>`, `&`) are
double-escaped by `humanizeIdSigils`, rendering as literal entity strings
(`&amp;lt;` instead of `<`).

### Root Cause

`server/web/js/10-markdown.js:336-352` — `humanizeIdSigils()` runs inside
`inlineFmt()` AFTER `escapeHtml()` has already been applied to the text (line
29). It then calls `escapeHtml(mem.name)` again (line 349) on the member name.
If the member name is `<script>`, the first `escapeHtml` on the message text
produces `&lt;script&gt;`, and then `humanizeIdSigils` escapes the name to
`&amp;lt;script&amp;gt;` — the browser displays the literal string
`&lt;script&gt;` instead of `<script>`.

### Fix

Don't double-escape. Since `humanizeIdSigils` runs after `escapeHtml`, the
output is already in HTML context. Use the raw member name (the surrounding
text is already escaped):

```js
return sigil + (mem && mem.name ? mem.name : id);
```

Or restructure so `humanizeIdSigils` runs BEFORE `escapeHtml` (and escapes the
name itself), avoiding the double-escape.

## Verification

**Bug A:** Dispatch a custom event named `'messages'` — the listener fires.
Confirm that `04-events.js` never dispatches this event type.

**Bug B:** Remove `#input` from DOM during a send. Line 84 should not crash.

**Bug C:** Call `06-ui.js::esc('a>b')` — should return `'a&gt;b'`, currently
returns `'a>b'`.

**Bug D:** Set a member name to `<test>`. Post `@<member_id>` in a message.
The sigil should render as `@<test>`, not `@&lt;test&gt;` (double-escaped).

## Reviewer notes

Sauron found Bug A. Uruk-Hai found Bug B. Aragorn and Gandalf found Bug C.
Aragorn found Bug D. All are confirmed by code tracing. None are high-severity
individually, but they represent code quality issues that should be cleaned up.
