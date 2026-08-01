# Atrium UI refactor: current-state review and implementation plan

**Reviewed:** 2026-08-01  
**Branch:** `phase-7-ui-updates` at `070a95e`  
**Prototype:** `02B-atrium.html`  
**Scope:** the shipped browser UI in `server/web/`, its composition in `server/nth_web.py`, the supporting HTTP/SSE contracts, and the focused web/integration tests.

## Executive summary

The branch has made a useful first step away from the old inline dashboard: the browser source now lives in a small HTML shell, ordered CSS files, and feature-named JavaScript files. The Python server composes those files into the existing single-response, no-build deployment model. The backend underneath it is substantially more mature than the new client: multi-channel data, DMs, managed Claude/Codex agents, approvals, archives, search, attachments, selectable answers, and speech-to-text all have working server contracts and passing integration tests.

The current UI is **not yet a functional implementation of the Atrium prototype**. It is best described as a modular shell plus a basic live channel client. Much of the prototype CSS was copied into `10-shell.css`, but most of the matching DOM and controller behavior has not been ported. Several visible controls have no handlers, several preferences have no effect, and some Phase 6 workflows regressed during extraction—most importantly unified DMs, readable structured-question answers, archive viewing, and the complete agent control plane.

The modularization is also mainly **file-level rather than architectural**. Every feature mutates `window.Trio.state`, dependencies are implicit in numeric load order, features call one another directly, and view/route ownership is not defined. Continuing to add prototype screens on top of that shared singleton will recreate the monolith across multiple files.

The recommended order is:

1. restore broken product flows and remove dead controls;
2. establish explicit routing, state ownership, feature lifecycles, and shared UI primitives;
3. port the prototype feature-by-feature against real backend contracts;
4. add browser-level interaction, accessibility, responsive, and visual regression coverage.

## Baseline and important context

### The backend product is farther along than the new UI

Phases 4–6 delivered a real unified workspace before this visual refactor:

- installable local app and durable managed agents;
- Claude and Codex lifecycle management;
- channels and cross-channel operator DM threads;
- approvals and runtime activity;
- reversible channel and DM archives;
- image upload, dictation, structured questions, search, message editing, and retraction.

That work is documented in `PHASE5-COMPLETION.md`, `PHASE6-COMPLETION.md`, `QA-unified-interface.md`, and the Phase 4 report. The current refactor should preserve those workflows while replacing their presentation.

### The prototype is a product specification, not reusable application code

`02B-atrium.html` is a 3,439-line interactive mock with in-memory fixtures. It defines the desired information architecture, visual language, and interaction model, but some interactions are simulated and have no current server contract (for example reactions and typing indicators). Prototype parity therefore requires three classifications for each feature:

1. **Port now:** a real backend contract already exists.
2. **Add a contract:** the behavior is a desired product capability but the server does not expose it yet.
3. **Keep presentational or defer:** the mock behavior should not be treated as shipped functionality without a product decision.

### Documentation is behind the branch

- `CURRENT.md` still identifies Phase 6 and the old `feat/unified-phase6-archives` branch.
- `README.md` still calls the unified workspace Phase 6.
- `CHANGELOG.md` does not describe Phases 5–7.
- `TODO.md` contains older selectable-answer and STT follow-ups, but no Atrium parity backlog.

Those files should be updated when the refactor reaches an accepted milestone, not before the current regressions are resolved.

## What has been accomplished

### 1. Browser source extraction and composition

The served page is now composed from reviewable source files:

- `server/web/index.html` — static shell and mount points;
- `server/web/css/00-tokens.css` through `40-responsive.css` — ordered style layers;
- `server/web/js/00-core.js` through `90-boot.js` — ordered feature files;
- `server/web/js/99-test-hook.js` — test-only exposure stripped from production.

`server/nth_web.py:4501-4552` defines the ordered asset contract, guards source paths, inlines the assets, strips the test hook, and preserves the no-build/single-response deployment model. `tests/test-web-bundle.py` verifies composition, ordering, placeholder replacement, path traversal rejection, and removal of the test hook.

This is a real maintainability improvement over editing a browser application inside a Python string.

### 2. A usable basic channel timeline

`server/web/js/11-conversation.js` currently provides:

- live SSE ingestion and message upsert by ID;
- chronological channel rendering;
- Markdown through the extracted renderer;
- `@`, `#`, and `!` decoration;
- private-message styling;
- image attachments;
- confidence labels;
- edited and retracted states;
- own-message edit/delete controls;
- an unread divider when a valid watermark is available;
- interactive selectable-answer cards.

The focused DOM harness covers Markdown safety, retraction, sigils, upsert behavior, privacy detection, answer payload shape, and composer payload construction.

### 3. Basic composer and workspace surfaces

The extracted composer supports:

- text send and Enter/Shift+Enter behavior;
- server-compatible mention and recipient payloads;
- image upload/removal;
- local and browser dictation implementations;
- reply and DM fields in the payload shape;
- send failure feedback.

The workspace module loads real channels, DMs, tasks, approvals, and metadata; renders rail sections; creates channels; exposes basic Home, Attention, and Tasks panels; and provides an archive restore dialog.

### 4. Basic agent and preference surfaces

The new client can list agents, invoke wake/hibernate, show a raw activity view, create a minimally configured agent, apply light/dark and accent preferences, and show basic diagnostics.

These are useful scaffolds, but they do not yet preserve the complete Phase 5 agent controls or match the prototype's directory/detail/create flows.

### 5. Backend verification remains strong

The following focused checks passed during this review:

- `python3 tests/test-web-bundle.py`
- `node tests/test-client-render.js`
- `node tests/test-atrium-workspace.js`
- `python3 tests/test-unified-workspace.py`
- `python3 tests/test-web-agents.py`
- `python3 tests/test-web-channels.py`
- `python3 tests/test-web-codex-agents.py`
- `python3 tests/test-archives.py`
- `python3 tests/test-ask.py`
- `python3 tests/test-stt.py`
- `python3 tests/test-search.py`
- `python3 -m py_compile server/nth_web.py`

This confirms that the backend contracts and the small set of client helpers under test are healthy. It does **not** demonstrate end-to-end prototype parity: most view navigation and controls are not exercised by the current DOM tests.

## Prototype parity overview

Status meanings:

- **Implemented:** materially usable against real data.
- **Partial:** the surface exists, but important prototype behavior or product capability is absent.
- **Placeholder:** mostly static/basic rendering without the required interactions.
- **Missing/broken:** absent, dead, or regressed from the pre-refactor product.

