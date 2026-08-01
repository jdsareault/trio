# LOTC Review — Unified Interface (Phase 1 + Phase 2)

**Date:** 2026-07-31
**Branches:** `feat/unified-phase1-multichannel`, `feat/unified-phase2-supervisor` (stacked)
**Base:** `main`
**Reviewers:** Sauron (correctness), Gandalf (architecture), Frodo (UX), Aragorn (security), Legolas (perf/leaks), Ents (tests), Uruk-Hai (bug hunt)

## Summary

Reviewed the multi-channel `nth_web.py` refactor + the `agents`/`agent_channels`
schema + the `nth_supervisor.py` process-lifecycle core, before wiring the
supervisor to the hub. The bones were endorsed by all reviewers (lazy per-channel
runtimes, supervisor testability, additive schema, full-reload channel switch).
The review surfaced a cluster of **real** issues — most importantly that making
`channel` per-request removed the implicit per-channel access boundary — which
are now fixed and tested.

## Review history

| Reviewer | Role | Findings | Status |
|----------|------|----------|--------|
| Sauron | correctness | 2 crit, 3 warn, 4 note | fixed / deferred |
| Aragorn | security | 2 crit, 1 warn, 5 note | fixed / signed-off |
| Frodo | UX | 2 crit, 5 warn, 3 note | fixed / deferred |
| Legolas | perf/leaks | 1 crit, 1 warn, 2 note | fixed / deferred |
| Gandalf | architecture | 0 crit, 3 warn, 4 note | fixed / deferred |
| Ents | tests | 1 crit, 8 warn, 2 note | covered |
| Uruk-Hai | bug hunt | 1 crit | fixed |

## Fixed (with commit)

**Supervisor** (`fix(review): address LOTC supervisor findings`):
- **CRIT** stderr PIPE never drained → deadlock (Legolas/Sauron): added a stderr
  drain thread → bounded ring buffer.
- **CRIT** session_id lost on slow init → wake spawns fresh session, memory lost
  (Sauron): reader thread persists session_id the instant it's captured.
- **CRIT** non-dict JSON crashed the reader thread (Uruk-Hai): skip non-dict.
- **WARN** concurrent lifecycle races (Sauron): per-agent lock; errored spawn
  drops the dead handle; `pid` None unless alive; no-op ops return False;
  `reconcile()` reaps out-of-band-dead agents.
- **NOTE** log a warning when `$TRIO_AGENT_CMD` override is active (Gandalf).

**Web authorization** (`fix(review): channel authorization + validation`):
- **CRIT** cross-channel browse + orphan-row injection (Aragorn/Sauron): new
  `_authorize_channel()` gate on every channel-scoped endpoint — 404s a
  non-existent channel (closing phantom-channel writes) and confines a
  non-operator identity to the default channel. Multi-channel is an operator
  console.
- **CRIT** `/api/channels` leaked DM previews (Aragorn): now operator-only.
- **WARN** `channel_exists(db_path)` reads the same DB as the handlers (Gandalf);
  per-request `_resolved_channel` cache reset each request (Gandalf/Sauron).

**Web UX** (`fix(review): multi-channel client UX`):
- **CRIT** DM open + DM back-button lost `?channel=` → wrong channel (Frodo).
- **WARN** no-channel empty state (no more infinite "reconnecting…"); switch
  confirms before discarding an in-progress compose; picker hides in DM /
  single-channel / ≤1-channel / failure; themed CSS.

**Tests** (`test(review): cover multi-channel web + apiUrl`):
- `test-web-channels.py` (11 checks): real `?channel=` path, isolation, bogus →
  404 + no orphan rows, guest confinement.
- `apiUrl` JS unit tests (misrouting guard). `test-supervisor` +14 (errored
  spawn, concurrent dedup, feed-to-dead + reconcile, wake-no-session, real
  shutdown, non-dict robustness).

**Final suite:** 9 Python + 2 JS suites green, 0 failures.

## Deferred (with rationale)

- **FK enforcement** — no `PRAGMA foreign_keys=ON`; FKs advisory. Enabling
  globally on the existing DB is risky; integrity is app-enforced. Documented.
