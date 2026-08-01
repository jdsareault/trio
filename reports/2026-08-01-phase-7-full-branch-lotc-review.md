# LOTC Review — phase-7-ui-updates (full branch review)

**Date:** 2026-08-01
**Branch:** `phase-7-ui-updates` at `a27d0ac`
**Base:** `ca30868` (v5.1)
**Scope:** 152 files changed, ~40k insertions — JS client modules, Python server modules (nth_web.py, nth_server.py, nth_codex_runtime.py, nth_supervisor.py, nth_monitor.py, nth_spoke_monitor.py, hooks, console, dashboard), CSS, tests, docs
**Reviewers:** Sauron (Opus, correctness), Gandalf (Opus, architecture), Frodo (Opus, UX), Aragorn (Sonnet, security), Legolas (Sonnet, performance), Uruk-Hai x4 (Haiku, bug hunt)

## Summary

This review covers the full `phase-7-ui-updates` branch against base `ca30868` (v5.1). The branch encompasses the entire Atrium UI refactor (Phases 0-6), the v6-v7 server rewrite (stdio + SSE transport, monitor, supervisor, codex runtime, agent management, approvals, archives, search, STT, selectable answers), and the modular browser client extraction.

The branch is a substantial improvement over the v5.1 baseline: the monolithic inline Python string is now ordered, feature-named JS/CSS modules; the server has a real agent management layer with Codex/Claude runtime support; the backend contracts are healthy and tested. However, the review surfaced 20 confirmed bugs — 4 critical, 14 warning, 2 note — spanning client-side crashes, missing CSS, XSS vectors, unbounded queues, and database query inefficiency.

**Note:** Some bugs were filed by parallel agents during the review session. All findings were verified against the actual code before filing. False positives from Uruk-Hai subagents (SQL "injection" in hardcoded f-strings, nonexistent "crashes" with guards) were rejected.

## Review history