| Area | Status | Current reality | Major remaining work |
|---|---|---|---|
| Design tokens and themes | Partial | Most prototype CSS is present; light/dark and three accents work. | Consolidate duplicated tokens, remove unused prototype CSS, verify dark accent combinations, persist quick theme changes. |
| App shell | Partial | Two-column shell, rail, header, composer, and mobile drawer exist. | Match prototype branding/icons, active navigation, owner identity, face pile, focus states, and responsive details. |
| Channel navigation | Partial | Real channel list and full-page switching work. | Active state, previews/member counts, unread state, draft/scroll preservation, client-side route transitions. |
| Unified DMs | Missing/broken | DM rows render but open only a channel URL; no thread key is loaded and no DM recipient is set. | First-class DM route, merged history, private banner/composer, read-only audit threads, cross-channel live updates, unread/archive behavior. |
| Conversation timeline | Partial | Real live messages, Markdown, attachments, sigils, edit/delete, retraction, confidence, and questions render. | Prototype row/avatar/bubble structure, dates, message-type tags, reply context, file links, scroll/jump behavior, compact mode, read state, empty/loading/error states. |
| Composer | Partial | Basic text send and upload work; dictation code exists. | Wire dictation button, autocomplete, target/reach modes, preview, DM lock, reply UI, attachment thumbnails/drop, auto-grow, draft persistence, broadcast warning. |
| Home | Placeholder | Shows only channel and DM counts. | Attention summary, agent health/activity, recent channels, tasks, runtime health, useful empty/loading/error states. |
| Attention | Placeholder/broken | Approval cards render. | Wire allow/decline, include questions/errors/blocked agents/usage/locks, tabs/history, live refresh, accessible announcements. |
| Tasks | Placeholder/broken | Read-only rows render. Filter buttons do nothing. | Decide operator task mutation contract; implement filters, claim/release/complete/cancel/create, dependencies, results, owners, and live updates. |
| Agent directory | Placeholder | A fixed drawer renders basic cards and three actions. | Prevent auto-open, build full directory view, state filters, avatars/status, details, DM entry, lifecycle/menu coverage. |
| Agent creation | Partial | Minimal name/provider/model form posts successfully with defaults. | Runtime readiness, model/effort discovery, role/prompt, cwd, permission profile, wake policy, placements, validation, spawn progress. |
| Agent details/activity | Placeholder | Raw last-20 activity text in a generic Save dialog. | Structured runtime timeline, context/session state, placements, wake mode, lifecycle actions, errors, destructive confirmations. |
| Search | Missing | Header button exists with no handler; backend search works. | Overlay, debounce, result grouping/highlighting, keyboard navigation, route-to-result, empty/error states, `Cmd/Ctrl+K`. |
| Conversation details | Missing | Header button exists with no handler. | Members, objective, tasks, activity stats, archive/end actions, responsive drawer and backdrop. |
| Archives | Partial/regressed | Restore-only dialog exists. | View archived channel/DM history, read-only state, current conversation Archive/Restore action, mobile access, proper dialog refresh/close behavior. |
| Preferences | Partial | Theme/accent persist through the settings dialog; diagnostics are a JSON dump. | Implement or remove no-op switches, full prototype layout, notification permission/scope, dictation engine/test, fonts, diagnostics/health, mobile archives entry. |
| Responsive/mobile | Partial | Sidebar drawer exists at 880px. | Test/fix z-index and scrim rules, mobile views/drawers/dialogs/composer, safe areas, touch targets, narrow message layout. |
| Accessibility | Partial | Semantic shell, labels, focus-visible styles, native dialogs, and live message region exist. | Proper question group semantics, tabs/menus, focus return, status/toast announcements, keyboard navigation, reduced-motion verification, contrast audit. |

## Confirmed bugs and regressions

### P0 — restore before visual expansion

#### 1. DM rows do not open DM conversations

`server/web/js/20-workspace.js:59` sends a DM row to `openChannel(d.channel || state.channel)`. It never passes the DM thread key, calls `/api/dms?with=<key>`, populates the timeline with merged DM history, or sets `state.dmTargetId`. The composer has recipient support at `server/web/js/12-composer.js:45`, but no current UI path activates it.

The server already returns thread keys, participants, merged history, and target metadata in `server/nth_web.py:3187-3306`. The client must use that contract instead of treating a DM as a channel shortcut.

#### 2. Structured answers no longer tell the agent what was selected

`server/web/js/11-conversation.js:90-95` sends content such as `Answered question #91`. The MCP contract explicitly tells agents to read the ordinary reply words; `server/nth_server.py:1916-1919` says a batch reply lists each question with its answer. The repository already contains `composeAnswer()` in `server/nth_ask_client.js:37-55`, but the modular client neither loads nor uses it.

This is more serious than visual parity: the human can click an answer successfully while the asking agent receives no readable answer in normal poll output. The existing client test currently asserts the regressed generic content and should be corrected with the implementation.

#### 3. The agent drawer opens during application boot

`server/web/js/90-boot.js:6` initializes the agent module. `server/web/js/30-agents.js:7-10` immediately refreshes; `host()` creates a fixed `.agent-drawer` without `hidden`, so it is visible before the user selects Agent roster.

#### 4. Core Phase 6 archive UX was lost

The Phase 6 completion contract includes View and Restore, archived history in a read-only conversation, a current-conversation Archive/Restore action, and mobile access. `server/web/js/20-workspace.js:76-84` now provides restore buttons only. There is no archived-history route or current conversation action.

### P1 — visible controls or settings that currently do nothing

#### 5. Dictation button is not wired

`server/web/js/12-composer.js:97-113` implements dictation and exports `toggleDictation`, but `init()` at lines 114-121 only binds input, Send, and Attach. `#dictate-btn` has no click listener.

#### 6. Search, details, and jump-to-latest are dead controls

The buttons are present in `server/web/index.html:21-24`. No module registers handlers for `#search-btn`, `#details-btn`, or `#jump-latest`. The jump button also never becomes visible from scroll state.

#### 7. Attention decisions are not wired

`server/web/js/20-workspace.js:70` renders Allow and Decline buttons with data attributes, but adds no click listeners. The working server endpoint is `POST /api/approvals/<id>/resolve`.

#### 8. Task filters are not wired and task actions have no HTTP contract

`server/web/js/20-workspace.js:69` renders Open, Claimed, and All buttons but no handler. The current `/api/tasks` endpoint is explicitly read-only (`server/nth_web.py:3799-3801`), so prototype actions require either new operator endpoints or an explicit decision that the web task board remains observational.

