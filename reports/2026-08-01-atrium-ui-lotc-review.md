# LOTC Review — Atrium UI refactor (phase-7-ui-updates)

**Date:** 2026-08-01
**Branch:** `phase-7-ui-updates` at `cef66e0`
**Base:** `main`
**Scope:** 16 JS modules in `server/web/js/` (2,132 lines), `server/web/index.html`, bundle composition in `server/nth_web.py`, JS test harnesses
**Reviewers:** Sauron (correctness), Gandalf (architecture), Frodo (UX), Aragorn (security), Legolas (performance), Uruk-Hai (bug hunt)

## Summary

Reviewed the Atrium UI refactor branch — the extraction of the browser client
from a monolithic inline Python string into ordered, feature-named JS modules.
Phases 0 and most of Phase 1 are marked complete in `ATRIUM-UI-REFACTOR-PLAN.md`.

The modularization is a real maintainability improvement. The markdown renderer,
SSE event adapter, loader cancellation, and basic conversation/composer/workspace
surfaces are functional. The backend contracts are healthy and tested.

However, the Phase 1 foundation (store, router, lifecycle, event normalization)
is **shipped but not integrated**. The modules exist but features bypass them:
navigation uses full page reloads instead of the router, features mutate
`window.Trio.state` directly instead of using store actions, the lifecycle
system has no `update()` methods, and cross-feature calls create implicit
dependencies. Several marked-complete tasks do not meet their stated exit
criteria. This is the "distributed monolith" risk the plan warned about —
modular by filename, not by contract.

The review also surfaced a critical XSS vector in the markdown renderer, a
broken agent creation path, DM SSE connection failures, and several performance
issues on the message rendering hot path.

**Note:** The branch advanced 3 commits during the review (tasks 1.7 and 1.10
— workspace SSE, lifecycle migration). Findings were verified against the
post-advance code state. Some initial findings (agent drawer auto-open, DM
polling leak) were fixed by those commits and are not included here.

## Review history

| Reviewer | Role | Findings | Status |
|----------|------|----------|--------|
| Sauron | correctness | 2 crit, 3 warn, 2 note | filed / reconciled |
| Gandalf | architecture | 5 crit, 4 warn, 2 note | reconciled |
| Frodo | UX | 3 crit, 6 warn, 9 note | 2 false positives, rest filed/reconciled |
| Aragorn | security | 1 crit, 3 warn, 11 note | filed |
| Legolas | perf/leaks | 2 crit, 5 warn, 6 note | filed / reconciled |
| Uruk-Hai | bug hunt | 1 crit | filed |

## False positives (verified and rejected)

- **Frodo #2 — "Structured answers send unreadable content":** Frodo reported
  `composeAnswer` is undefined in `11-conversation.js:98`. Sauron verified (and
  I confirmed) that `composeAnswer` IS injected at the `/*__ASK_HELPERS__*/`
  marker in `10-markdown.js:1` by `nth_web.py:4591`. The test
  `test-client-render.js:52` passes, confirming the function is in scope. **Not
  a bug.**

- **Frodo #3 — "Message input clears on send failure":** Frodo reported
  `input().value = ''` happens before the await. Verified: it is inside the
  `try` block AFTER `await api.post()` (line 84). Input only clears on success.
  **Not a bug.**

- **Frodo #7 — "Agent drawer auto-opens on boot":** Was valid when reviewed, but
  fixed by commit `cef66e0` which added `n.hidden = true` to `host()`.
  **Fixed during review.**

## Filed bug reports

All confirmed bugs are filed in `bugs/` with date-prefixed filenames:

| File | Severity | Area | Found by |
|------|----------|------|----------|
| `2026-08-01-markdown-url-sanitization-xss.md` | Critical | Security | Aragorn |
| `2026-08-01-router-never-initialized-page-reload.md` | Critical | Correctness/UX | Sauron, Frodo, Gandalf |
| `2026-08-01-agent-create-unset-session-channel.md` | Critical | Correctness | Sauron |
| `2026-08-01-dm-filtering-race-and-sse-deadlock.md` | Warning | Correctness | Sauron |
| `2026-08-01-conversation-render-performance.md` | Critical | Performance | Legolas |
| `2026-08-01-dead-listener-null-deref-esc-double-escape.md` | Warning | Code quality | Sauron, Uruk-Hai, Aragorn, Gandalf |
| `2026-08-01-ux-defects-archive-buttons-agent-activity.md` | Warning | UX | Frodo |