| Reviewer | Role | Findings | Status |
|----------|------|----------|--------|
| Sauron | correctness (JS client) | 1 crit, 4 warn, 2 note | filed |
| Gandalf | architecture (nth_web.py) | 3 crit, 5 warn, 2 note | filed (3 crit downgraded to warn after verification) |
| Frodo | UX (JS client + CSS) | 1 crit, 7 warn, 4 note | filed (1 crit merged with Sauron's) |
| Aragorn | security | 0 crit, 1 warn, 4 note | filed |
| Legolas | performance | 0 crit, 3 warn, 2 note | filed |
| Uruk-Hai 1 | codex_runtime + supervisor | 2 crit, 5 warn, 2 note | verified — 2 crit rejected (false positive), 1 warn filed |
| Uruk-Hai 2 | nth_server.py | 0 crit, 1 warn, 0 note | verified — warning is note-level (hardcoded f-strings) |
| Uruk-Hai 3 | nth_web.py | 1 crit | verified — rejected (false positive: SQL params were correct) |
| Uruk-Hai 4 | monitor + hooks + misc | 1 crit, 1 warn | verified — 1 crit rejected (guard existed), 1 warn filed |

## False positives (verified and rejected)

- **Uruk-Hai 1 — "SQL injection in `_set_state`":** The `sets` array is built entirely from hardcoded string literals (`"state=?"`, `"last_active_at=?"`, etc.), not user input. All values are parameterized with `?`. Not SQL injection.
- **Uruk-Hai 3 — "SQL parameter mismatch in channel unarchive":** The Uruk-Hai claimed 3 placeholders with 2 values. Actual code: `archived_at=NULL, archived_by=NULL, updated_at=? WHERE code=?` with `(now, key)` — 2 placeholders, 2 values. The NULLs are literals.
- **Uruk-Hai 4 — "IndexError crash on empty message history":** The Uruk-Hai claimed `rows[-1]["id"]` crashes on empty. Actual code: `last_id = rows[-1]["id"] if rows else 0` — has a guard.
- **Uruk-Hai 1 — "Race condition in `_bridge_result`":** The `context` is a local variable already popped from the deque under the lock. Accessing it outside the lock is safe — no other thread can modify it.

## Filed bug reports

All confirmed bugs are filed in `bugs/` with date-prefixed filenames:

### Critical (4)

| File | Area | Found by |
|------|------|----------|
| `2026-08-01-agent-roster-const-reassignment-crash.md` | JS correctness | Sauron |
| `2026-08-01-conversation-boot-event-race.md` | SSE/event handling | Sauron (pre-existing) |
| `2026-08-01-search-results-raw-content-xss.md` | Security/XSS | Aragorn (filed by parallel agent) |
| `2026-08-01-test-web-agents-flaky-running.md` | Test reliability | Uruk-Hai (pre-existing) |

### Warning (14)

| File | Area | Found by |
|------|------|----------|
| `2026-08-01-activeAgents-selector-ignores-src-param.md` | JS correctness | Sauron |
| `2026-08-01-agent-card-duplicate-action-buttons.md` | JS/UX | Sauron, Frodo |
| `2026-08-01-agent-router-unbounded-queue-silent-errors.md` | Server architecture | Gandalf |
| `2026-08-01-archive-toggle-does-not-refresh-conversation.md` | UX | Frodo (filed by parallel agent) |
| `2026-08-01-codex-runtime-unbounded-thread-creation.md` | Server/resource leak | Uruk-Hai |
| `2026-08-01-confirmBroadcast-dead-code.md` | JS/dead code | Frodo |
| `2026-08-01-css-token-duplication-dead-weight.md` | CSS/architecture | Gandalf, Legolas (pre-existing) |
| `2026-08-01-dm-endpoint-2000-row-scan-double-loop.md` | Server/performance | Legolas |
| `2026-08-01-message-controls-unstyled.md` | CSS/UX | Frodo |
| `2026-08-01-modal-body-not-escaped.md` | Security/defense-in-depth | Aragorn |
| `2026-08-01-multi-channel-default-redirect-aborts-boot.md` | JS correctness | Sauron (filed by parallel agent) |
| `2026-08-01-responsive-css-not-in-bundle.md` | CSS/bundle | Sauron, Frodo |
| `2026-08-01-router-archived-url-flag-lost.md` | JS correctness | Sauron (filed by parallel agent) |
| `2026-08-01-turn-hook-migration-missing-rollback.md` | Server/migration | Uruk-Hai |
| `2026-08-01-window-alert-prompt-in-conversation.md` | UX/accessibility | Frodo, Gandalf (pre-existing) |
| `2026-08-01-workspace-sse-pump-queue-full-stall.md` | Server/SSE | Gandalf |

### Notes (not filed as bugs)

- `nth_constants.py:76` — `can_see()` has unused `reader_kind` parameter (Aragorn)
- `nth_app.py:59` — `database_status()` lacks `busy_timeout` (Gandalf)
- `nth_codex_runtime.py:968` — Hardcoded `pid=NULL` in SQL UPDATE (Uruk-Hai)
- `nth_codex_runtime.py:387-390` — `ensure_started` race on `_worker_started` flag (Uruk-Hai)
- `12-composer.js:228` — `setInputState` parameter `text` shadows outer `text` function (Sauron)
- `04-events.js:7` — `state` variable shadows module pattern (Sauron)
- `nth_server.py:353` — f-string ALTER TABLE with hardcoded values (Uruk-Hai, Aragorn — safe but fragile pattern)
- `nth_web.py:2313` — Missing `Secure` flag on session cookie (Aragorn — only relevant if exposed over HTTPS)
- `10-markdown.js:354` — Regex ReDoS potential in sigil regex (Aragorn — IDs are server-validated)

## Merged findings (deduplicated, sorted by severity)

### Critical

1. **Agent roster search crashes on `const` reassignment** (`30-agents.js:95-98`) — Sauron. `const list` is reassigned in strict mode, throwing `TypeError` when search filter is active.

2. **Search results inject raw message HTML** (`20-workspace.js:334-335`) — Aragorn. When the search query matches message content, the raw content is inserted into `innerHTML` without escaping. Stored XSS.

3. **Conversation mounted after SSE starts** (`90-boot.js:4-9`, `00-core.js:41`) — Sauron. Primed SSE events are lost before conversation listeners attach. (Pre-existing, filed earlier.)

4. **`test-web-agents.py` flaky** — Uruk-Hai. (Pre-existing, filed earlier.)

### Warning

5. **`40-responsive.css` not in web bundle** (`nth_web.py:4562`) — Sauron, Frodo. Mobile/responsive styles are missing from the served page.

6. **`activeAgents` selector ignores `src` parameter** (`20-workspace.js:22`) — Sauron. Uses `state.agents` instead of `src.agents`, breaking composability.

7. **Agent card duplicate `append(row)`** (`30-agents.js:82`) — Sauron, Frodo. Copy-paste error; second append is a no-op but should be removed.

8. **`confirmBroadcast` flag never set** (`12-composer.js:103`) — Frodo. Broadcast confirmation is dead code.

9. **Message edit/delete controls unstyled** (`11-conversation.js:274`, CSS) — Frodo. No `.message-controls` CSS rule exists.

10. **AgentRouter queue unbounded + silent errors** (`nth_web.py:2040, 2057, 2122`) — Gandalf. Unbounded `queue.Queue()` and bare `except Exception: pass` in both poll and worker loops.

11. **Workspace SSE pump can stall on `queue.Full`** (`nth_web.py:2560`) — Gandalf. Blocking `put` on bounded queue with no `queue.Full` handling.

12. **DM endpoint 2000-row scan + double loop** (`nth_web.py:3262-3337`) — Legolas. O(n) scan for every DM thread load.

13. **`turn_hook` migration missing ROLLBACK** (`nth_turn_hook.py:84`) — Uruk-Hai. ALTER TABLE without ROLLBACK after failed UPDATE; inconsistent with `nth_activity_hook.py` pattern.

14. **Codex runtime unbounded thread creation** (`nth_codex_runtime.py:214`) — Uruk-Hai. New daemon thread per App Server request with no cap.

15. **`modal()` body not escaped** (`06-ui.js:14`) — Aragorn. `body` parameter is raw HTML; current callers are safe but API is a footgun.

16. **Router loses archived URL flag** (`03-router.js:19`) — Sauron. (Filed by parallel agent.)

17. **Multi-channel default redirect aborts boot** (`00-core.js:34-36`) — Sauron. (Filed by parallel agent.)

18. **Archive toggle doesn't refresh conversation UI** (`20-workspace.js:290-291`) — Frodo. (Filed by parallel agent.)

19. **CSS token duplication** (`10-shell.css:452-471`) — Gandalf, Legolas. (Pre-existing, filed earlier.)

20. **`window.alert`/`window.prompt` in conversation** (`11-conversation.js`) — Frodo, Gandalf. (Pre-existing, filed earlier.)

## Confirmed fixed (from archived reports)

Legolas verified that the critical performance issues from the earlier review (at `cef66e0`) have been fixed:
- Message append instead of full re-render (`11-conversation.js:332-338`)
- Regex caching with version tracking (`10-markdown.js:344-365`)
- Message pruning to 500 entries (`11-conversation.js:344-352`)
- `workspace:updated` listener removed from agents module (`30-agents.js`)

## Recommended priority

1. **Fix the `const` reassignment crash** (Critical #1) — one-line fix, blocks agent search entirely.
2. **Fix the search results XSS** (Critical #2) — already filed, escape content before `innerHTML`.
3. **Add `40-responsive.css` to the bundle** (Warning #5) — one-line fix, restores mobile layout.
4. **Fix `activeAgents` selector** (Warning #6) — one-line fix, `state.agents` → `src.agents`.
5. **Remove duplicate `append(row)`** (Warning #7) — one-line fix.
6. **Bound the AgentRouter queue and add logging** (Warning #10) — production safety.
7. **Fix the workspace SSE pump `queue.Full` handling** (Warning #11) — production safety.
8. **Fix the `turn_hook` migration ROLLBACK** (Warning #13) — self-healing migration.