#### 9. Agent-to-agent audit rows are inert

`server/web/js/20-workspace.js:60` creates audit rows without an `onClick` callback. The prototype treats these as read-only auditable conversations.

#### 10. Several saved preferences have no product effect

`server/web/js/40-preferences.js` exposes compact mode, message numbers, notifications, chime, and dictation switches. There is no matching compact/message-number rendering or notification/chime behavior in the current client. The quick footer theme toggle in `server/web/js/90-boot.js:13-15` also bypasses preference persistence.

### P2 — correctness, consistency, and maintainability issues

#### 11. Upload limits disagree

The client accepts images up to 20 MB (`server/web/js/12-composer.js:57`), while the server hard limit is 10 MB (`server/nth_web.py:74`). Files between those limits are accepted by the picker and then rejected after upload begins.

#### 12. Each SSE message is ingested through two event paths

Core dispatches both the typed event and generic `sse` event (`server/web/js/00-core.js:30-32`). Conversation listens to `message`/`message_update` and also generic `sse` (`server/web/js/11-conversation.js:242-246`). The Map prevents duplicate rows, but each event can render/update twice.

#### 13. Current state and dependency ownership are implicit

`server/web/js/00-core.js:3-9` creates the global `window.Trio` singleton. Conversation changes `state.messages` from the core's array to a Map, workspace replaces `state.meta`, agents populate `state.agents`, and preferences inspect those values. Features also call one another directly (`composer → conversation`, `workspace → agents`, `agents → workspace`). Numeric filenames are the only dependency declaration.

This is safe only while the client remains small. It is the main architectural issue to fix before porting the rest of the prototype.

#### 14. CSS ownership is unclear and much of the bundle is dead weight

`00-tokens.css` defines a small token set, then `10-shell.css:1-108` defines the same tokens again. `10-shell.css` contains almost the entire prototype stylesheet, including selectors for DOM that does not exist in the shipped shell. The 19-line `20-conversation.css` and one-line minified `30-workspace.css` then bridge the real DOM separately.

The result looks modular by filename but has no reliable design-system or component-style boundary.

#### 15. Client routing is full-page and loses transient state

`server/web/js/20-workspace.js:21-25` changes channels with `location.assign`. Draft text, pending attachments, scroll position, open view state, and unsaved UI context are discarded. Full reload was a reasonable migration bridge, but it should not be the target architecture.

#### 16. The current tests miss the broken interactions above

`tests/test-atrium-workspace.js` is a one-line helper test for grouping and attention counts. `tests/test-client-render.js` tests pure/render helpers but not the actual booted shell, rail clicks, DM navigation, button wiring, dialogs, filters, or preferences. Bundle composition passing only proves that source was included.

## Recommended target architecture

### Constraints to preserve

- Python standard-library server remains viable.
- No framework or package dependency is required for this refactor.
- The app must work as a local install and in the existing single-channel compatibility mode.
- Existing authorization/privacy decisions remain server-side.
- Managed Claude/Codex runtime details stay behind provider-neutral UI contracts.

### Architectural shape

Use native ES modules served as static local assets, with no compilation step. If the single-response portable document is a hard requirement, use the same boundaries behind a small module registry and continue inlining; do not preserve unrestricted global mutation.

```text
server/web/
├── index.html                  durable landmarks and layer hosts
├── app/
│   ├── boot.js                 composition root only
│   ├── router.js               URL ↔ route, history, route lifecycle
│   ├── store.js                state slices, actions, subscriptions
│   ├── api.js                  fetch contracts, errors, cancellation
│   └── events.js               SSE normalization and reconnect state
├── features/
│   ├── workspace/              channel/DM summaries and rail
│   ├── conversation/           route loader, timeline, scroll/read state
│   ├── composer/               drafts, targeting, upload, reply, dictation
│   ├── attention/              approvals/questions/errors/blocked work
│   ├── tasks/                  task list and mutations
│   ├── agents/                 directory, detail, create, lifecycle
│   ├── search/                 query and result routing
│   ├── archives/               browse/view/restore
│   └── preferences/            persisted settings and diagnostics
├── ui/
│   ├── dialog.js               one accessible dialog service
│   ├── drawer.js               responsive side panels
│   ├── toast.js                live announcements and errors
│   ├── avatar.js               identity and presence rendering
│   ├── status.js               normalized agent/connection states
│   └── icons.js                shared SVG icon templates
└── styles/
    ├── tokens.css              single source of truth
    ├── base.css
    ├── shell.css
    ├── components.css
    ├── features/*.css
    └── responsive.css
```

### State ownership

Use one store with explicit slices and action methods; features may subscribe to slices but should not mutate arbitrary shared properties.

```text
route
  view: home | attention | tasks | agents | preferences | conversation
  conversation: { kind: channel | dm | audit, key, channel? }

session
  operator, connection, capabilities

workspace
  channels, dmThreads, agentAuditThreads, summaries, loading, error

conversation
  identity, messagesById, orderedIds, members, readWatermark,
  loading, error, archived, scroll

composer
  draftsByConversation, targets, reach, attachments, replyTo,
  dictationState, sending, error

agents / tasks / attention / preferences
  feature-owned data and request state
```

Only actions such as `navigate`, `conversationLoaded`, `messageReceived`, `draftChanged`, and `approvalResolved` change state. This makes route transitions and tests deterministic without introducing Redux or another dependency.

### View lifecycle contract

Every feature should expose a small consistent contract:

```js
mount(root, services)
update(slice, previousSlice)
unmount()
```

`services` contains only declared dependencies (`api`, `store`, `router`, `dialogs`, `toasts`). Features should not query or call another feature's private DOM.

### Conversation identity must be first-class

Do not model every conversation as a channel string. Use:

- `channel:<code>`
- `dm:<thread-key>`
- `audit:<thread-key>`

The router, timeline, composer, archive state, drafts, and read watermarks should all key off that identity. This directly fixes the present DM regression and prevents channel assumptions from leaking into every feature.

### Server contract work

The UI can use most current endpoints, but full Atrium behavior needs a few explicit additions or decisions:

1. **Workspace-wide live events or DM-thread events.** A merged DM can contain rows from multiple backing channels. A channel-scoped EventSource cannot keep that unified thread live by itself.
2. **Unread/read watermarks for channel and DM summaries.** `/api/channels` and `/api/dms` currently return activity summaries but not a complete operator unread contract.
3. **Task mutations for the human UI** if claim/release/complete/cancel/create are required. Otherwise present Tasks as intentionally read-only and remove fake controls.
4. **Conversation detail metadata** as a stable response rather than assembling it from unrelated calls in the drawer.
5. **Optional future contracts** for reactions and typing/presence only if those prototype affordances are approved as real product features.