**Bug count:** 3 critical, 4 warning (covering 17 individual findings).

## Reconciliation items

Architectural issues that must be resolved before Phase 2 are documented in
`reports/2026-08-01-atrium-reconciliation.md`. Summary:

1. **State split-brain** — two parallel state systems (store vs legacy singleton);
   features bypass the store. Task 1.3 exit criteria not met.
2. **Router orphaned** — defined but not used for navigation; all nav uses
   `location.assign()`. Task 1.4 exit criteria not met.
3. **Lifecycle incomplete** — no `update()` methods, `reportLeaks()` never called,
   `services` parameter unused. Task 1.8 exit criteria not met.
4. **Event normalization** — dead `'messages'` listener, redundant triple
   registration. Task 1.6 partially met.
5. **Cross-feature direct calls** — 10+ optional-chained cross-feature calls
   create implicit dependencies. Task 1.10 not complete.
6. **Duplicated utilities** — 3 copies of `esc()` with different escape sets,
   2 copies of `apiUrl()`.
7. **window.alert/prompt** — still used despite `Trio.ui.modal` existing.
   Task 1.9 exit criteria not met.
8. **Store subscriptions unused** — `subscribe()` implemented but never called.
9. **Implicit load-order coupling** — numeric prefix is the only dependency signal.

## Merged findings (deduplicated, sorted by severity)

### Critical

1. **Markdown URL sanitization allows dangerous schemes** (`10-markdown.js:35-42`)
   — Aragorn. The `safeUrl` transform only strips HTML entities, no protocol
   validation. Defense-in-depth fix: explicit `https?://` whitelist.

2. **Router never used for navigation** (`03-router.js`, `20-workspace.js:24`,
   `00-core.js:31`) — Sauron, Frodo, Gandalf. `openChannel()` uses
   `location.assign()`. Phase 1 exit criteria "navigation does not reload the
   page" not met.

3. **Agent creation reads unset `store.session.channel`** (`30-agents.js:12`)
   — Sauron. `Trio.store.get('session.channel')` returns `''` (never written).
   New agents get `channels: []`. Regression from task 1.10 migration.

4. **Full conversation re-render on every new message** (`11-conversation.js:260`)
   — Legolas. `upsert()` calls `render()` for new messages, rebuilding all
   cards. O(n) DOM operations per message.

5. **humanizeIdSigils regex rebuilt on every message line** (`10-markdown.js:336-352`)
   — Legolas. Regex constructed from all member IDs on every call, called from
   `inlineFmt` on every line of every message.

### Warning

6. **DM message filtering race condition** (`11-conversation.js:249-255`) — Sauron.
   Messages arriving before `dmMemberIds` is populated are dropped.

7. **DM-only URLs may not connect SSE** (`20-workspace.js:40`) — Sauron.
   `loadConversation` calls `Trio.startEvents()` with no arg, which returns
   early if channel is null.

8. **Dead `'messages'` event listener** (`11-conversation.js:276`) — Sauron.
   Event type never dispatched; listener will never fire.

9. **Null dereference in composer send** (`12-composer.js:84`) — Uruk-Hai.
   `input().value` without null guard; inconsistent with `input()?.` elsewhere.

10. **Inconsistent `esc()` missing `>` escape** (`06-ui.js:4`) — Aragorn, Gandalf.
    Used in `innerHTML` for modals. Defense-in-depth gap.

11. **humanizeIdSigils double-escapes member names** (`10-markdown.js:349`) — Aragorn.
    Names with HTML chars render as entity literals.

12. **Archive action no confirmation** (`20-workspace.js:148-151`) — Frodo.
    Destructive action without confirm dialog.

13. **Archive button silent no-op when no conversation** (`20-workspace.js:148-151`)
    — Frodo. No user feedback when neither DM nor channel is active.

