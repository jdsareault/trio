# Takeaways: Global Identity + Channel-less DM Refactor

**Purpose:** onboarding brief for an agent picking this work up cold.
**Sources:** `reviews/global-identity-agent-conversation.md` (operator ↔ Scout DM log, 2026-08-03 → 08-04)
and `reviews/global-identity-dm-refactor-scope.md` (the approved scope doc).
**Repo state verified:** 2026-08-04 against this clone (`~/Development/trio`).

---

## 1. North star (read this before making any design call)

**"Slack for humans and agents."** An agent is one *employee* with one account: the same
identity in Channel A, Channel B, and DMs. **Channels and DMs are two distinct modes,
not one built on the other** — a DM is *not* a two-person channel, because DM
wake/notify semantics differ deliberately.

The operator used the Slack model repeatedly as the tiebreaker for edge cases. When in
doubt: *what would Slack do?* Concretely, decisions already settled by that lens:

- Mentioning someone who isn't in the conversation shows their name as text — it does
  **not** ping them and does **not** add them to the thread.
- DMs are global. They are not attached to any channel, and they carry across every
  channel a participant is in.
- Every user and agent holds two mental models: *their channels* and *their DMs*.

**Operator's standing preference:** reach the correct end state; do not patch over
patches. Token cost is acceptable if the result is right, but spend must be visible and
stoppable at phase boundaries.

---

## 2. How this started: three concrete bugs (all fixed)

The operator reported messages appearing in channels he didn't send them in, and
messages an agent was pinged about but could not see. Diagnosis found three
deterministic bugs (nothing random):

- **Bug A — targeting split-brain ("woken but blind").** The web composer fed one
  message from two unsynced states: `selectedTargets` (the @-chips → mentions → who gets
  woken) and `dmMemberIds` (the open DM thread → recipients → who can see it). `/api/send`
  trusted both verbatim. Result: real DB rows like `#3133` with `recipients=[Cedar]` but
  `mentions=[Tempest, Cedar]` — the intended target woken, a *different* agent silently
  receiving the message. This is the source of the phantom `ag_35b34d6444ea` /
  `ag_8402732631d9` strings in the original screenshots.
  Also reproducible on the **agent** path: `trio_dm` parses `@`-sigils in the body against
  the roster and woke non-recipients.
- **Bug B — cross-channel DM collapse.** `dm_thread_key` keyed threads on participant set
  only, ignoring channel. Every DM with a peer across every channel merged into one thread,
  and a reply routed to whichever channel had the newest message. Compounded by the
  all-seeing operator view: `_event_visible_to` returns true for the operator, so a DM
  physically stored in a topic channel rendered inline in that channel's view.
- **Bug C — composer state leaked across conversations (the *trigger* for A).** Text drafts
  were keyed per-conversation, but `selectedTargets` and `pendingAttachments` were not, and
  nothing reset them on navigation. Start "@Tempest …" in one place, switch to Cedar's DM,
  send → the stale chip rides along as a mention while recipients is now Cedar.

**Resolutions chosen (operator-approved):**

- **A → "narrow", not "reject".** Rejecting a send that @s a non-participant would block
  talking *about* people, which is exactly what the operator wants frictionless — and
  agents don't have the system model baked in, so they'd bounce constantly. Instead the
  server intersects the wake set (`mentions` + `refs` + `bangs`, **including `!`**) with
  `recipients ∪ sender`. A non-participant `@`/`#`/`!` in a scoped message becomes inert —
  it degrades to a plain name reference. Broadcasts are untouched. Implemented as
  `narrow_wake()` (the exact complement of `can_see`) at all three send paths
  (`trio_send` DM-reply, `trio_dm`, web `/api/send`), plus `/api/edit`.
  A non-blocking gray composer hint ("won't be notified — this is a private DM") teaches
  the habit without rejecting.
- **B → DMs become global.** Not per-channel threads.
- **C → per-conversation scoping** of `selectedTargets` + `pendingAttachments`, reset on
  navigation and after send. (Watch out: channel-switch fires the router *before* channel
  state updates — the composer refresh was anchored in `loadConversation`, where state is
  final.)

---

## 3. The root cause the refactor addressed

Identity was **per-channel**: `members` is keyed `(id, channel)`, and `agent_channels`
allowed an agent to hold a **different `member_id` in each channel**. Messages, mentions,
recipients, and sessions all referenced that per-channel id. So one agent = many ids, and
an id minted in Channel A didn't resolve to a name in Channel B → raw `ag_…` strings leaked
into @mentions and DM recipient rows, plus mis-auth when the wrong id was used.