## Phased implementation plan

Tasks are ordered within each phase. A task is complete only when its implementation, focused tests, and user-visible failure state are all present. File paths name the expected primary touch points; they may change after the Phase 1 module-layout decision.

### Phase 0 — stabilize the refactor branch

**Goal:** no silent regressions or dead primary controls.  
**Prerequisite:** none. Do this before visual expansion or architecture migration.

- [x] **0.1 Restore readable structured-answer content.**
  - Reuse or port `composeAnswer()` from `server/nth_ask_client.js` into the modular conversation/question code.
  - Change `answerPayload()` in `server/web/js/11-conversation.js` so `content` contains selected option text and custom answers; batched questions must produce one readable line per question.
  - Keep `reply_to` and structured `selection` unchanged for audit/rendering.
  - Update `tests/test-client-render.js` to assert the readable single- and multi-question content, not `Answered question #…`.

- [x] **0.2 Add a minimal conversation URL contract for DMs.**
  - Accept a DM thread key in the URL, initially as `?dm=<thread-key>` alongside the existing `?channel=` compatibility parameter.
  - Parse and validate it in `server/web/js/00-core.js`; expose a conversation kind/key rather than inferring everything from `state.channel`.
  - Update DM and audit rail rows in `server/web/js/20-workspace.js` to navigate with their thread key; audit rows must open read-only.
  - Add URL encoding/decoding tests for commas, agent IDs, and malformed/unknown keys.

- [x] **0.3 Load and render real DM history.**
  - On a DM route, call `/api/dms?with=<thread-key>` and ingest `messages` into the conversation timeline instead of showing the backing channel history.
  - Set the conversation title, participants, private banner, `state.dmTargetId`/recipients, and composer placeholder from the returned thread metadata.
  - Clear old channel messages before the DM response renders; show loading, empty, unauthorized/not-found, and retry states.
  - Ensure audit DMs never enable the composer.

- [x] **0.4 Keep the temporary DM view fresh.**
  - Until Phase 1 adds a workspace/DM event contract, refresh the active DM thread on a bounded interval and immediately after a successful send.
  - Deduplicate by message ID and suspend refresh while the document is hidden.
  - Mark this polling path with a removal condition tied to task **1.7**; do not let it become the permanent architecture.

- [x] **0.5 Restore DM send privacy.**
  - Build recipients from the active DM conversation, not selected `@` chips or the latest backing channel.
  - Verify text and image sends remain private, reply sends inherit the same participants, and the private banner remains visible before and after send.
  - Add a DOM/API test that fails if a DM send omits `recipients`.

- [x] **0.6 Fix boot-time and control wiring regressions.**
  - Create `#trio-agents` hidden and open it only from Agent roster/New agent actions.
  - Bind `#dictate-btn` to `toggleDictation()` and keep its pressed/recording/disabled state synchronized.
  - Bind `#jump-latest` to scroll and add a message-list scroll listener that shows/hides it.
  - Hide or visibly disable Search and Details until their Phase 6 implementations land; no enabled control may be inert.

- [x] **0.7 Wire current workspace actions.**
  - Add Allow/Decline handlers for `POST /api/approvals/<id>/resolve`, including pending, success, and retry states.
  - Make Open/Claimed/All task filters change the rendered list and selected tab; do not imply task mutation yet.
  - Add click handlers for agent-audit rows and active rail styling for the current route/view.

- [x] **0.8 Restore the Phase 6 archive contract.**
  - Add View and Restore actions for archived channels and DMs.
  - View archived history through a read-only conversation route with a visible archived banner and disabled composer.
  - Add Archive/Restore to the active conversation action surface.
  - Keep the internal agent inbox unavailable and preserve automatic DM resurfacing on newer activity.

- [x] **0.9 Reconcile client settings and limits with reality.**
  - Change the client upload cap to the server's 10 MB limit and show the limit before upload.
  - Persist the footer theme toggle through `Trio.preferences.save()`.
  - Remove, disable with explanatory copy, or implement compact, message-number, notification, chime, and dictation preferences; no checkbox may be a no-op.

- [x] **0.10 Add Phase 0 interaction coverage.**
  - Extend `tests/dom-harness.js` only as needed to boot the shell and trigger real button handlers.
  - Cover DM row → history → private send, audit read-only mode, readable answers, agent drawer visibility, dictation binding, jump-to-latest, approval decisions, task filters, archive View/Restore, and settings persistence.
  - Keep `tests/test-unified-workspace.py`, `tests/test-archives.py`, `tests/test-ask.py`, `tests/test-stt.py`, and `tests/test-web-agents.py` green.

**Exit criteria:** all Phase 6 acceptance flows work in the modular client; every visible primary control responds; selectable answers are readable to agents; DMs are visibly and technically private; no preference claims behavior it does not provide.

### Phase 1 — establish the application foundation

**Goal:** prevent the remaining prototype port from rebuilding a distributed monolith.  
**Prerequisite:** Phase 0 regressions have focused tests so the migration cannot silently remove behavior again.

- [x] **1.1 Lock the module/deployment decision.**
  - **Decision:** Keep the existing `server/nth_web.py` single-response, zero-build inline module registry. New foundation modules (`02-api.js`, `01-store.js`, `03-router.js`, `04-events.js`) are inserted before `00-core.js` in the bundle. This preserves the current Python-only deploy footprint, works offline without a build step, and allows both browser and Node harnesses to load the same ordered files. Browser support is modern evergreen (URL, EventTarget, fetch, CustomEvent); caching is the existing Python-rendered page response. Tests mirror the server module order in `tests/test-web-bundle.py` and `tests/dom-harness.js`.
  - Prototype native ESM served from safe `/assets/` routes and compare it with an explicit inlined module registry that preserves the portable single response.
  - Record the choice, browser support, cache behavior, test-loading strategy, and single-channel compatibility implications in this document.
  - Update `server/nth_web.py` composition tests before moving feature code.

- [x] **1.2 Introduce a single API service.**
  - Extract URL scoping, JSON parsing, normalized errors, timeouts, and `AbortSignal` support from `server/web/js/00-core.js`.
  - Define methods for workspace, channel history, DM history, send/upload, agents, approvals, tasks, archives, search, and health.
  - Prevent duplicate `channel` query parameters and distinguish channel-scoped from workspace-scoped endpoints.
  - Add contract tests for non-JSON errors, aborted requests, unauthorized responses, and malformed payloads.

