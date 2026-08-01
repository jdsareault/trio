# Bug: Modular client drops file-path links and Finder reveal behavior

**Date:** 2026-08-01
**Priority:** P1 — established message interaction is completely unavailable
**Severity:** High — every workspace file path renders as inert text
**Discovered during:** LOTC review of `phase-7-ui-updates`
**Branch:** `phase-7-ui-updates` at `1476f84`
**Base:** `ca30868`

---

## Symptom

File paths in conversation messages no longer become clickable links, even when
the path exists on the server. Operators therefore cannot use the dashboard's
existing “Reveal in Finder” interaction for paths posted by agents.

The server still exposes `POST /api/path/validate` and `POST /api/reveal`, and
the dedicated client test still describes the feature, but the shipped modular
JavaScript never calls either endpoint.

## Root cause

The pre-modular dashboard implemented four client functions:

- `detectFilePathCandidates`
- `linkifyValidatedPaths`
- `decorateFilePaths`
- `revealPath`

They were present immediately before the Markdown extraction commit
`fcb48d8`, but were not moved into `server/web/js/10-markdown.js` or another
module. The current Markdown API export at
`server/web/js/10-markdown.js:367-370` contains none of them.

The current conversation renderer stops after Markdown and sigil decoration at
`server/web/js/11-conversation.js:114-116`:

```js
body.className = 'message-body';
body.innerHTML = M.renderMarkdown(vm.content);
decorateSigils(body, vm);
```

There is no equivalent of the former fire-and-forget
`decorateFilePaths(body)` call. Meanwhile the now-unreachable backend handlers
remain registered at `server/nth_web.py:2458-2461` and implemented at
`server/nth_web.py:4187-4210` and `4212-4235`.

## Verification

Running the repository's focused client test:

```text
node tests/test-file-links.js
```

produces 24 failures. The candidate-detection cases fail with:

```text
H.detectFilePathCandidates is not a function
```

and the linkification cases fail with:

```text
H.linkifyValidatedPaths is not a function
```

Repository-wide searches confirm there is no current definition or call site
for either helper, `decorateFilePaths`, or `revealPath` outside the failing test.
No existing report under `bugs/` mentions file-path detection, linkification,
validation, or reveal behavior.

## Suggested fix

Restore the client layer in an appropriate modular owner (for example a
file-link feature module), invoke it after each non-system message body is
rendered, and expose the pure detection/linkification helpers to the DOM test
hook. Keep the existing server-side existence-validation gate so arbitrary
path-like prose does not become a link.
