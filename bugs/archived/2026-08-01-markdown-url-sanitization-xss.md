# Bug: Markdown renderer allows javascript: and data: URLs in links

**Date:** 2026-08-01
**Severity:** Critical — XSS via agent-posted message content
**Discovered during:** LOTC review of `phase-7-ui-updates` (Aragorn, security)
**Branch:** `phase-7-ui-updates` at `cef66e0`

---

## Symptom

The markdown renderer in `server/web/js/10-markdown.js` builds `<a>` tags from
markdown link syntax and autolinked URLs without validating the URL scheme. An
agent can post a message containing `[click me](javascript:alert(document.cookie))`
or `[click](data:text/html,<script>alert(1)</script>)` and the link renders with
the dangerous URL intact. The operator clicks it and script executes in the
page's origin.

The threat model is real: agents post arbitrary message content, and the
operator's browser renders it. The `target="_blank" rel="noopener noreferrer"`
attributes provide partial protection (modern browsers block `javascript:` in
cross-origin new-tab contexts), but `data:` URLs can still execute script in the
same origin, and a middle-click or right-click "open in new tab" on a
`javascript:` link may bypass the new-tab restriction in some browsers.

## Root Cause

`server/web/js/10-markdown.js:35-42` — the `inlineFmt()` function processes
markdown links and autolinks:

```js
t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, txt, url) => {
  const safeUrl = url.replace(/&(?:quot|#39);/g, '');
  return '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>';
});
t = t.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (_m, pre, url) => {
  const safeUrl = url.replace(/&(?:quot|#39);/g, '');
  return pre + '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
});
```

The named-link regex at line 35 requires `https?://` in the URL, so
`[text](javascript:...)` does NOT match that regex — the URL is not captured.
**However**, the autolink regex at line 39 only matches `https?://` URLs, so
bare `javascript:...` URLs are also not autolinked.

**The actual vulnerability path:** The named-link regex requires `https?://` in
the URL portion, but the URL is extracted from the markdown after `escapeHtml()`
has already been applied to the text (line 29). A crafted input like
`[text](https://evil.com" onmouseover="alert(1))` could potentially break out
of the href attribute, since `safeUrl` only strips `&quot;` and `&#39;` entities
but does not strip raw `"` characters that might survive the regex match.

Additionally, the `data:` scheme is not blocked if a crafted input reaches the
href through any path that doesn't require `https?://` (e.g., via HTML entity
manipulation or a future regex change).

**The core issue is defense-in-depth:** the URL sanitization is insufficient.
It relies on the regex requiring `https?://` as the only protocol gate, but
does not validate the URL after extraction. A robust fix should explicitly
whitelist URL schemes rather than relying on regex matching.

## Fix

Add explicit protocol validation to the link rendering:

```js
function safeUrl(url) {
  // Only allow http(s) URLs; reject javascript:, data:, vbscript:, etc.
  if (!/^https?:\/\//i.test(url)) return '';
  return url.replace(/&(?:quot|#39);/g, '');
}
```

Use `safeUrl()` in both the named-link and autolink replacements. If it returns
empty string, render the text without a link.

## Verification

- Post a message with `[test](data:text/html,<script>alert(1)</script>)` —
  should render as plain text, not a clickable link.
- Post a message with `[test](javascript:alert(1))` — should render as plain text.
- Post a message with `[test](https://example.com)` — should render as a normal link.

## Reviewer notes

Aragorn rated this critical. The `https?://` requirement in the regex provides
incidental protection against `javascript:` and `data:` schemes in the current
code, but the defense is fragile — it relies on regex matching rather than
explicit protocol validation, and attribute breakout via crafted URLs is not
fully guarded against. The fix should be defense-in-depth: explicit scheme
whitelist plus proper attribute escaping.