- [x] **1.3 Define the store schema and actions.**
  - Create the `route`, `session`, `workspace`, `conversation`, `composer`, `agents`, `tasks`, `attention`, and `preferences` slices described above.
  - Define initialization and reset behavior for every field; eliminate the array-to-Map conversion of `state.messages`.
  - Expose `getState`, action methods, and slice subscriptions; do not expose unrestricted mutation.
  - Add tests for route resets, DM/channel separation, immutable updates, and subscriber cleanup.

- [x] **1.4 Build the first-class router.**
  - Support Home, Attention, Tasks, Agents, Preferences, `channel:<code>`, `dm:<key>`, and `audit:<key>` routes.
  - Use `history.pushState`/`replaceState` and handle `popstate`; retain compatibility redirects from `?channel=` and the temporary `?dm=` contract.
  - Preserve per-conversation draft and scroll state while changing routes.
  - Add route parsing, serialization, back/forward, refresh/deep-link, and unknown-route tests.

- [x] **1.5 Add route-aware loaders with cancellation.**
  - Give each route a monotonically increasing request/version token and abort the previous loader when navigation changes.
  - Prevent a late channel/DM response from replacing the active conversation.
  - Separate initial loading, background refresh, empty, stale, and fatal error state.
  - Test rapid channel → DM → channel transitions with intentionally reordered responses.

- [x] **1.6 Normalize events exactly once.**
  - Convert raw SSE payloads into named application actions in one event adapter.
  - Remove the current typed-event plus generic-`sse` double ingestion.
  - Track connection states (`connecting`, `live`, `reconnecting`, `offline`) and last received message ID.
  - Add deduplication and reconnection tests without duplicating cards or resetting scroll.

- [x] **1.7 Add a permanent workspace/DM live-event contract.**
  - Choose either an operator-scoped workspace EventSource or a thread-scoped DM EventSource in `server/nth_web.py`.
  - Reuse `_event_visible_to()` so workspace events cannot weaken DM/attachment visibility.
  - Include enough conversation identity in each event to route it without guessing from the current channel.
  - Replace and delete Phase 0's temporary DM polling; add cross-channel DM live-update and privacy tests.

- [x] **1.8 Define feature lifecycle boundaries.**
  - Require each feature to expose `mount`, `update`, and `unmount` and to declare its services/slices.
  - Move timers, EventSource listeners, media streams, and DOM listeners into lifecycle cleanup.
  - Add a development/test guard that reports leaked subscriptions after unmount.

- [x] **1.9 Build shared UI services.**
  - Implement accessible dialog, drawer, toast/live-region, icon, avatar, and normalized status primitives.
  - Centralize focus capture/return, Escape behavior, destructive confirmation, pending buttons, and user-facing error formatting.
  - Replace `window.alert`, `window.prompt`, ad hoc dialogs, and raw Unicode toolbar icons incrementally.

- [x] **1.10 Migrate existing features without changing behavior.**
  - Migrate in this order: preferences → workspace rail → conversation → composer → agents.
  - Remove direct feature-to-feature calls and private DOM queries; communicate through actions/services.
  - Delete `window.Trio.state` only after all focused and integration tests use the new interfaces.

**Exit criteria:** channel and DM navigation do not reload the page; feature dependencies are explicit; stale responses cannot overwrite the active route; every timer/listener is cleaned up; no feature reaches into another feature's private DOM.

### Phase 2 — design system and shell parity

**Goal:** create a stable visual base before styling every feature independently.  
**Prerequisite:** Phase 1 router, feature mount points, shared UI primitives, and route state are stable.

- [x] **2.1 Inventory prototype styles against shipped markup.**
  - Map each selector block in `02B-atrium.html:10-1121` to a supported component, a later approved feature, or dead prototype CSS.
  - Record the owner file for supported selectors and delete only after equivalent current markup has a test/snapshot.

- [x] **2.2 Consolidate design tokens.**
  - Move typography, spacing, radii, motion, surfaces, text, borders, shadows, status, code, focus, and accent variants into `styles/tokens.css`/`00-tokens.css`.
  - Remove duplicate `:root` and theme/accent definitions from the shell layer.
  - Verify all light/dark × eucalyptus/indigo/plum combinations and system-font fallback when Google Fonts are unavailable.

- [x] **2.3 Establish CSS ownership and layer order.**
  - Split reset/base, shell/layout, shared components, feature styles, utilities, and responsive overrides into readable non-minified files.
  - Define one naming convention for component state (`is-open`, `is-active`, `data-state`, etc.) and remove conflicting bridge aliases.
  - Add a bundle check that rejects duplicate token definitions and missing style files.

- [x] **2.4 Port the durable shell markup.**
  - Update `server/web/index.html` with explicit mount points for rail sections, primary view, topbar actions, conversation body, composer, drawers, dialogs, and toasts.
  - Port semantic landmarks and prototype SVG icons; remove placeholder letters and glyphs.
  - Keep dynamic content rendered by features rather than copying mock fixtures.

- [x] **2.5 Match navigation hierarchy and state.**
  - Render Home, Attention, Tasks, Channels, Agent↔Agent audit, Direct messages, Agent roster, Settings, and New agent in prototype order.
  - Show active route, unread/attention badges, status markers, previews, and intentional empty sections.
  - Populate owner identity from `/api/meta`, not hard-coded prototype data.

- [x] **2.6 Match the topbar and connection treatment.**
  - Render conversation/view title, topic/subtitle, connection pill, participant face pile, Search, Details, and overflow actions from route state.
  - Give connection and agent states text/icon cues so color is never the only signal.
  - Test long channel names, missing topics, many participants, and reconnecting/offline states.

- [x] **2.7 Implement one responsive shell model.**
  - Consolidate the duplicated 880px sidebar/scrim rules.
  - Define z-index tokens for sidebar, scrim, drawer, dialog, menu, toast, and search.
  - Support keyboard and pointer closing, body scroll lock, safe-area padding, and focus return.

- [ ] **2.8 Add shell visual fixtures.**
  - Capture canonical populated and empty shell states at 1440, 1024, 768, and 390 CSS pixels.
  - Cover light/dark and all three accents, long labels, unread badges, open mobile nav, offline state, and no-agent/no-channel first run.

**Exit criteria:** shell and tokens match the prototype in supported themes; CSS files have non-overlapping ownership; unused prototype CSS is not shipped; the shell remains usable without remote fonts.

### Phase 3 — conversation and composer parity

**Goal:** make the daily chat path polished and trustworthy.  
**Prerequisite:** Phase 2 shell/component tokens and Phase 1 conversation routing/state.

