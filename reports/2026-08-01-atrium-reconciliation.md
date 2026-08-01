# Atrium UI refactor — reconciliation items before Phase 2

**Date:** 2026-08-01
**Branch:** `phase-7-ui-updates` at `cef66e0`
**Source:** LOTC review (Sauron, Gandalf, Frodo, Aragorn, Legolas, Uruk-Hai)
**Purpose:** Architectural and structural issues that must be resolved before the full UI refactor (Phase 2+) proceeds. These are NOT runtime bugs (those are filed in `bugs/`) — they are design-level problems that will compound if Phase 2 is built on top of the current foundation.

---

## Context

The Atrium UI refactor plan (`ATRIUM-UI-REFACTOR-PLAN.md`) marks Phase 0 and
most of Phase 1 as complete. The LOTC review found that several marked-complete
tasks do not actually meet their stated exit criteria. The foundation modules
exist (store, router, lifecycle, events, loader, UI services) but are not
integrated — features continue to use the legacy `window.Trio.state` singleton
and bypass the new infrastructure.

Phase 2 (design system and shell parity) and beyond will add significant new UI
surface area. Building on a foundation where the store, router, and lifecycle
systems are dead code will recreate the monolith across multiple files — the
exact outcome the refactor was meant to prevent.

---

## Reconciliation items

### 1. State split-brain — two parallel state systems

**Status:** Phase 1 task 1.3 marked complete; exit criteria not met.

The plan specifies a store with typed slices and "Only actions change state."
The store (`01-store.js`) defines the correct schema (route, session, workspace,
conversation, composer, agents, tasks, attention, preferences). But feature
modules bypass it entirely and mutate `window.Trio.state` directly:

- `20-workspace.js`: 20+ direct mutations (`state.view=`, `state.channel=`, `state.messages=new Map()`, `state.dmKey=`, etc.)
- `12-composer.js`: 7 direct mutations (`state.selectedTargets=`, `state.pendingAttachments=`, etc.)
- `11-conversation.js`: 10+ direct mutations (`state.members=`, `state.operator=`, `state.lastSeenId=`, etc.)
- `04-events.js:20`: `Trio.state.members = new Map(...)` directly
- `00-core.js:14-15,27-28`: `root.state.channel=`, `root.state.conversation=`, `root.state.meta=`

Only `30-agents.js` and `40-preferences.js` use `Trio.store.get/set` — and the
agent module's store usage introduced a bug (see `bugs/2026-08-01-agent-create-unset-session-channel.md`)
because `session.channel` is never written to the store.

**Resolution required:**
- Decide: is the store the single source of truth, or is `window.Trio.state`?
- If the store: migrate all feature mutations to store actions. Write
  `session.channel` to the store when the channel changes. Remove direct
  `state.X =` mutations.
- If legacy state: remove `01-store.js` to avoid confusion.
- The plan says the store is the direction. The migration (task 1.10) is marked
  incomplete and should be completed before Phase 2.

### 2. Router is orphaned — navigation uses full page reload

**Status:** Phase 1 task 1.4 marked complete; exit criteria not met.

The router (`03-router.js`) implements `navigate()` with `pushState`/`replaceState`
and `init()` with `popstate`/`click` delegation. `router.init()` IS called (via
the lifecycle fallback to `init()`), so the handlers are registered. But no
module calls `router.navigate()`. All navigation uses `location.assign()` (full
page reload) in `20-workspace.js:24` and `00-core.js:31`.

The Phase 1 exit criteria states "channel and DM navigation do not reload the
page." This is not met.

**Resolution required:**
- Replace `location.assign()` in `openChannel()` with `router.navigate('channel', {code})`.
- Replace direct state mutation in `openDm()` with `router.navigate('dm', {key})`.
- Have features subscribe to `router.on(route => ...)` to handle route changes.
- This is also filed as a bug (`bugs/2026-08-01-router-never-initialized-page-reload.md`)
  because it has a runtime UX impact, but the architectural resolution (route-
  driven feature updates) must happen before Phase 2.

