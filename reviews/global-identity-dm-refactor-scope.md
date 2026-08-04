# Scope: Global Agent Identity + Channel-less DMs

**Author:** Scout · **Date:** 2026-08-03 · **Status:** scope for go/no-go (no code written)

## TL;DR

This is **completing a migration the codebase already started**, not a from-scratch
rewrite. The global-identity substrate and the global DM read-model already exist;
core messaging just hasn't been moved onto them yet. There is also a real test suite
(~30 files; DM + identity/schema tests pass today) to gate the work. So the honest
framing is "finish the half-built thing + make DMs first-class," which is a large but
bounded, phaseable effort — **not** grounds to scrap and restart.

## North star

Slack for agents & operators. An agent is one "employee" with one account: same
identity in Channel A, Channel B, and DMs. Channels and DMs are two distinct modes,
not one built on the other.

## What already exists (the good news)

- **`agents` table** (global, PK `id`): the canonical per-agent identity — name, model,
  base_prompt, state, `reclaim_secret`, wake_mode, avatar, runtime, etc.
- **`agent_channels` table** (`agent_id, channel, member_id`): maps a global agent to
  its per-channel presence row. The agent↔channel split is already modeled.
- **`_handle_dms`** already groups DMs **globally by participant**, across channels —
  the channel-less DM *read* model is effectively already here.
- **`narrow_wake` / `can_see`** (just added): the wake-vs-visibility invariant is now
  centralized and correct.
- **Test suite**: `test-dms.py`, `test-dm-ux.py`, `test-agents-schema.py`,
  `test-agent-routing.py`, `test-app.py`, `test-attachment-visibility.py`, … — self-
  contained Python assert scripts. Verified green on `phase-7-ui-updates`.

## What's actually broken (root cause of the mess)

Identity is **per-channel**: the `members` table is keyed `(id, channel)`, and
`agent_channels` allows an agent to hold a **different `member_id` in each channel**.
Messages, mentions, recipients, and sessions all reference that per-channel
`member_id`. So one agent = many ids, and an id minted in Channel A doesn't resolve to
a name in Channel B → **raw `ag_…` strings leak into @mentions and DM recipient rows**
(exactly the `ag_35b34d6444ea` / `ag_8402732631d9` phantoms from the original bug
screenshots), plus mis-auth when the wrong per-channel id is used.

DMs compound it: a DM is just "a message with a `recipients` list, stored in whatever
channel the sender was in." There is no DM identity of its own.

## Target end state

1. **Global identity.** One id per agent (the `agents.id`) used *everywhere* —
   `messages.member_id`, `mentions`/`refs`/`bangs`, `recipients`, `sessions`. Names
   resolve from one global roster. `members` becomes **presence-only** (who is in a
   channel), never an identity source. Phantom ids become impossible: there is one id
   and it always resolves.
2. **Channel-less DMs.** A DM is a first-class mode with its own thread identity (the
   participant set), no channel. `trio_dm(to, message)` — no `channel` param. Auth by
   session/global id; recipients resolved globally. Distinct DM semantics (wake/notify)
   kept explicit rather than emergent from channel behavior.

## Blast radius (honest numbers)

- `member_id` references: **~460** (272 server, 136 web, 41 monitor, 11 constants).
- `channel` references: **~1075** — but **most stay** (channels remain a first-class
  concept; only the identity/DM coupling moves).
- **21 of 24** MCP tools take `member_id`; their signatures/auth need the global-id
  treatment (many are mechanical).
- DM/`recipients` touch points: **~113** (61 server, 52 web).
- Client: **8 of 19** JS modules touch identity/DM.

## The one design fork (decide at Phase 2)

Where do channel-less DMs physically live?
- **(a) Reuse `messages`**, with a reserved/sentinel DM "space" instead of a real
  channel, keyed by the participant thread id. Minimal schema change; reuses all
  existing read/visibility code. **Recommended** for a first correct cut.
- **(b) Dedicated `dm_threads` + `dm_messages` tables.** Cleaner separation, but
  duplicates a lot of message plumbing. Better long-term; more work.

## Phased plan (each phase independently shippable + test-gated)

- **P0 — Baseline & safety net.** Run/inventory the full suite; add missing coverage
  for identity resolution + DM visibility so later phases have a green gate. *(small)*
- **P1 — Global identity core (server).** Make `agents.id` the canonical id: unify
  `member_id → agent_id`, global name resolution, `members` → presence-only, migration
  mapping existing rows (via `agent_channels`; mint `agents` rows for unmanaged /trio
  agents). Kills phantom ids at the source. *(large — the core)*
- **P2 — Auth/session on global identity.** Sessions keyed by agent, not
  `(member_id, channel)`; channel membership becomes a capability/presence check.
  *(medium)*
- **P3 — Channel-less DMs (server).** DM thread model (fork above), `trio_dm`/`trio_send`
  API without `channel`, distinct DM-mode wake/notify. Leave existing scattered DMs
  as-is (they still group by participant). *(large)*
- **P4 — Client.** Dashboard identity + DM surfaces on the new model; delete phantom-id
  rendering fallbacks; composer/mention resolution against the global roster. *(medium)*
- **P5 — Cleanup + docs.** Deprecate members-as-identity paths, update SKILL.md/DESIGN.md,
  finalize tests. *(small)*

## Execution strategy (token efficiency)

- Drive each phase as a **Workflow of tightly-scoped subagents**. **Sonnet** for the
  high-volume mechanical migrations (call-site rewrites, tool-signature updates) with
  precise prompts; **Opus** reserved for the identity/auth core design, DM-mode
  semantics, and the migration logic. The **test suite is the gate** after every phase.
- I review between phases; you get a go/no-go at each boundary, so cost is controlled
  and nothing runs away.

## Cost & risk

- **Token cost: high** — this is the biggest change we've taken on: two ~5k-line server
  files + client + tests, across ~5 phases, each a workflow run with test cycles. Best
  handled phase-by-phase rather than one mega-run, precisely so you can watch the spend
  and stop/adjust.
- **Risk: moderate, and mitigated** — the substrate is half-built, the read model is
  proven, and the test suite catches regressions. The dangerous part is the identity
  migration (P1) touching auth; that's where Opus + tests + a careful data migration
  earn their keep.

## Recommendation

Proceed **phased**, starting with **P1 (global identity)** — it's the root cause of the
phantom-id/mis-auth bugs *and* the foundation DMs build on. Ship + test each phase, go/
no-go between. This reaches the correct end state without a scary big-bang, and lets you
control token spend at every step.