- [x] **3.1 Define a message view model.**
  - Normalize author identity, ownership, timestamps, recipients, sigils, reply target, attachments, choices/selection, confidence, edited/retracted state, and system/task type before rendering.
  - Keep raw server payloads out of DOM builders and test every message type independently.

- [~] **3.2 Port the prototype message row.**
  - Add avatar/status, author/role metadata, timestamp, message number (when enabled), bubble shape, own/private styling, and keyboard-reachable actions.
  - Preserve safe Markdown and retracted audit placeholders.
  - Gate edit/delete/reply/copy actions by ownership, archived state, and conversation capability.

- [x] **3.3 Add timeline grouping and system treatments.**
  - Insert day separators, unread divider, and muted system lines without storing synthetic rows in message state.
  - Render mention, bang, DM, task, question, edited, and confidence treatments from the view model.
  - Add reply context that scrolls/focuses the referenced message when available.

- [x] **3.4 Implement deterministic scroll/read behavior.**
  - Track near-bottom state, preserve an anchor when older/current messages rerender, and show Jump to latest only when needed.
  - Advance the read watermark only when the view is active and messages are actually visible.
  - Preserve independent scroll positions for every channel, DM, and audit route.

- [x] **3.5 Implement file and attachment interactions.**
  - Render local file paths as explicit safe actions rather than arbitrary HTML links.
  - Add image thumbnails, alt text, loading/error state, and a lightbox/open-original action.
  - Add paste and drag/drop upload with the same MIME/size validation as the picker.

- [~] **3.6 Define composer state per conversation.**
  - Store text draft, selected targets, reach mode, attachments, reply target, dictation state, send state, and error by conversation identity.
  - Restore drafts after route changes/reload and clear only after confirmed send.
  - Disable the composer for archived/audit/unavailable conversations with explanatory copy.

- [x] **3.7 Add sigil autocomplete.**
  - Detect `@`, `#`, and `!` tokens at the caret; filter roster targets; support Arrow keys, Enter/Tab, Escape, mouse, and screen readers.
  - Insert the selected canonical display name while preserving member IDs in the payload.
  - Exclude invalid targets and explain listening/filter implications for `@`, `#`, and `!`.

- [x] **3.8 Add reach controls and preview.**
  - Implement the prototype mode tabs and recipient preview for room broadcast, targeted channel message, and DM.
  - Show exactly who will receive/wake before send and require confirmation only for the approved broadcast-risk case.
  - Make privacy/reach derive from route and payload state, not CSS alone.

- [~] **3.9 Finish composer interaction polish.**
  - Add textarea auto-grow, Shift+Enter newline, composition-event safety, attachment preview/removal, upload progress, and send retry.
  - Keep dictation start/stop/fallback mutually exclusive and stop media tracks on route change/unmount.
  - Provide visible keyboard hints without overriding platform conventions.

- [x] **3.10 Rebuild structured questions accessibly.**
  - Render each question as a `fieldset`/`legend`; use radio semantics for one and checkbox semantics for many.
  - Show batch position, current selections, custom-answer rules, finality, sent/answered/read-only states, and recover from lost SSE echo by ingesting the POST response.
  - Cover leading-`[` question text and all deferred selectable-answer issues in `TODO.md`.

- [x] **3.11 Implement approved display preferences.**
  - Make compact mode alter spacing/clamping with per-message expand.
  - Make message numbers render real IDs, and make font choice affect only message content where intended.
  - Remove any display preference that is not approved or testable.

- [x] **3.12 Decide prototype-only chat features.**
  - Make an explicit product decision for reactions, typing indicators, and read acknowledgements.
  - If approved, define server schema/events/privacy and tests before UI work; otherwise remove their unused prototype CSS.

**Exit criteria:** channel and DM chat match the prototype's approved visual/interaction contract; keyboard-only send/target/reply/answer flows pass; privacy and reach are unmistakable before and after send; scroll/read behavior survives live updates and route changes.

### Phase 4 — workspace, attention, and tasks

**Goal:** answer “what needs me?” without turning the product into a process monitor.  
**Prerequisite:** Phase 1 store/router/events and Phase 2 workspace components.

- [ ] **4.1 Define shared workspace selectors.**
  - Derive unread DMs/mentions, unanswered questions, pending approvals, blocked/errored agents, active agents, recent channels, task counts, and health from normalized slices.
  - Use the same selectors for rail badges, Home cards, and Attention tabs so counts cannot drift.
  - Add fixture tests for zero, one, mixed, resolved, archived, and stale states.

- [ ] **4.2 Build the Home summary.**
  - Implement greeting/summary, attention, active-agent, task, recent-channel, and runtime-health cards from real data.
  - Make every card route to its filtered destination and retain a calm empty state when nothing needs action.
  - Show partial-data and provider-unavailable states without failing the entire view.

- [ ] **4.3 Define the Attention item model.**
  - Normalize approvals, unanswered questions, agent errors/blocks, usage warnings, and lock conflicts into common identity, severity, source, timestamp, status, and action fields.
  - Separate active and resolved/history items and define stable ordering/deduplication.

- [ ] **4.4 Complete approval interaction.**
  - Render risk/context details from the real approval payload.
  - Support `accept`, `acceptForSession`, `decline`, and `cancel` only where valid; disable duplicate submissions and reconcile server conflicts.
  - Move resolved items to history and update all counts without waiting for the 15-second refresh.

- [ ] **4.5 Decide and implement the operator task contract.**
  - Confirm whether humans may create, claim, release, complete, cancel, and edit dependencies from the UI.
  - If yes, add authenticated HTTP handlers in `server/nth_web.py` that reuse task validation/transactions from `nth_server.py`; add authorization and conflict tests.
  - If no, remove mutation affordances and label the board read-only.

- [ ] **4.6 Build the task board.**
  - Render status chips, owner, blockers/dependencies, result, timestamps, and channel context.
  - Implement All/Open/Claimed/Blocked/Done filters, stable counts, empty states, and the approved inline/detail actions.
  - Route task-origin links back to the relevant channel/message.

- [ ] **4.7 Replace interval-only refresh with store updates.**
  - Route task, approval, agent, and message events into workspace selectors immediately.
  - Retain a low-frequency reconciliation fetch for missed events and visibility resume.
  - Ensure reconciliation never reopens resolved items or overwrites an optimistic pending state with older data.

- [ ] **4.8 Add complete workspace states and tests.**
  - Implement skeleton/loading, all-clear, first-run, partial failure, stale, offline, forbidden, and retry states for Home/Attention/Tasks.
  - Add DOM/browser tests for card routing, count agreement, approval success/conflict/failure, task filters/actions, and live updates while a view is open.

