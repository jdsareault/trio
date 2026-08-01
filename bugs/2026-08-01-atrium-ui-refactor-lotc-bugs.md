# Atrium UI refactor — confirmed bugs and regressions

**Date:** 2026-08-01  
**Branch:** `phase-7-ui-updates` at `d2582d7`  
**Reviewed by:** LOTC council (Sauron, Gandalf, Frodo, Aragorn, Legolas, Gollum, Uruk-Hai)  
**Severity mix:** P0–P2

These are *confirmed* bugs observed in the working tree and the bundled page. They were found while checking the Phase 1 foundation (store, router, lifecycle, events, API) and the partial 1.10 migration of `agents`/`preferences` to the new architecture. Some items from `ATRIUM-UI-REFACTOR-PLAN.md` have already been fixed; this report covers what is still broken on the current commit.

---

## P0 — correctness / data loss

### 1. Conversation is mounted *after* the SSE stream is started, so primed events are lost

**Files:** `server/web/js/90-boot.js:4-9`, `server/web/js/00-core.js:35`, `server/web/js/04-events.js:25-41`, `server/web/js/11-conversation.js:273-280`

**Symptom:** `Trio.boot()` calls `Trio.startEvents(root.state.channel)` *before* `90-boot` mounts the conversation feature. The SSE priming from the server can dispatch `message` / `messages` / `message_update` events while `11-conversation.js` has not yet attached its listeners. Those events are dispatched into an empty listener set, so a freshly opened channel or DM can appear empty until a new live event arrives.

**Root cause:** The boot sequence starts the EventSource before the feature that consumes it is mounted. Phase 1.8 lifecycle contract requires timers/listeners to be wired in `mount`, and event ingestion must be connected before the stream starts.

**Fix:** Mount conversation (and register its event listeners) before `startEvents` is called, or have `04-events` buffer incoming payloads until a consumer is ready.

### 2. Channel and DM navigation bypass the router and break back/forward/deep-linking

**Files:** `server/web/js/20-workspace.js:21-25` (openChannel), `42-61` (openDm), `server/web/js/03-router.js`, `server/web/js/90-boot.js:28-30`

**Symptom:**
- `openChannel()` calls `location.assign('/?channel=' + code)`, discarding scroll/draft/composer state and doing a full page load.
- `openDm()` never updates the URL, so a refresh returns to channel/home and the browser back button does not navigate between DMs.
- `90-boot` deep-links a DM by looking at `Trio.state.conversation` set in `00-core.js`, not at the router's parsed `route`.

**Root cause:** The first-class router from `03-router.js` is not used by workspace navigation. Rail items are buttons, not `data-route` links, and `openDm` has no `router.navigate()` call.

**Fix:** Make `openChannel` call `Trio.router.navigate('channel', {code, archived})`; make `openDm` call `Trio.router.navigate('dm', {key})` / `navigate('audit', {key})`; remove `00-core` from conversation parsing; let `03-router` be the single source of route truth.

### 3. DM live updates rely only on the backing-channel SSE; cross-channel DMs cannot stay fresh

**Files:** `server/web/js/20-workspace.js:42-61`, `server/web/js/04-events.js:25-41`, `server/nth_web.py:2534-2587` (`/api/workspace/events` already exists), `server/nth_web.py:2372` (`/api/dms`)

**Symptom:** `openDm()` sets `state.channel = dm.channel` and starts `/api/events?channel=<that>`. A unified DM can contain messages whose actual backing channel is different from the one on the newest row. Those messages will not arrive on the active EventSource, so the thread only refreshes on the next workspace poll. The temporary 5-second DM polling has just been removed (uncommitted diff), so there is now no fallback.

**Root cause:** Phase 1.7 (a permanent workspace/DM live-event contract) is not implemented on the client. The server already provides `_serve_workspace_sse` at `/api/workspace/events`; the client is not using it.

**Fix:** Connect the operator client to `/api/workspace/events` and route each incoming event to the active conversation by thread key, not by backing channel. Reuse `_event_visible_to()` on the server so privacy is not weakened.

---

## P1 — UX / visible brokenness

### 4. Home/Attention/Tasks panels overlay the conversation without hiding the composer

**Files:** `server/web/js/20-workspace.js:112-129` (showView), `server/web/css/30-workspace.css`, `server/web/index.html:20-25`

**Symptom:** Selecting Home, Attention, or Tasks renders a full-screen panel over the message list, but the `messages` region, `private-banner`, and `composer-shell` (textarea, send button, dictation) remain in the DOM and remain interactive. A user can be in the Attention view and accidentally send a message to the channel.

**Root cause:** `showView()` only hides `[data-trio-view]` panels and prepends a new one; it does not hide the conversation body or the composer. It also does not set a read-only/composer-disabled state.

**Fix:** `showView` should hide `messages`/`private-banner`/`composer-shell` while non-conversation views are active, or these views should render in a separate mount point with a dedicated layout.

### 5. Native `window.alert` and `window.prompt` still used for message actions

