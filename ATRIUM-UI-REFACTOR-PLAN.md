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

### Phase 0 — stabilize the refactor branch

Goal: no silent regressions or dead primary controls.

- Fix structured-answer text using the existing ask composition helper; update its DOM test.
- Implement real DM navigation, merged-history loading, recipient state, privacy banner, and send behavior.
- Keep DM updates live by adding the chosen event contract or a clearly temporary polling strategy.
- Hide the agent drawer until explicitly opened.
- Wire dictation and align the upload limit with the server.
- Wire approval decisions and task filters.
- Restore archive View/read-only/current Archive-or-Restore flows.
- Either wire Search, Details, and Jump to latest or hide them until their phase lands.
- Remove or label no-op preferences.
- Add regression tests for each item above.

**Exit criteria:** all Phase 6 acceptance flows work in the modular client; every visible primary control responds; no preference claims behavior it does not provide.

### Phase 1 — establish the application foundation

Goal: prevent the remaining prototype port from rebuilding a distributed monolith.

- Add first-class routes for workspace views, channels, DMs, and audit DMs.
- Introduce explicit store slices/actions and migrate one feature at a time off arbitrary `Trio.state` mutation.
- Normalize each SSE payload exactly once before dispatch.
- Add request cancellation/version guards for route changes and background refreshes.
- Add shared dialog, drawer, toast, icon, avatar, and status primitives.
- Define feature mount/update/unmount contracts.
- Decide native ESM/static assets versus the inlined module registry; document the choice.
- Preserve drafts and scroll state per conversation.

**Exit criteria:** channel and DM navigation do not reload the page; feature dependencies are explicit; a stale route response cannot overwrite the active route; no feature reaches into another feature's DOM.

### Phase 2 — design system and shell parity

Goal: create a stable visual base before styling every feature independently.

- Move all tokens into one source of truth.
- Split copied prototype CSS by actual component/feature ownership.
- Delete selectors for unapproved or nonexistent components.
- Port the prototype shell markup, SVG icons, navigation hierarchy, active states, owner footer, connection pill, and face pile.
- Implement mobile navigation with one tested scrim/z-index model.
- Add light/dark/accent snapshots at desktop and narrow widths.

**Exit criteria:** shell and tokens match the prototype in supported themes; CSS files have non-overlapping ownership; unused prototype CSS is not shipped.

### Phase 3 — conversation and composer parity

Goal: make the daily chat path polished and trustworthy.

- Port message row/avatar/bubble markup and message-type treatments.
- Add date grouping, reply context, system events, file links, confidence treatment, unread/jump behavior, and robust scroll preservation.
- Implement compact mode and optional message numbers or remove those settings.
- Add autocomplete for `@`, `#`, and `!`, reach/mode controls, and recipient preview.
- Add DM lock/banner treatments, attachment thumbnails/drop, textarea auto-grow, and draft persistence.
- Build the prototype question card with fieldset/radio/checkbox semantics and readable sent content.
- Decide whether reactions and typing indicators are real product work or prototype-only decoration.

**Exit criteria:** channel and DM chat match the prototype's core visual/interaction contract; keyboard-only send/target/reply/answer flows pass; privacy is visually unmistakable before and after send.

### Phase 4 — workspace, attention, and tasks

Goal: answer “what needs me?” without turning the product into a process monitor.

- Build the real Home summary from channels, DMs, agents, tasks, approvals, and health.
- Build Attention tabs/cards and approval decisions with optimistic pending states and error recovery.
- Build Tasks against the chosen read/write contract, including filters, dependencies, ownership, and results.
- Update open views immediately from SSE/store changes rather than waiting for the 15-second refresh.
- Add intentional empty, loading, stale, offline, and error states.

**Exit criteria:** counts agree across rail and views; decisions update immediately and survive refresh; failures are visible and retryable.

### Phase 5 — complete agent workflows

Goal: expose the mature backend without provider-specific clutter.

- Implement the prototype directory and status filters.
- Build agent details with provider/model/effort, placements, wake policy, session/context state, activity, and errors.
- Expose stop, interrupt, wake, hibernate, compact, clear, placement, wake-policy, and delete controls as appropriate to current state.
- Rebuild agent creation from real `/api/agent-models`, health/readiness, and provider-specific fields.
- Add validation, spawn progress, cancellation/error recovery, and destructive confirmations.
- Make “Message” open/create the correct DM route.

**Exit criteria:** every backend lifecycle operation intended for humans is reachable and state-gated; Claude/Codex differences appear only where required; zero-placement agents remain messageable.

### Phase 6 — search, details, archives, preferences, and responsive polish

Goal: finish the secondary workflows and remove placeholders.

- Implement global search with keyboard navigation and result routing.
- Implement conversation details and management drawer.
- Finish archive browsing, read-only viewing, restoring, and current-conversation actions.
- Implement the approved preference set, notification permission/scope, dictation engine/test, and structured diagnostics.
- Verify all views/dialogs/drawers at 1440, 1024, 768, and 390 CSS pixels, in light and dark themes.
- Audit focus order/return, labels, landmarks, live announcements, reduced motion, contrast, and touch targets.

**Exit criteria:** no placeholder screen or dead setting remains; prototype-supported secondary workflows are usable on keyboard, screen reader, desktop, and narrow layouts.

### Phase 7 — test and release hardening

Goal: make future UI changes safe.

- Expand the zero-dependency DOM harness to boot the actual shell and click every primary control.
- Add API-contract tests for route loaders and mutations.
- Add browser automation for navigation, DMs, approvals, tasks, agent creation/lifecycle, archives, search, dictation-mode selection, and responsive dialogs.
- Add visual snapshots for the prototype's canonical states and themes.
- Run the existing backend privacy/lifecycle suites unchanged.
- Perform one manual real-runtime smoke for Claude and Codex after the deterministic suite.
- Update `CURRENT.md`, `README.md`, `CHANGELOG.md`, `TODO.md`, and the QA guide with the accepted Phase 7 scope.

**Exit criteria:** automated coverage catches the current dead-control and DM regressions; visual changes are reviewed against stable fixtures; documentation describes the code that actually ships.

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
