# Bug: Search results inject raw message HTML

**Date:** 2026-08-01
**Severity:** Critical — stored XSS via search results
**Discovered during:** LOTC review of `phase-7-ui-updates` (Aragorn, security)
**Branch:** `phase-7-ui-updates` at `a27d0ac`

---

## Symptom

The global message search results render the matched message body as raw HTML
when the query matches a substring of the content. If an agent has posted a
message containing HTML/JS, the operator can execute it by searching for a term
inside it.

## Root cause

`server/web/js/20-workspace.js:334-335` builds the highlighted search result
body like this:

```js
const text = (r.content || '').toLowerCase().includes(q)
  ? (r.content || '').replace(new RegExp('(' + escRe(q) + ')', 'ig'), '<mark>$1</mark>')
  : esc(r.content || '');
b.innerHTML = `<span class="search-meta">...</span><span class="search-body">${text}</span>`;
```

When the query matches, the entire `r.content` is inserted into the DOM without
HTML escaping. Only the non-matching branch uses `esc()`. A message such as
`<img src=x onerror=alert(1)>` can therefore inject a live element into the
search results.

The `$1` back-reference is also unescaped, but the larger issue is that the rest
of `r.content` remains raw. The highlighter needs to work on escaped text.

## Fix

HTML-escape `r.content` before highlighting, then apply the `<mark>` wrapper to
the escaped query match:

```js
const escaped = esc(r.content || '');
const text = q && escaped.toLowerCase().includes(q.toLowerCase())
  ? escaped.replace(new RegExp('(' + escRe(q) + ')', 'ig'), '<mark>$1</mark>')
  : escaped;
```

This keeps the highlight while ensuring no attacker-controlled markup reaches
the DOM.

## Verification

1. Post a message containing `<img src=x onerror=alert(1)>`.
2. Open the search dialog (Ctrl/Cmd+K) and search for `img`.
3. Inspect the rendered `.search-body` for that result.
4. The text should appear as escaped entities, not a live `<img>` tag.
5. No `alert()` should fire.

## Reviewer notes

Aragorn caught this during the security pass. The rest of the Atrium client has
moved to explicit escaping, but the search result path was missed because the
highlighting path uses a string `replace` before the `esc()` call.