**Exit criteria:** counts agree across rail and views; decisions update immediately and survive refresh; task capabilities are explicit; partial failures are visible and retryable without blanking the workspace.

### Phase 5 — complete agent workflows

**Goal:** expose the mature backend without provider-specific clutter.  
**Prerequisite:** Phase 1 feature/store/dialog foundations and Phase 2/4 status/card components.

- [ ] **5.1 Define a provider-neutral agent view model.**
  - Normalize durable identity, provider, model, effort, lifecycle state, busy/queue state, last activity, status text, placements, wake policy, cwd, permission profile, context/session data, and error.
  - Define labels/icons and valid action capabilities for spawning, working, active, idle, sleeping, stopped, blocked, errored, stale, and external agents.

- [ ] **5.2 Build the agent directory.**
  - Replace the fixed boot-time drawer with the prototype roster view.
  - Add All/Active/Working/Resting/Needs attention filters, count, search, responsive cards, empty state, and keyboard card activation.
  - Show status, provider/model, current work, last active, placements, and queued/unread indicators without exposing raw runtime noise.

- [ ] **5.3 Build the agent detail drawer.**
  - Show identity/bio, runtime configuration, listening mode, placements, current state/error, context/session information, and DM entry.
  - Deep-link selected agent state so refresh/back closes or restores the drawer predictably.
  - Load expensive activity only when its section opens.

- [ ] **5.4 Render structured runtime activity.**
  - Map plans, commands/tools, diffs/files, approvals, warnings, errors, queue transitions, and usage to a typed timeline.
  - Paginate/load more instead of truncating silently to 20 raw JSON lines.
  - Keep operator-only authorization and avoid rendering raw unsafe tool input.

- [ ] **5.5 Implement a lifecycle action matrix.**
  - Map stop, interrupt, wake, hibernate, compact, clear, and delete visibility/enabled state to lifecycle/provider capabilities.
  - Add pending state, success reconciliation, provider-specific error copy, and duplicate-click protection.
  - Require explicit confirmation for context-destructive clear and permanent delete; state exactly what is preserved or lost.

- [ ] **5.6 Implement placement and wake-policy editing.**
  - Load public channels, prevent use of the hidden inbox, and support add/remove with rollback on failure.
  - Explain `at`, `about`, and `all`; update cards/details immediately after success.
  - Test zero-placement agents and removal from the currently viewed channel.

- [ ] **5.7 Rebuild agent creation from discovery APIs.**
  - Load `/api/health` and `/api/agent-models` before enabling create.
  - Implement provider, model, effort/reasoning, name, role/prompt, working directory, permission profile, wake policy, placements, and color/avatar inputs where supported.
  - Show provider-specific fields conditionally while preserving one shared form model.

- [ ] **5.8 Add validation and spawn progress.**
  - Validate required fields, names, cwd, provider readiness, model/effort combinations, permissions, and placements before POST.
  - Show creating → starting runtime → connecting → ready stages from real response/state where possible; do not simulate success timers.
  - Preserve form input on failure and offer retry/cancel without duplicate durable rows.

- [ ] **5.9 Connect agent messaging.**
  - Make every Message action open the agent's unified DM route, including zero-placement agents.
  - After successful creation, offer/open the new DM without requiring a public placement.
  - Test privacy, hidden-inbox suppression, and back navigation to the originating agent view.

- [ ] **5.10 Add agent workflow coverage.**
  - Extend deterministic tests for capability-state rendering, all lifecycle actions, placements, wake policies, provider discovery, invalid forms, spawn failure/retry, delete confirmation, and Message routing.
  - Keep `tests/test-web-agents.py`, `tests/test-web-codex-agents.py`, supervisor/runtime suites, and mixed-provider routing green.

**Exit criteria:** every backend lifecycle operation intended for humans is reachable and state-gated; Claude/Codex differences appear only where required; zero-placement agents remain messageable; no action can be submitted twice accidentally.

### Phase 6 — search, details, archives, preferences, and responsive polish

**Goal:** finish secondary workflows and remove placeholders.  
**Prerequisite:** primary routing, conversation, workspace, and agent flows are complete.

- [ ] **6.1 Implement global search.**
  - Open from the header and `Cmd/Ctrl+K`; debounce/cancel requests to `/api/search`.
  - Render query highlighting, channel/DM context, author/time, loading/empty/error states, and keyboard selection.
  - Route a result to its conversation and target message, loading history around it if it is outside the current window.

- [ ] **6.2 Define conversation-details data.**
  - Add or compose a stable contract for objective/topic, status/archive state, members, task summary, message/activity stats, and allowed management actions.
  - Avoid one request per member/task and preserve operator/guest authorization boundaries.

- [ ] **6.3 Build the Details drawer and overflow menu.**
  - Render members/status, objective, task summary, activity stats, notification state, and management actions.
  - Implement archive/restore, end/leave where approved, and destructive confirmations.
  - Support responsive full-width drawer behavior, focus return, Escape, and route changes.

- [ ] **6.4 Complete archive navigation.**
  - Separate archived channels and DMs, with search/filter if lists are nontrivial.
  - Deep-link View into read-only history and preserve archive context on Back.
  - Restore in place, update rail/archive counts immediately, and redirect an open restored conversation to its active route.
  - Verify newer DMs automatically resurface and archived channels preserve tasks/membership/runtime state.

- [ ] **6.5 Finalize the supported preference schema.**
  - List every preference, default, persistence key, affected component, and platform capability.
  - Migrate/validate old `trio.preferences.v1` data and ignore unknown/corrupt values safely.
  - Remove controls for rejected features and add reset-to-default behavior.

- [ ] **6.6 Implement notifications, dictation settings, and diagnostics.**
  - Handle browser notification permission, scope/timing, and chime volume with clear unsupported/denied states.
  - Choose local Whisper vs browser speech, expose `/api/stt/health`, add a real mic/transcription test, and stop media on close.
  - Render structured app/database/Claude/Codex/STT/service diagnostics with copyable actionable errors rather than a JSON dump.

- [ ] **6.7 Execute the responsive matrix.**
  - Test every primary view, drawer, dialog, menu, composer, question card, code block, table, attachment, and long message at 1440, 1024, 768, and 390 CSS pixels.
  - Fix overflow, safe areas, virtual keyboard behavior, touch targets, sticky elements, and nested scroll traps.
  - Verify orientation change and browser zoom through 200%.