### 3. Lifecycle system incomplete — no update() methods, reportLeaks never called

**Status:** Phase 1 task 1.8 marked complete; partially implemented.

The lifecycle module (`07-lifecycle.js`) defines `mount`/`unmount`/`unmountAll`/
`reportLeaks`. After the task 1.10 commits, most features now expose `mount()`
and `unmount()` (conversation, composer, workspace, agents, preferences). But:

- **No feature exposes `update()`.** The plan specifies `mount(root, services)`,
  `update(slice, previousSlice)`, `unmount()`. The `update()` method — which
  enables reactive re-rendering from store changes — is not implemented anywhere.
- **Router has no `mount()`.** It relies on the lifecycle fallback to `init()`.
- **`reportLeaks()` is never called.** The leak tracking system (`ctx.track()`)
  is not used by any feature, and `reportLeaks()` is never invoked in
  development or test mode.
- **The `services` parameter is not used.** `lifecycle.mount(name, feature,
  services=[])` passes a `services` array to the feature's `mount(ctx)`, but no
  feature reads `ctx.services` or uses it to declare dependencies.

**Resolution required:**
- Add `update()` to features that need reactive re-rendering (conversation,
  workspace rail, composer).
- Add `mount()` to the router for consistency.
- Call `reportLeaks()` after unmount in development/test mode.
- Have features declare and use their service dependencies via `ctx.services`.

### 4. Event normalization — redundant listener registration

**Status:** Phase 1 task 1.6 marked complete; exit criteria partially met.

The plan says "Remove the current typed-event plus generic-`sse` double
ingestion." The `04-events.js` adapter correctly normalizes SSE payloads into
typed events. But `11-conversation.js:276-278` registers THREE listeners that
all call the same handler:

```js
events.addEventListener('messages', onMessage);  // dead — 'messages' never dispatched
events.addEventListener('message', onMessage);
events.addEventListener('message_update', onMessage);
```

The `'messages'` (plural) listener is dead code (see bug report). The `'message'`
and `'message_update'` listeners are both needed, but they should be clearly
documented as distinct event types, not a triple registration that looks like
a mistake.

**Resolution required:**
- Remove the dead `'messages'` listener.
- Document the event contract: what types does `04-events.js` dispatch, and
  what does each feature listen for?

### 5. Cross-feature direct calls — implicit dependencies

**Status:** Phase 1 task 1.10 marked incomplete; not resolved.

The plan states "Features should not query or call another feature's private
DOM" and "Remove direct feature-to-feature calls." Current cross-feature calls:

- `20-workspace.js` → `Trio.conversation?.render?.()` (4 calls)
- `20-workspace.js` → `Trio.agents?.refresh?.()` (1 call)
- `20-workspace.js` → `Trio.preferences?.panel?.()` (1 call)
- `12-composer.js` → `Trio.conversation?.upsert()` (1 call)
- `12-composer.js` → `Trio.preferences?.read?.()` (1 call)
- `11-conversation.js` → `Trio.workspace?.openDm?.()` (1 call, in retry button)
- `90-boot.js` → `Trio.workspace?.archiveCurrent?.()` (1 call)
- `90-boot.js` → `Trio.workspace?.openDmByKey()` (1 call)

These create implicit dependencies between features. If a feature is renamed,
reordered, or not loaded, the optional chaining silently swallows the failure.

**Resolution required:**
- Replace cross-feature calls with event-based communication. Features emit
  events (`'conversation:loaded'`, `'dm:requested'`, `'approval:resolved'`)
  and other features subscribe via `Trio.events`.
- Or use the router as the coordination layer — route changes trigger feature
  updates via `router.on(route => ...)`.

### 6. Duplicated utilities — esc() and apiUrl()

Three copies of `esc()` exist with different escape sets (see bug report
`2026-08-01-dead-listener-null-deref-esc-double-escape.md` Bug C). Two copies
of `apiUrl()` exist (`11-conversation.js:165-168` and `12-composer.js:15-19`).
Both are fallback wrappers around `Trio.api.url()`.