- **`_handle_channels` N+1 preview query** — negligible at tens of channels;
  window-function collapse only worth it if channel counts grow (Legolas).
- **Per-channel runtime idle-eviction** (Legolas WARN) — hubs/watchdogs accumulate
  per distinct channel visited. `reconcile()` handles dead agents; a hub
  idle-reaper is deferred to the hub-wiring increment (needs subscriber-count
  tracking, which lands with the supervisor↔hub wiring).
- **DB-path single-source** (Gandalf) — partially addressed (`channel_exists`
  takes db_path); full `_DB_PATH_GLOBAL`/`db_path` collapse deferred to avoid
  destabilizing old tests that set the class attr.
- **`wake_and_feed` contract + argv validation** (Gandalf/Aragorn) — belong to
  the supervisor↔hub wiring (Phase 2 next), where model/`mcp_config` reach argv.
- **Keyboard picker browsing, channel-shown-twice, unified cross-channel DM
  inbox** (Frodo) — Phase 1 UI polish.

## Sign-offs

- **Operator-console blast radius** (Aragorn note): a trusted operator now has
  cull/filter over every channel from one process (was per-channel). Intended
  for the single-user local console; team/remote scoping is the `agents.owner`
  column, enforced later.

---

# LOTC Review 2 — hub-wiring delta (2026-08-01)

**Scope:** `git diff cc29444..HEAD` — agent control-plane, identity reclaim,
AgentRouter, spawn/roster UI, MCP wiring. **Reviewers:** Sauron, Aragorn,
Legolas, Ents, Uruk-Hai.

| Reviewer | Findings | Status |
|----------|----------|--------|
| Aragorn (security) | 1 crit, 1 note, 3 clean | fixed / deferred |
| Sauron (correctness) | 1 crit, 3 warn, 4 note | fixed / deferred |
| Legolas (perf) | 1 crit, 2 warn, 5 note | fixed / deferred |
| Ents (tests) | 2 crit (reproduced), 5 warn, 5 note | fixed / covered |
| Uruk-Hai (bugs) | 2 crit (input validation) | fixed |

## Fixed
- **CRIT reclaim identity hijack (Aragorn):** `resume_member_id` had zero auth —
  an MCP caller could read the operator's member_id off the roster and reclaim
  it (mint a valid token, read their DMs). Now reclaim is restricted to
  `kind='agent'` rows; human/operator rows are refused.
- **CRIT wake deaf-mutes agents (Sauron/Ents, reproduced):** a woken agent lost
  its MCP tools + reclaim preamble. `wake_agent()` rebuilds both.
- **CRIT router head-of-line stall (Legolas):** inline wake blocked the poll
  thread ~10s. Wake+feed moved to a worker queue; one long-lived connection.
- **CRIT capacity blocks reclaim (Sauron/Ents, reproduced):** MAX_MEMBERS counted
  the reclaimer's own row. Skipped for a reclaim of an existing own row.
- **CRIT input validation (Uruk-Hai):** non-list `channels` crashed
  `_handle_agent_create`. Validated; inserts now transactional; spawn-fail marks
  the row errored.
- **WARN routing membership scope (Sauron/Ents):** an agent mentioned in a
  channel it isn't placed in is no longer fed; messages enqueued not dropped.

Tests added: reclaim auth + capacity; router membership-scope + wake-path +
wake-keeps-mcp; web-agents channels-validation + abandoned + wake-endpoint.
Final sweep: 12 suites green.

## Deferred (noted)
- Agent-vs-agent live-session reclaim guard (conflicts with wake; wants a
  hub-minted reclaim secret) — kind guard covers the high-value operator case.
- Bash left enabled for spawned agents (operator-spawned + local; documented).
- Runtime idle-eviction; `_agent_locks`/`_RUNTIMES` never pruned; `_handle_agents_list`
  N+1 (panel-open only); reclaim name/last_read reconciliation; concurrent-reclaim
  cosmetic `[joined]`; router backpressure gauge; a few pure-function unit tests.