14. **Disabled buttons no visual state** (`10-shell.css:76-82`) — Frodo.
    `.icon-btn:disabled` rule missing; search/details look clickable.

15. **Agent activity raw JSON dump** (`30-agents.js:11`) — Frodo.
    Shows `JSON.stringify(e)` instead of readable timeline.

16. **State Maps grow unbounded** (`11-conversation.js`) — Legolas.
    `messages`, `messageDomById`, `answers` never pruned. Latent until router
    eliminates page reloads.

17. **Agents refresh every 15s unnecessarily** (`30-agents.js:14`) — Legolas.
    `workspace:updated` listener triggers full agent refresh every 15s.

### Notes (not filed as bugs)

- `window.alert`/`window.prompt` still used in `11-conversation.js` despite
  `Trio.ui.modal` existing (Gandalf, Frodo).
- `window.confirm` used for broadcast confirmation in `12-composer.js:81` (Frodo).
- Workspace refresh errors silenced (`20-workspace.js:157`) — only `console.warn`,
  no user-facing toast (Frodo).
- Dictation permission denial shows generic error, not permission-specific
  guidance (Frodo).
- Dictation button not hidden on unsupported browsers (Frodo).
- DM empty states, error messages, and theme persistence are good UX (Frodo).
- SSE reconnection has visual feedback (Frodo).
- API errors are human-readable with status and path (Frodo).
- Preferences checkboxes correctly disabled with "not yet implemented" tooltips
  (Frodo) — but plan task 0.9 says "no checkbox may be a no-op."
- Code stashing (fenced/inline code) in markdown renderer is safe (Aragorn).
- Blockquote recursion, table cells, headings all use `inlineFmt` safely (Aragorn).
- `decorateSigils` uses `textContent`, no XSS path (Aragorn).
- `validDmKey` regex is safe for URL encoding (Aragorn).
- EventSource URL is safely encoded (Aragorn).
- `innerHTML` assignments in `20-workspace.js` and `30-agents.js` use `esc()`
  correctly (Aragorn).
- AbortController signal correctly passed through loader → api → fetch (Legolas).
- Store subscription system has no leaks because it's unused (Legolas).
- `nearBottom()` layout reads are cheap in modern browsers (Legolas).

## Conflicts between reviewers

- **Frodo vs Sauron on `composeAnswer`:** Frodo reported it undefined (critical);
  Sauron verified it IS injected. **Sauron correct** — verified via
  `nth_web.py:4591` and passing test. Frodo finding rejected.
- **Frodo vs code on input clearing:** Frodo reported input clears on failure;
  code shows it clears inside try after await. **Frodo incorrect.** Finding rejected.
- **Legolas on DM polling:** Legolas reported "DM polling does not exist" — was
  wrong when written (polling existed), but polling was removed during the review
  by commit `cef66e0`. Finding is now moot.

## Baseline test status

All baseline tests pass at `cef66e0`:
- `python3 tests/test-web-bundle.py` — OK
- `node tests/test-client-render.js` — OK (10 checks)
- `node tests/test-atrium-workspace.js` — OK (9 checks)
- `python3 -m py_compile server/nth_web.py` — OK

The tests do NOT cover the bugs found — they test the modular composition, basic
rendering, and URL parsing, but not navigation, SSE connection for DMs, agent
creation with store values, or performance characteristics.

## Recommended next steps

1. **Fix the 3 critical bugs** (markdown XSS, agent creation, router/navigation).
   The markdown XSS is the highest priority — it's a security issue exploitable
   by any agent posting a crafted message.
2. **Resolve reconciliation items 1-3** (state split-brain, router, lifecycle)
   before starting Phase 2. Building Phase 2 on a foundation where the store and
   router are dead code will compound the architectural debt.
3. **Add tests for the bug paths** — navigation, DM SSE connection, agent
   creation with store values, and markdown URL sanitization.
4. **Update `ATRIUM-UI-REFACTOR-PLAN.md`** to reflect the actual completion
   status of tasks 1.3, 1.4, 1.6, 1.8, 1.9, 1.10 — several are marked complete
   but do not meet their exit criteria.