**Resolution required:**
- Extract a single `esc()` into a shared utilities module (`08-utils.js` or
  fold into `06-ui.js`).
- Remove `apiUrl()` from feature modules — use `Trio.api.url()` directly.

### 7. window.alert / window.prompt still in use

**Status:** Phase 1 task 1.9 marked complete; exit criteria not met.

The plan says "Replace `window.alert`, `window.prompt`, ad hoc dialogs." The
`Trio.ui.modal()` and `Trio.ui.confirmAction()` helpers exist. But
`11-conversation.js` still uses:
- `window.alert()` (line 113, in `submitAnswer` error handling)
- `window.prompt()` (line 170, in `retract` for deletion reason)
- `window.prompt()` (line 175, in `edit` for new content)

**Resolution required:**
- Replace `window.alert` with `Trio.ui.toast()`.
- Replace `window.prompt` with `Trio.ui.modal()` containing an input field.

### 8. Store subscriptions unused

The store (`01-store.js`) exposes `subscribe(slice, fn)` that returns an
unsubscribe callback. No module calls `subscribe()`. The subscription system
is implemented but completely unused — features poll `state.X` directly instead
of reacting to slice changes.

This means the `update(slice, previousSlice)` lifecycle method (item 3 above)
has no data source — there's no mechanism to notify features when a store
slice changes.

**Resolution required:**
- Either wire features to store subscriptions (enabling reactive `update()`),
  or remove the subscription system if the architecture will use direct state
  access instead.

### 9. Implicit load-order coupling

Modules are loaded in numeric order (00-core through 90-boot). Dependencies are
implicit: `11-conversation.js` assumes `Trio.markdown` exists (loaded by
`10-markdown.js`), `12-composer.js` assumes `Trio.api` exists, etc. The numeric
prefix is the only signal of dependency order. If the order changes, modules
fail with unclear errors.

The `tests/dom-harness.js` and `tests/test-atrium-workspace.js` both hardcode
the load order, which must be kept in sync manually.

**Resolution required:**
- Add explicit dependency guards at the top of each module (e.g.,
  `if (!Trio.markdown) throw new Error('11-conversation requires 10-markdown')`).
  Some modules already do this (`10-markdown.js:5`, `11-conversation.js:4`).
- Or document the load order contract in a single place and validate it in
  the bundle test.

---

## Priority order for resolution

1. **State split-brain** (item 1) — everything else depends on knowing where
   state lives. The agent creation bug is already a symptom of this.
2. **Router orphaned** (item 2) — enables SPA navigation, which is a
   prerequisite for Phase 2 shell work and for the unbounded Maps bug to become
   relevant.
3. **Cross-feature calls** (item 5) — replace with events or router-driven
   updates. This is the core of the "distributed monolith" risk.
4. **Lifecycle incomplete** (item 3) — wire `update()` and `reportLeaks()` once
   the store subscriptions (item 8) are decided.
5. **Duplicated utilities** (item 6) — quick win, do early.
6. **window.alert/prompt** (item 7) — quick win, do early.
7. **Event normalization** (item 4) — remove dead listener, document contract.
8. **Store subscriptions** (item 8) — decide architecture, then wire or remove.
9. **Load-order coupling** (item 9) — add guards, low urgency.

---

## What does NOT need reconciliation

- **The markdown renderer** is architecturally sound (the XSS issue is a bug,
  filed separately, not an architectural problem).
- **The SSE event adapter** (`04-events.js`) correctly normalizes payloads.
  The new workspace SSE endpoint (`/api/workspace/events`) is a good addition.
- **The loader** (`05-loader.js`) correctly implements cancellation. The
  AbortController pattern is sound.
- **The UI services** (`06-ui.js`) provide the right primitives (toast, modal,
  confirmAction, setLive). They just need to be used more widely.
- **The test harness** (`tests/dom-harness.js`) is well-designed for its
  purpose. The zero-dependency philosophy is maintained.