**Files:** `server/web/js/11-conversation.js:113`, `170`, `175`, `211`

**Symptom:** Answer errors, edit prompts, and delete confirmations use `window.alert()`/`window.prompt()`. These are modal blocking dialogs that are not styled, do not respect the theme, break focus management, and are not accessible.

**Root cause:** Conversation was migrated before the shared `Trio.ui.toast` / `Trio.ui.confirmAction` primitives existed and still uses the browser defaults.

**Fix:** Replace `window.alert` with `Trio.ui.toast`; replace edit/delete prompts with `Trio.ui.modal` or `Trio.ui.confirmAction`.

### 6. Search, details, and jump-to-latest are still dead or unimplemented

**Files:** `server/web/index.html:21-24`, `server/web/js/90-boot.js:22-25`, `server/web/js/11-conversation.js:281-286` (jump button is wired but search/details are not)

**Symptom:** `90-boot` disables Search and Details with `disabled` and a tooltip. There is no handler, no overlay, and no keyboard shortcut. The jump-to-latest button exists and has a scroll listener, but search and details are the more important missing features.

**Root cause:** Phase 0.6 said to hide or disable unimplemented controls; the search and details flows are not yet built. The prototype and the server search endpoint exist, but the UI contract is missing.

**Fix:** Either implement the search overlay and details drawer, or keep them hidden until Phase 4/Phase 6 work begins. Leaving them visible-but-disabled is better than nothing, but should be called out in the reconciliation list.

---

## P2 — architecture, maintainability, performance

### 7. Conversation, composer, workspace, and events still mutate `Trio.state` directly instead of the store

**Files:** `server/web/js/11-conversation.js:9-15`, `server/web/js/12-composer.js:6-9`, `server/web/js/20-workspace.js` (many `state.* =` lines, e.g. 27-47, 113-157), `server/web/js/04-events.js:20`, `server/web/js/06-ui.js` (reads `Trio.state` indirectly)

**Symptom:** `01-store.js` defines explicit slices (`route`, `session`, `workspace`, `conversation`, `composer`, `agents`, `tasks`, `attention`, `preferences`) and subscriptions, but the older modules still read/write `Trio.state.messages`, `Trio.state.selectedTargets`, `Trio.state.dmKey`, etc. Features call each other directly (`Trio.conversation?.render?.()`, `Trio.workspace?.refresh?.()`) instead of using actions/subscriptions.

**Root cause:** Phase 1.10 (migrate preferences and agents to store/lifecycle) was committed, but conversation, composer, workspace, and events were not migrated. The result is a hybrid monolith spread across files.

**Fix:** Complete the migration: move `messages`, `members`, `conversation`, `composer` state into store slices, use `Trio.store.subscribe()` to re-render, and remove direct feature-to-feature calls.

### 8. `10-shell.css` re-exports tokens and ships large amounts of dead prototype CSS

**Files:** `server/web/css/10-shell.css:558-580` (second `:root` and extra palettes), `server/web/css/00-tokens.css` (canonical tokens), `server/web/index.html`

**Symptom:**
- `10-shell.css` contains a second `:root` token block (lines 558-580) and extra `data-palette` themes (`nord`, `dracula`, `solarized`) not referenced in the current shell.
- It also contains selectors for DOM that does not exist in the shipped `index.html`, such as `.view-pad`, `.view-hero`, `.agent-card`, `.pref-group`, `.modal-head`, `.detail-hero`, `.drawer`, `.home-grid`, `.hcard`, `.sec-head`, `.hello`.
- The file is ~66 KB while the feature-specific `30-workspace.css` is a single line and `20-conversation.css` is only ~4.5 KB.

**Root cause:** The prototype stylesheet from `02B-atrium.html` was copied wholesale into the shell layer instead of being split into tokens, base, shell, components, feature, and responsive layers.

**Fix:** Before Phase 2 visual expansion, inventory every selector in `10-shell.css` against the current `index.html` and the implemented features. Move the still-needed rules into owned files (tokens, shell, features) and delete the dead prototype rules.

---

## Test / quality signal

### 9. `tests/test-web-agents.py` is flaky on `create: agents row running`

**File:** `tests/test-web-agents.py:95-96`

**Symptom:** The test failed once on this run (`FAIL: create: agents row running`) and passed on re-run. The DB `state` column was still `spawning` when the test read it immediately after the `POST /api/agents` returned 200.

**Root cause:** `test-web-agents.py` reads the DB row without any wait or retry. `nth_supervisor.spawn()` updates the row to `running` after `proc.wait_session()` returns, but on a loaded machine that update may not have committed before the test's next HTTP/DB round-trip.

**Fix:** Add a small retry around the DB `state` check, or make the create endpoint not return until the supervisor has persisted the running state.

---

## Not in this report

Items that are architectural cross-cutting concerns (store adoption, routing integration, workspace SSE, CSS consolidation, documentation drift, Phase 2 readiness) are listed separately in the reconciliation output from this review rather than being filed as individual runtime bugs.