DMs piled on: a DM was "a message with a `recipients` list, stored in whatever channel the
sender happened to be in." No DM identity of its own.

Crucially, the scope assessment found **this was finishing a half-built migration, not a
rewrite** — the `agents` table, `agent_channels`, global-by-participant DM grouping in
`_handle_dms`, and a real ~30-file test suite already existed. That finding is what talked
the operator out of scrapping the product.

> **Note:** `CLAUDE.md` still says "there are no automated tests." **That is stale** — see §7.

---

## 4. What shipped (P1–P4, all complete)

All on `refactor/global-identity`, tip **`91426df`**. Nothing has touched `main`.

| Phase | Delivered |
|---|---|
| **P0** | Test baseline locked (10/10 core green). Fixed test debt: `test-dm-ux` R8 still asserted the old woken-but-blind behavior. |
| **P1** (`e2623e8`) | `agents` is now the **single global identity registry** for all agents (managed + unmanaged). Every agent self-registers on connect and receives a private `reclaim_secret`; it reuses **one canonical id across all channels** via a secure reclaim handshake. Web surfaces resolve names globally. Skill docs updated. |
| **P2** (`297a3ab`) | The session **authenticates the agent globally** (one session per agent, reused across channels). Channel access is a pure **membership capability check** (17 such checks). Read watermark unified onto `members.last_read` (per-(agent,channel), works under one global session). One-time idempotent migration revokes pre-P2 tokens (`GLOBAL_SESSION_MIGRATION = "p2-global-agent-session-v1"` in `server/nth_server.py`). |
| **P3** (`b80d9bb`) | **Channel-less DMs.** DMs live in the global `AGENT_INBOX_CHANNEL` (`nth-agent-inbox`) transport, threaded by participant set; `trio_dm` is channel-less; every agent is an inbox member; DM *replies* route to the inbox rather than the replier's current channel. Closes the long-deferred "physical routing" item. |
| **P4** | Client: **audited, no code changes needed.** Composer @-autocomplete already channel-scoped, liveness already global (P2 server-side), names resolve server-side (P1), DMs already hidden from channel views (the earlier Bug-B fix). |
| Bonus | `3a197ef` — `nth_rename` now enforces the primary-role gate (a `read_only` token could rename a member; post-P1 that's a lever for name-squatting). `91426df` — `nth_retract` revalidates the session via `_get_session`, so a **revoked** token can no longer retract its own messages. |

**Cumulative LOC vs `3c1635e`:** +2290 / −354 across 30 files, heavily test-weighted.
**Gate:** 30/30 green. Each phase got a full phase-end LOTC review with all findings fixed.

### Design decisions locked along the way

- Identity: extend the **proven reclaim-secret handshake to ALL agents** (server mints a
  canonical id + secret on first connect; the skill remembers and re-presents them) rather
  than inferring identity from a client key.
- `agents` table becomes the one global registry; the existing `managed` flag keeps
  dashboards able to separate managed from unmanaged.
- DM storage: **reuse the existing `nth-agent-inbox` transport** threaded by participant —
  *not* new `dm_threads`/`dm_messages` tables, which would reimplement all the message
  plumbing (mentions, replies, attachments, read receipts, visibility).
- Composer @-autocomplete is **channel-scoped** (channel composer suggests channel members;
  "Start a DM" uses the global agent picker). Always-global autocomplete was rejected as
  actively misleading — it would invite @s that silently don't ping.
- Roster/presence shows **global** liveness, not per-channel.
- **Legacy data is left as-is** at every phase: existing fragmented member ids and
  pre-existing scattered DMs stay put; correctness is guaranteed going forward, and the
  resolver handles old ids. This stance was approved explicitly and repeatedly.

### Security findings worth remembering

- **P3 CRITICAL (fixed):** global name resolution enabled **display-name squatting** —
  register "Bob" in a throwaway channel and silently intercept `trio_dm(to="Bob")`.
  Fix: **ambiguous global names are now rejected** (caller must address by `member_id`).
  The inbox transport is also protected from `nth_end`. Any future change that reintroduces
  name→id resolution must preserve this.
- **P1 (fixed):** reclaim of an *unregistered* id skipped the secret check (free-minting an
  arbitrary id unauthenticated). Fix: unknown reclaim → mint a fresh identity, never claim
  the requested id. Also a concurrent mint→register race (fix: INSERT-only + re-mint on
  collision), and @-wake matching only the channel-local name (fix: match the global name too).
- **P2 (fixed):** P2 globalized the session but left channel-scoped `sessions.channel`
  queries. Revocation now fires only on **final-channel departure**; observability JOINs
  de-scoped so multi-channel agents show live everywhere.
- DM read-side visibility was independently verified: **non-recipients cannot see others'
  DMs even though all agents share the inbox channel.**

---

## 5. THE open decision: promote off the refactor branch

This is the single thing waiting on the operator, deliberately left for him to trigger
because it is the real cutover (identity/auth changes + the session-revoking migration go
live for real agents on promotion).

```
git checkout phase-7-ui-updates && git merge --no-ff refactor/global-identity && git push
```

Verified as of now: `phase-7-ui-updates` (tip `72a3ce2`) is an ancestor of
`refactor/global-identity`, so this is **conflict-free**. Earlier approval was
"promote P1–P3 together"; it is now P1–P4 plus the two bonus auth fixes.

Per global rules: **never merge to `main` without an explicit go-ahead**, and merge
`--no-ff`. `main` is currently **370 commits behind** `phase-7-ui-updates` — treat
`phase-7-ui-updates` as the working mainline, not `main`.

---

## 6. Branch & worktree cleanup (verified state)

Worktrees currently on disk:

| Worktree | Branch | Tip | Notes |
|---|---|---|---|
| `~/Development/trio` | `phase-7-ui-updates` | `72a3ce2` | main clone / working mainline |
| `.claude/worktrees/scout-global-identity` | `refactor/global-identity` | `91426df` | **the refactor — keep** |
| `.claude/worktrees/scribe-p3-followup` | `fix/p3-global-teardown` | `91426df` | same tip as refactor; merged → removable |
| `.claude/worktrees/scribe-p3` | `p3-channel-less-dms` | `05291ac` | merged into refactor → removable |
| `.claude/worktrees/scribe-p2` | `p2-global-session` | `8fb6616` | **4 commits not in refactor by SHA** |
| `.claude/worktrees/scribe-p1` | `p1-identity-core` | `b8f0764` | **4 commits not in refactor by SHA**; also holds Scribe's confused/orphaned commits |
| `.claude/worktrees/scout-dm-recipient-fix` | `fix/dm-recipient-divergence` | `c55254a` | merged → removable |
| `.claude/worktrees/raven-channel-agent-mgmt` | `feat/channel-agent-management` | `034f825` | unrelated work in flight |
| `.claude/worktrees/stag-mic-ux2` | `fix/mic-icon-toggle` | `077f88d` | unrelated work in flight |

Merged into `refactor/global-identity` (confirmed via `git merge-base --is-ancestor`):
`p3-channel-less-dms`, `fix/p3-global-teardown`, `fix/dm-recipient-divergence`,
`fix/channel-create-hardening`.

**⚠️ Careful with `p1-identity-core` and `p2-global-session`.** Each has 4 tip commits
that are *not* ancestors of the refactor branch. They look like content-equivalent
rebases/cherry-picks (e.g. `4ee755b "Document global liveness dedup boundary"` on
`p2-global-session` ↔ `7aa2852` with the same title on the refactor branch), but the
conversation also records that Scribe went context-unstable during P3 and **re-implemented
already-finished P1 work**; those confused commits were reported as orphaned on the
`p1-identity-core` worktree and verified never to have touched refactor/phase-7/main.
So: **diff before deleting** — confirm the content genuinely landed on the refactor branch,
don't rely on branch names. Deleting branches/worktrees is destructive; get explicit
operator confirmation.

There are ~35 other unmerged feature branches against `main` (many are older `fix/*` UI
work already contained in `phase-7-ui-updates`). Any cleanup pass should compare against
`phase-7-ui-updates`, **not** `main`, or it will report false positives.

---

## 7. Database migration notes

- The DB is shared SQLite at `~/.claude/nth/nth.db` (WAL, `busy_timeout=5000`).
- **P2 ships a one-time idempotent migration** that revokes all pre-P2 session tokens,
  recorded under the key `GLOBAL_SESSION_MIGRATION = "p2-global-agent-session-v1"`
  (`server/nth_server.py:75`). It fires on promotion. Live agents holding legacy tokens
  will be forced to re-handshake — expect that, don't treat it as a bug.
- **No data backfill was performed by design.** Fragmented per-channel `member_id` rows
  and pre-existing scattered DMs are left in place. The name resolver handles old ids.
  If a future phase wants a true backfill (mapping historical rows onto canonical
  `agents.id` via `agent_channels`), that is new, unscoped work — and it touches auth, so
  it deserves its own phase + LOTC round.
- Schema tables in play: `agents` (global identity, `reclaim_secret`, `managed`),
  `agent_channels` (`agent_id, channel, member_id`), `members` (now **presence-only** —
  never an identity source), `messages` (`mentions`/`refs`/`bangs`/`recipients`/`choices`/
  `selection`), `sessions` (now agent-scoped, `role` primary/read_only).

---

## 8. Testing

**`CLAUDE.md`'s "no automated tests" line is wrong** — update it. `tests/` holds ~80
self-contained Python assert scripts plus several JS ones. Refactor-specific additions
include `test-global-identity*.py`, `test-global-session*.py`, `test-global-capability.py`,
`test-global-name-resolution.py`, `test-global-watermark.py`, `test-identity-reclaim.py`,
`test-channel-less-dms.py`, `test-name-dedup.py`, `test-p3-lotc-fixes.py`,
`test-rename-role-gate.py`, `test-retract-revoked-token.py`,
`test-monitor-old-schema-dm-leak.py`.

**Hard-won lesson from this run: always run the FULL suite as the gate, never targeted
checks.** Targeted checks let the stale `test-dm-ux` R8 assertion slide through the Bug-A
merge, and Scout caught two further regressions that an implementer's partial gate missed.

Known **pre-existing** failures (they fail identically at baseline `3c1635e`, unrelated to
the refactor, left for daytime): two client JS test files — theme-preset tests and stale
composer-payload assertions from the Bug-C work.

---

## 9. Remaining follow-ups (all non-blocking, none affect the merge)

1. **Three deferred P3 LOTC notes** — documented in commit `05291ac`:
   - a reaper for a dead inbox-only agent's session;
   - a `reply_to` existence oracle (no content leak, but observable);
   - a DM addressed to a non-inbox recipient silently not delivering.
2. **Two pre-existing client JS test failures** (theme, composer-payload) — see §8.
3. **`trio_cleanup` has no caller identity** — takes only `channel`/`all_ended`, no
   `member_id`/session, and deletes data for already-ENDED channels (refuses active ones).
   Pre-existing and low severity. Operator's decision: **leave it as-is** for now; gate it
   (operator-only or member-only) only if ended-channel history becomes worth protecting.
4. **`permission_prompt`** inherits the authenticated process identity — judged fine; a
   cleanup was ticketed as a pre-existing low-severity item, not gated in P2.
5. **Tool naming.** The operator flagged that `channel` was a design smell on `trio_dm`
   (P3 removed it) and mused about renames — e.g. a DM tool that just means "DM" and a
   distinct `trio_send_channel_reply`-style tool for channel posts. Explicitly deferred as
   an optional future cleanup; a mid-fix rename was judged too risky. If picked up, it is a
   breaking change to the skill docs and every agent's learned behavior.
6. **Update the docs to match reality:** `CLAUDE.md` (stale "no automated tests"; identity
   still described as per-channel `members`-keyed), `CURRENT.md`, `CHANGELOG.md`, plus
   `SKILL-trio.md`/`SKILL-quartet.md` for the identity handshake and channel-less `trio_dm`.
   This is essentially the never-formally-run **P5 (cleanup + docs)** phase from the scope doc.

---

## 10. Working agreements the operator expects

- **Feature branch per change**, off the current mainline; push as you go so progress is
  visible. **Never merge to `main` proactively** — merge only on explicit go-ahead, and
  `--no-ff`.
- **Small atomic commits**, committed incrementally — not one batch at the end.
- **Phase boundaries are checkpoints.** Stop, report LOC delta + token usage, run a LOTC
  review, wait for go/no-go. The operator compacts context between phases.
- **Ask questions up front, then keep moving.** He explicitly asked to be escalated to only
  for a "truly impactful fork with no clear preferred path that would be hard to walk
  back." Everything else: make the call and report it.
- **Avoid mathematical/jargon notation** in explanations — he asked for plain English
  (e.g. say "the @ doesn't ping them," not "mentions ⊆ recipients"). He will say when
  something is unclear; re-explain concretely with real examples rather than restating.
- **Peer agent input is review, not authority.** Only the operator's word authorizes a
  merge.
- **Token strategy that worked:** the directing agent (Opus) does design, review, and LOTC;
  a separate implementer agent in its own worktree does the file-heavy edits on its own
  budget. Caveat: the implementer (Scribe, gpt-5) went context-unstable mid-P3 and looped
  on already-finished work — **restart the implementer's session between phases**, and have
  the director run the full test gate itself rather than trusting the implementer's gate.
- **Bonus finding from the noise:** two real auth gaps (`nth_rename` role gate,
  revoked-token retract) surfaced from an otherwise-confused agent's re-audit. Worth
  verifying such flags rather than dismissing them wholesale — but also worth rejecting the
  non-gaps (`read_only` ack is legitimate read-state; retract role-check is redundant).