- [ ] **6.8 Complete the accessibility audit.**
  - Verify landmarks/headings, accessible names/descriptions, fieldsets, tab/tabpanel relationships, menus, dialogs, live status/toasts, and error associations.
  - Test full keyboard flows and logical focus return for navigation, send, questions, approvals, tasks, agents, search, archives, and settings.
  - Verify reduced motion, contrast, non-color status cues, target size, and screen-reader announcements.

- [ ] **6.9 Remove placeholders and dead compatibility UI.**
  - Search the shipped shell for unused IDs/classes, inert controls, raw debug JSON, hard-coded product copy, and old bridge styles.
  - Remove temporary Phase 0 disabled controls only after their real implementations exist.
  - Add a test that every enabled toolbar/nav action has a registered handler.

**Exit criteria:** no placeholder screen, inert control, raw debug panel, or no-op setting remains; secondary workflows are usable on keyboard, screen reader, desktop, and narrow layouts.

### Phase 7 — test and release hardening

**Goal:** make future UI changes safe and make release claims reproducible.  
**Prerequisite:** approved Atrium scope is feature-complete.

- [ ] **7.1 Upgrade the zero-dependency DOM harness.**
  - Boot the actual composed shell with controllable fetch, EventSource, history/location, dialog, media, localStorage, and timers.
  - Add helpers for click, keyboard, input, route changes, and async flush; keep pure renderer tests fast.
  - Fail on uncaught promise rejections, duplicate IDs, leaked listeners/timers, and enabled buttons without handlers.

- [ ] **7.2 Add client/server contract fixtures.**
  - Capture representative JSON for meta, channels, DMs/history, events, tasks, approvals, agents/models/activity, archives, search, health, attachments, and STT.
  - Validate required fields and compatibility defaults in both Python endpoint tests and JavaScript adapters.
  - Include malformed, unauthorized, missing, stale, and provider-unavailable responses.

- [ ] **7.3 Establish browser automation.**
  - Select a maintained browser runner, pin an appropriately aged version, and document one local command.
  - Launch the real stdlib server against a temporary database and use deterministic fake Claude/Codex runtimes.
  - Isolate ports, cookies, attachments, service state, and screenshots per test run.

- [ ] **7.4 Cover critical end-to-end journeys.**
  - First run → create channel → create zero-placement agent → DM it.
  - Channel live chat → target/reply/upload/dictate/question answer → edit/delete.
  - Cross-channel unified DM privacy and audit DM read-only behavior.
  - Approval resolve, task filters/actions, lifecycle operations, archive View/Restore, search result routing, settings persistence, and mobile navigation.
  - Reconnect, offline/retry, rapid route switching, provider failure, and stale-response races.

- [ ] **7.5 Add visual regression fixtures.**
  - Seed canonical prototype states for Home, Attention, Tasks, channel chat, DM, audit DM, question, agent directory/detail/create, search, details, archives, and preferences.
  - Snapshot supported themes/accents and desktop/tablet/mobile widths.
  - Define masking/tolerance rules only for timestamps, animated cursors, and other genuinely nondeterministic pixels.

- [ ] **7.6 Define and run the deterministic release suite.**
  - Group fast DOM/unit, browser, web/API, privacy, archive, ask/STT, supervisor, Claude, Codex, routing, first-run, and app/launch service checks under documented commands.
  - Exclude token-consuming and long-duration experimental probes by name rather than ad hoc omission.
  - Require `py_compile`, bundle composition, and `git diff --check`.

- [ ] **7.7 Perform real-runtime acceptance.**
  - Run one authenticated Claude and one authenticated Codex agent through create, DM, public mention, reply, stop/hibernate, wake, and delete.
  - Confirm approval/activity behavior for Codex and no duplicate bridged/MCP reply.
  - Record only pass/fail and non-sensitive diagnostics; do not commit transcripts, tokens, or local paths containing secrets.

- [ ] **7.8 Refresh project documentation.**
  - Update `CURRENT.md`, `README.md`, `CHANGELOG.md`, `TODO.md`, and `QA-unified-interface.md` with the accepted architecture, supported UI scope, commands, known deferrals, and real-runtime evidence.
  - Remove stale branch/version claims and distinguish prototype-only deferred features from bugs.

- [ ] **7.9 Remove migration scaffolding.**
  - Delete temporary DM polling, compatibility route shims no longer required, dead `window.Trio` surfaces, copied unused prototype CSS, and obsolete test hooks/fixtures.
  - Keep single-channel compatibility intentionally supported and tested rather than removing it accidentally.
  - Run the complete release suite after cleanup.

**Exit criteria:** automated coverage catches the dead-control, readable-answer, DM, archive, and state-race regressions identified in this review; visual changes are compared against stable fixtures; deterministic and real-runtime acceptance pass; documentation describes the code that actually ships.

## Suggested work breakdown and dependencies

```text
Readable ask answers ───────────────────────────────────────┐
DM route/history/send ──> conversation identity ────────────┤
Dead-control wiring ────────────────────────────────────────┤
Archive restoration ────────────────────────────────────────┘
                                                            ↓
Router + state slices + normalized events + UI primitives
                                                            ↓
Tokens/shell ──> conversation/composer ──> home/attention/tasks
                                      └──> agents
                                                            ↓
Search/details/archives/preferences/responsive/accessibility
                                                            ↓
Browser + visual regression suite and documentation refresh
```

Do not begin by porting every prototype class into more CSS. The route/state/component foundation and restored workflows are prerequisites; otherwise each new screen will invent another state shape and dialog pattern.

## Definition of done for Atrium parity

The refactor is ready to call complete when:

- all approved prototype views are backed by real data, not fixtures or static placeholders;
- every visible control and preference has tested behavior;
- channel, DM, and audit conversations have explicit identities and preserve drafts/scroll state;
- privacy, addressing reach, archived/read-only state, and agent lifecycle state are visible before an action;
- all Phase 6 backend capabilities intended for humans remain reachable;
- state ownership and feature dependencies are documented and enforced by code structure;
- the prototype's supported desktop/mobile, light/dark, keyboard, and accessibility states are verified;
- deterministic backend, DOM interaction, browser E2E, and visual regression suites pass;
- project status and QA documentation reflect the shipped UI rather than the pre-refactor product.

## Overall assessment

The branch has a strong backend and a useful extraction scaffold, but it should not yet be treated as a near-complete Atrium implementation. The highest-value next move is not more decorative CSS: it is restoring DMs/questions/archives/control-plane behavior and introducing a route/state/component architecture that can absorb the prototype without recreating the old monolith.
