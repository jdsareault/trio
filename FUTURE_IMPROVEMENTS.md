# Future Improvements

Feature ideas for trio's human-facing dashboard, captured for later. Each is
grounded in what already exists in the codebase so the "what's new" is scoped
honestly. Nothing here is committed to a milestone yet.

---

## 1. Tool-use activity indicator

**What:** Show in the dashboard that an agent is *actively using tools* right
now, with a streamlined collapsed indicator that a human can expand to see the
specific calls. Keeps trio's interface clean by default but lets you drill in.

**Substrate that already exists:**
- `nth_activity_hook.py` is registered as a matcher-less `PreToolUse` hook, so
  it already fires on *every* tool call in every session. Today it discards
  everything except the timestamp — one `UPDATE sessions SET last_seen`.
- `member_status()` in `nth_web.py` already computes a `working` state (session
  acted since its last turn-end) and the roster already renders a dot for it.

**What's new:**
- Extend the activity hook to also record `tool_name` + a short target (file
  basename, command head). Store either a `last_tool` column on `sessions` or a
  small **capped** `tool_events` table for the expandable list.
- Collapsed chip on the roster row (e.g. `🔧 running Bash`); expand → recent
  call list.
- New read endpoint for the expanded detail.

**Design constraints (don't regress the hook):**
- The hook is on the critical path of every tool call and is engineered to be
  dead-cheap (500 ms busy timeout, single write, fail-fast, never raises). Keep
  that discipline — a one-column UPDATE is fine; an unbounded append table is
  not, so cap/prune it.
- Store a **summary, not raw `tool_input`** — inputs carry file contents,
  command lines, secrets. Better for privacy and keeps rows small.
- `PreToolUse` fires at tool *start* only → shows "running", not duration. Add a
  `PostToolUse` hook if completion/duration is wanted.

**Open question:**
- **Quartet (cross-machine):** the hook writes the *local* `nth.db`, but remote
  quartet sessions talk to the *hub's* db over SSE. Verify whether remote
  tool-activity ever reaches the hub, or if this signal is effectively
  trio-only. (The existing "working" dot likely shares this limitation.)

**Consider bundling with #6** (blocked/awaiting-input state): it reuses this
exact tool-name capture, so building the two together avoids opening the
activity hook twice.

---

## 2. Sub-agent visibility (extension of #1)

**What:** Surface sub-agents a session spins up — collapsed
`🔧 using tools · 2 sub-agents`, expandable to each sub-agent by type +
description with a running/done state.

**Substrate / hook points:**
- **Spawn is already a tool call:** the `Task`/`Agent` tool fires the same
  `PreToolUse` hook. `tool_name` is `Task`; `tool_input` carries
  `subagent_type`, `description`, and the prompt. So the spawn is already in the
  stream #1 captures.
- **Completion:** Claude Code fires a dedicated `SubagentStop` hook when a
  sub-agent finishes. Bracket = `PreToolUse(Task)` spawned → `SubagentStop`
  done.

**Open question (gates a deeper view):**
- Sub-agents run their own tool loop; those inner calls also fire `PreToolUse`.
  Whether they carry the **parent's** `session_id` or a **distinct** one decides
  (a) whether inner activity is attributable to the parent and (b) whether a
  nested parent→children tree view is even possible. May vary by Claude Code
  version — verify empirically (debug-log `event`/`session_id`/`tool_name` in
  the hook, spawn a sub-agent, read what appears).

---

## 3. In-chat image gallery (agent → human)

**What:** A human-facing gallery to browse images an *agent* links to during its
work (screenshots, plots, referenced images). This is the **reverse** of the
existing attachment flow — that one is human → agent (a person uploads via the
browser and the bytes are delivered to the agent as MCP `Image` blocks on poll).

**Substrate that already exists (the viewing half, reusable as-is):**
- `attachments` table: `channel, message_id, member_id, mime, filename, width,
  height, bytes, path, created_at` — stores a local file path plus the exact
  metadata a gallery grid wants (dims, size, uploader, timestamp).
- `/api/attachment/<id>` serves the bytes.
- Client already renders inline thumbnails (`.msg-img`, lazy-loaded,
  click-to-open-full).

**What's new:**

1. **Agent-side ingestion tool (the crux — doesn't exist today).** Attachments
   are currently created *only* by web upload; an agent has no tool to register
   an image. Add a `path`/`image` arg to `trio_send` or a `trio_attach` tool.
   Safety shape (reuses existing helpers):
   - `sniff_image_mime()` on the bytes (magic bytes, not extension) — exists.
   - Enforce `MAX_UPLOAD_BYTES` — exists.
   - **Copy** bytes into `~/.claude/nth/attachments` at ingest; don't serve a
     live arbitrary path (path-traversal / arbitrary-file-read surface, and a
     later edit/delete of the agent's temp file would change what's served).

2. **Gallery view (new UI, additive read).**
   - Query: `SELECT … FROM attachments WHERE channel = ? ORDER BY created_at
     DESC` — no schema change for v1.
   - Grid + lightbox, decoupled from the message stream, with attribution (which
     agent, which message) and jump-to-message (`member_id` / `message_id`
     already present).
   - New `/api/gallery?channel=…` endpoint; grid lazy-loads via the existing
     attachment endpoint.

**Local vs. external images:**
- **Local paths (primary):** agent produced a screenshot/plot — ingest = copy
  the file into the store. Clean, hermetic, no link rot.
- **External URLs:** prefer *fetch-and-localize on ingest* (same sniff + cap,
  store bytes locally) over storing a bare URL. Keeps one hermetic model,
  survives link rot, and the viewer's browser never hits a third party. Needs an
  **SSRF guard** at fetch time (block localhost / RFC-1918 / link-local). Keep
  bare-URL render only as an explicit opt-in for throwaway links.

**Perf lever to decide early:**
- There's **no server-side image library** today (no PIL/Pillow) — `width`/
  `height` are populated client-side from the browser's `img.onload`. A gallery
  grid of many agent images would download every full-res file (up to 10 MB) to
  show a thumbnail. Either add Pillow to generate thumbnails (`?w=240` on the
  serve endpoint) or accept lazy-loaded full-res tiles for v1. Lean toward
  thumbnails if an agent might link dozens of images.

---

## 4. Operator-adjustable wake filter (from the dashboard)

**What:** Let the operator change any agent's wake filter (`all` / `about` /
`at`) on the fly from the agent detail dropdown in the web dashboard — no agent
restart, no editing launch flags. Today the filter is chosen only by the agent
itself, as a launch-time `--filter` arg on its `nth_monitor.py` process.

**Substrate that already exists:**
- `members.filter_mode` is already a per-member column (v7.2+). It's just used
  backwards for this goal: the monitor *writes* its launch-time `--filter` arg
  into the column each tick (a reporting mirror so the roster can show it),
  rather than reading behavior from it.
- `should_wake()` in `nth_monitor.py` is already a pure function of
  `filter_mode` — no per-message state to migrate.

**What's new:**
- **Flip the monitor to READ `members.filter_mode` from the DB each tick**
  instead of writing its static launch arg. The launch flag becomes only the
  initial seed (used when the column is null). This makes the DB the **single
  source of truth**, so operator and agent aren't fighting two mechanisms.
- New endpoint (e.g. `POST /api/member/<id>/filter`) doing one
  `UPDATE members SET filter_mode = ?`.
- A dropdown in the agent detail panel posting to it.

**Why it's low-risk:**
- The monitor already touches the DB every tick, so reading one more column is
  cheap; the change is picked up on the **next tick** (no restart).
- Unknown/invalid modes already *fail open* (wake on everything), so a bad write
  can't silently mute an agent.
- Precedence rule: DB value wins once set; `--filter` only seeds a null column.

---

## 5. Two-axis filtering — separate "wakes on" from "can see" (FOR CONSIDERATION)

**Status:** Exploratory — kept on the list for consideration, **not decided**.
Materially larger than #4 and it shifts trio's transparency model, so it wants a
deliberate yes/no rather than a near-term build. Depends on #4 (which delivers
the "wakes on" half).

**What:** Give each member two independent settings — **"wakes on"**
(notification) and **"can see"** (readability) — as two dropdowns in the agent
detail panel. Today there is no "can see" axis at all: `trio_poll` is
`SELECT … WHERE channel=? AND id>?` with no per-member visibility predicate, so
every member reads everything.

**The elegant design (reuse one predicate for both axes):**
- `should_wake()` already classifies each message per member
  (ambient / pound / at / bang). Apply that **same predicate at read time**
  (poll / history / pounds / SSE), not just at wake time in the monitor. Result:
  two independent knobs sharing one engine.
- e.g. *wakes on: `at`, can see: `about`* → interrupted only by `@pings`, but on
  poll it reads everything about it (incl. `#pounds`) and not unrelated
  cross-talk. Both default to `all` → today's behavior, unchanged.

**Costs / open questions (why it's not a tweak):**
- **Every read path must become member-aware:** `trio_poll`, `trio_history`,
  `trio_pounds`, the SSE feed, **and** the conversation export. Miss one and
  "can see" leaks.
- **Watermark handling:** hidden messages must be *advanced past* without being
  *returned*, or they sit unread forever / reappear. The `mentions_only` path
  already wrestles with this tension — the pattern exists but needs care for a
  stored per-member filter.
- **Philosophical decision required:** the operator stays all-seeing
  (superuser) while agents get scoped views. Coherent, but a real shift from
  trio's "one transparent broadcast room" model + audit export. Choose on
  purpose.
- **Soft scoping, not security:** all agents share one SQLite DB, so "can see"
  governs what the *server hands each member* at delivery time, not
  cryptographic isolation. Don't present it as a trust boundary.

---

## 6. "Blocked / awaiting input" indicator state (bundle with #1)

**What:** A distinct dashboard state — `blocked` (awaiting user input) — shown
when an agent is frozen on a host-native interactive prompt (`AskUserQuestion`,
`ExitPlanMode`) or a permission gate. Render it **loudly** — red pulse + an
optional audio beep — because a blocked host prompt silently stalls the whole
room.

**Why the current indicator can't show it:** the "working" dot keys on
`last_seen` freshness. `PreToolUse` bumps `last_seen` when the prompt starts →
**green**; then no further tools run → `last_seen` goes stale → flips to
**idle**. Neither green nor idle means "waiting on you." It needs an explicit
third state.

**Substrate / detection:**
- The `PreToolUse` → `PostToolUse` bracket *is* the blocked window: `PreToolUse`
  fires as `AskUserQuestion` / `ExitPlanMode` starts blocking; `PostToolUse`
  fires only after the user answers.
- `PreToolUse` already flows through `nth_activity_hook.py` — just start reading
  `tool_name` (same capture as #1).

**What's new:**
- Extend the activity hook: on `PreToolUse` where `tool_name` is an
  interactive-blocking tool (`AskUserQuestion`, `ExitPlanMode`), mark the member
  `blocked`.
- **Add a `PostToolUse` hook** (none exists today) to clear the flag when the
  answer lands. Stop/StopFailure + staleness are backstops if the session dies
  while still blocked and `PostToolUse` never fires.
- Optionally wire the **`Notification` hook** to also catch permission-gate
  blocking (Claude Code's dedicated "needs attention" event).
- New render state in `member_status()` + a red/pulse style; audio beep on the
  transition *into* `blocked` (trivial in the web dashboard).

**Open question:**
- Confirm whether `AskUserQuestion` specifically trips the `Notification` hook —
  it varies by Claude Code version. The PreToolUse/PostToolUse bracket does
  **not** depend on it (that's the reliable path); `Notification` is additive
  for permission gates. Verify its payload against current docs before relying
  on it.

**Design note:** trio already discourages agents from using host-native blocking
prompts when a human is in the channel (ask via `@operator` through `trio_send`
instead). So this state doubles as a **detector for an agent that ignored that
guidance and is now silently blocking the room** — which is the argument for
making it loud.

---

## 7. Mention-scoped chime (audio)

**What:** Let the operator set the dashboard chime to sound **only when a
message `@mentions` them**, rather than on every new message. Options:
off / `@mentions` only / any message.

**Substrate that already exists (most of it):**
- The client already has a chime (`btn-sound` / `soundEnabled` /
  `chimeVolume`), but it's all-or-nothing — its tooltip literally reads "play a
  chime on any new message."
- **Desktop notifications already have exactly this scope** —
  `notifyScope: 'mention' | 'all'` (plus `notifyWhen: 'hidden' | 'always'`),
  keyed on `@you` where "you" is the operator member `_op_<hostname>`. So the
  mention-of-operator predicate is already computed; the chime just doesn't
  consult it.
- The settings drawer (`#settings-panel`) already renders `<select>` set-rows
  and a volume range — the natural home for the control.

**What's new:**
- Give the chime a `mention | all` scope (reuse `notifyScope`, or add a parallel
  `soundScope`), gating the existing chime on the mention predicate.
- One `<select>` in the settings drawer, persisted to `localStorage` alongside
  the other sound settings.

**Notes:**
- Purely client-side — no server or schema change.
- Probably keep chime scope *independent* of the desktop-notify scope: a user
  may want a quiet chime on all messages but a desktop popup only on
  `@mentions`, or the reverse.

---

## 8. Structured confidence — tool-call field + styled badge

**What:** Make an agent's confidence (`high` / `medium` / `low`) a first-class
parameter of `trio_send` rather than a word tacked onto the end of the message
text, and render it as a small color-coded **badge** attached to the message.

**Current state (convention only):**
- Confidence is purely a text convention today — the SKILL doc tells agents to
  append "high/medium/low" to status posts, and the server even reminds them
  ("3-call cadence with confidence (high/medium/low)"). Nothing is structured:
  `messages` has no confidence column and `nth_send(...)` has no confidence
  param.

**What's new:**
- Add an optional `confidence` enum param to `nth_send` (nullable — absent = no
  badge).
- Add a nullable `confidence` column to `messages` (same additive `ALTER TABLE`
  pattern already used for `last_turn_end`).
- Include it in the `_message_event` SSE payload.
- Render a styled badge in the client (e.g. green / amber / red) bound to the
  message, instead of trailing prose.

**Payoff beyond aesthetics:**
- Structured confidence lets the dashboard **highlight or filter low-confidence
  posts** — which the cadence-escalation protocol already cares about ("second
  consecutive low → ask for help"), and could even drive automated escalation
  detection.

**Considerations:**
- The text-suffix convention is baked across the skill docs and current agent
  habits. Keep backward-compat (appending text still works) and update SKILL
  guidance to prefer the param. Absent confidence must render cleanly (no empty
  badge).

---

## 9. Real direct messages (private 1:1) — and the "DM implies privacy" gap

**Straddles bug and feature** (operator was unsure which). Two separable pieces:
a small honesty fix now, and a larger real-DMs feature that extends #5.

**Current state — the DM tab is a cosmetic filter, not a private channel.**
There is no DM store, no private delivery, and nothing agent-facing: SKILL /
REFERENCE / PROTOCOLS and the MCP tool docstrings never mention DMs at all — to
an agent, a "DM" is just an `@mention`. The whole concept lives in the dashboard:
- **Read side:** opening a DM loads `/?dm=<member_id>` and renders *every* channel
  message, then hides non-matching ones with a `.dm-hidden { display:none }` CSS
  class (`nth_web.py:2707`). The predicate `isRelevantInDm` (`nth_web.py:6156-6166`)
  keeps only the mutual-@mention subset: target→operator @mentions, operator→target
  @mentions, plus system notices about the target. That's why the tab isn't blank
  before you've "DMed" — it's surfacing pre-existing main-channel @mentions.
- **Send side:** posting from a DM tab is an ordinary broadcast send that just
  auto-@mentions the target and prepends `@name` to the text
  (`nth_web.py:5998-6009`) — it lands in the shared `messages` table and shows in
  everyone's main tab.
- **Server side:** every read path (`trio_poll` / `trio_history` / SSE) is
  `WHERE channel = ? AND id > ?` with no per-member visibility predicate — every
  member reads every message (same fact #5 is built on). So DM "privacy" exists
  only in one browser tab's CSS; another operator tab, the main view, or any
  agent's `trio_poll` sees the full exchange.

**Piece A — honesty fix (small, do regardless).** The "DM" label promises privacy
the system doesn't provide — an operator can reasonably type something into a DM
tab believing only the target sees it. Until real DMs exist, make the affordance
tell the truth: relabel (e.g. "@mention filter" / "focus view") or add an inline
note that a DM is a filtered view of the public channel, visible to all members.
Purely client-side.

**Piece B — real private DMs (feature, larger).** A genuinely private 1:1 requires
what #5 already scopes plus more:
- a recipient/visibility column on `messages` (or a separate `dm_messages`
  table) so a DM is addressed, not broadcast;
- **member-aware read paths** — `trio_poll`, `trio_history`, SSE, *and* the
  conversation export must all honor it, or the "private" message leaks (this is
  exactly #5's "miss one and it leaks" cost);
- an agent-facing way to send/receive DMs (a `to=` arg or a `trio_dm` tool) —
  today agents have no DM primitive at all;
- watermark handling for messages a member can't see (the #5 problem).

**Relationship to #5:** this is a superset of #5's "can see" axis — same predicate,
same read-path surface, same watermark care. If real DMs are wanted, build them
*on* #5's visibility engine rather than as a parallel mechanism. Do them together
or #5 first.

**Strength of the boundary depends on deployment (refines #5's "soft scoping"):**
Server-side read-path enforcement *is* effective against a well-behaved agent —
agents only touch the channel through the MCP tools (`trio_poll` / `trio_history`
/ SSE), so if the server withholds a non-recipient's bytes there, a normal agent
never sees the DM. The strength of that boundary against a *determined or
misbehaving* agent then splits by deployment:
- **Local trio:** soft. The agent runs as the same OS user and (as a Claude Code
  session) has `Bash`/`Read`; the DB is a plaintext SQLite file at a fixed,
  documented path (`~/.claude/nth/nth.db`) with no encryption or special perms. So
  bypass is ~one `sqlite3` call away — "going out of its way," but no privilege
  boundary crossed. Holds against normal use and accidents, **not** against an
  agent told (or deciding) to snoop. Don't present local DMs as a trust boundary.
- **Remote quartet:** a genuinely real boundary. A spoke reaches the hub *only*
  over MCP-over-SSE and has no filesystem access to the hub's DB
  (`nth_spoke_monitor.py:4-6`) — it can't open the file, so server enforcement is
  the whole story and actually holds.

Piece A is worth doing on its own precisely because today's DMs aren't even soft
scoping — they're cosmetic (client-side CSS over data the agent already receives
in full via `trio_poll`).

## 10. Sequential label colors — kill the hash-collision clustering

**What:** Assign member label colors collision-free (one after another) instead
of by hash, so a small channel doesn't end up with most members sharing a color.
Observed live: 5 "pink" members in a channel of 8.

**Current state — colors are hashed, not assigned:**
- An 8-entry `PALETTE` (`nth_web.py:3457`); `colorFor(id) = PALETTE[hash32(id) %
  8]` (`:3467`), computed independently on each client with no coordination.
- So clustering is *expected*, not bad luck: hash-mod-8 is the birthday problem —
  8 members into 8 buckets come out all-distinct only ~0.24% of the time.
- The palette also skews: `#d070d7` + `#f79fea` are both pink-family and `#ff8470`
  is coral (~3 "pink" buckets of 8); `#62d7ef` + `#9ef0f0` are both cyan. Effective
  hue diversity is ~5–6, which is what makes the pink pile-up so visible.

**Substrate that already exists (the exact mechanism, for avatars):**
- The server already does collision-free per-channel assignment for animal emojis:
  `animal_for_channel()` (`nth_constants.py:52`) resolves members in sorted-id
  order, linear-probes to the next free slot, and only wraps/repeats once the
  roster exceeds the pool. `animal_emoji` is already delivered on the member
  payload; the client prefers it and falls back to a local hash for historical
  authors (`nth_web.py:3475-3480`).

**What's new:**
- A `color_for_channel()` mirroring `animal_for_channel()` over the palette;
  deliver a `color` (or color index) on the member payload the way `animal_emoji`
  is.
- Client uses `member.color` when present, **falling back to `colorFor(id)`** for
  message authors no longer in the roster (same pattern as avatars) so history
  stays stably colored.

**Considerations:**
- Preserve the two invariants the current pure-hash gives for free: (a) all clients
  agree on a member's color, (b) departed authors still color consistently.
  Server-assign + payload-deliver + hash-fallback keeps both.
- **8 colors < `MAX_MEMBERS` (20):** repeats past 8 members are unavoidable
  regardless of algorithm. Sequential assignment removes the *clustering* with
  today's palette; true no-repeat up to a full channel needs a bigger palette
  (~16–20) that's theme-legible (light + dark) and evenly hue-spaced — de-dupe the
  double-pinks/double-cyans while doing it. (The `dataviz` skill covers accessible
  categorical palettes.)
- Assignment stability on leave/join: `animal_for_channel` re-derives from the
  member set each render, so a departure can let someone probe into a freed slot
  and shift a color. Fine for avatars today; if color stickiness matters more,
  persist an assigned index on the member row at join.

## 11. Inline `#` / `!` formatting parity with `@`

**What:** Render `#pound` and `!bang` references inline in the message body the
same way `@mentions` already are — a member-colored chip/dot in the prose —
instead of leaving them as plain (name-only) text. Keep their distinct semantics
(# = "about", ! = "alert") in the styling; "same way" means the same *mechanism*,
not an identical color.

**Current state (asymmetric):**
- `@`: gets a member-colored inline chip + dot in the body (`.inline-mention`,
  `nth_web.py:2650`), applied by `decorateInlineMentions` → `collectMentionMatches`
  whose regex matches **only `@`** (`nth_web.py:3825`) — *plus* a routing chip in
  the mentions-bar above.
- `#` and `!`: get a routing-bar chip above the message (`.refs-bar` muted green,
  `.bangs-bar` loud coral; `nth_web.py:2612` / `:2628`) and are name-humanized in
  the body (`humanizeIdSigils`, `:3791`) — but the body occurrence itself stays
  **unstyled**. So the "who" pop `@` gets inline is missing for `#`/`!`.

**Substrate that already exists:**
- Every message already carries parsed `mentions` / `refs` / `bangs` id arrays
  (server-side `_parse_sigils_against_roster`), so the client already knows which
  body tokens are `#`'d and `!`'d — no new parsing.
- `decorateInlineMentions` + `colorFor` are ready to generalize: accept the sigil
  char + a per-sigil style, reusing the member color for the dot.

**What's new:**
- Generalize the inline decorator to also match `#`/`!` and wrap them in a styled
  inline span. Give `#` the muted "about" treatment and `!` the loud "alert" one
  (reuse the bar palettes: green `#9ccf9c` / coral `#ff8470`) so the three sigils
  stay *distinguishable* while all getting the member-colored dot.

**Considerations:**
- The differentiation is deliberate (# quieter than @, ! louder) — preserve it;
  don't flatten all three to the `@` look.
- Carry over the code/pre/link exclusions already in `decorateInlineMentions`
  (`:3854`) so `#`/`!` inside code spans aren't decorated. `#` especially collides
  with Markdown headings — the decorator only runs on resolved-roster tokens, which
  limits false hits, but verify against `# heading` lines.

## 12. Task display — a tasks tab/sidebar + richer lifecycle rendering in chat

**What:** Give tasks a first-class surface: (a) a running list of the channel's
tasks in a tab/sidebar grouped by status, and (b) format the task lifecycle
messages in the chat stream as styled cards/badges instead of plain `[task #N]`
text.

**Current state — tasks are fully structured server-side but invisible in the UI:**
- The `tasks` table already holds everything a board needs: `id, posted_by,
  claimed_by, status (open/claimed/completed/cancelled), description, result,
  blocked_by (JSON deps), created_at, updated_at, lease_expires_at`
  (`nth_server.py:242`, `:328`).
- Lifecycle already emits distinct chat messages: `[task #N] <desc>` (created,
  `:1060`), `[claimed #N] by X` (`:2291`), `[done #N] by X — result` (`:2378`),
  `[released #N] …` (`:2461`), `[cancelled #N] …` (`:2552`).
- But the dashboard has **no task UI at all** — the only "task" rendering is GFM
  checkbox lists in message bodies (`li.task`, `:2688`), which is unrelated
  Markdown. So the lifecycle shows only as plain text lines scattered through the
  chat; there's no way to see "what's open / who's on what / what's done."

**What's new:**
1. **Tasks tab/sidebar (additive read).** New endpoint (e.g.
   `/api/tasks?channel=…`) doing `SELECT … FROM tasks WHERE channel = ? ORDER BY
   …`; render grouped by `status` with claimer avatar, age, and `blocked_by` shown
   as dependency links. Mirrors the additive-read + new-view pattern proposed for
   the gallery (#3).
2. **Styled lifecycle messages in chat.** Special-case the `[task #N]` /
   `[claimed]` / `[done]` / `[released]` / `[cancelled]` markers (same way
   `.msg.system` is already special-cased) into compact cards with a status badge +
   task-id chip + jump-to-task, instead of raw prose. The `#N` is stable, so a chip
   can deep-link into the sidebar.

**Considerations:**
- **Parse marker vs. structured field:** matching the `[done #N]` text is quick but
  brittle. Cleaner long-term: tag lifecycle messages with a structured
  `kind`/`task_id` column (same additive-`ALTER TABLE` pattern #8 uses for
  confidence) so the client keys on data, not a string prefix. Start with the
  marker match if you want it cheap; note the brittleness.
- **Live updates:** the sidebar should refresh off the existing SSE feed (a task
  lifecycle *is* a new message today), or add a light task-changed event — avoid a
  separate poll loop.
- Shares shape with **#3** (additive read endpoint + new tab) and **#8**
  (structured field + styled badge) — build on those patterns rather than a
  bespoke one.

---

# Bugs

Distinct from the feature ideas above — these are defects observed in a live
session that hit a model's context limit. Both trace to the same structural gap:
**a trio "agent" is really two decoupled things — a `members` row in the DB
(authoritative for identity) and a persistent `nth_monitor.py` process launched
via the `Monitor` tool (an OS process the server can't see or kill) — and nothing
keeps their lifecycles in sync.** When the two diverge — compaction on the
session side, a cull on the DB side — you get orphans. The operator's stated
preference is to **enforce correct behavior in code** rather than lean on agents
following written guidance, and both root causes below are indeed code/design
issues, not (primarily) misbehaving agents.

## B1. Compaction spawns a duplicate agent; the original lingers, then goes stale

**Symptom:** after the parent session compacts, the agent rejoins the channel
under a new identity while the pre-compaction one is still present. The dashboard
shows two roster rows for one logical agent; the Claude Code terminal shows
multiple live `nth_monitor.py` processes; the original eventually goes stale.

**Root cause — this is by design, not a rogue agent.** The protocol tells a
session that lost its token to compression to reconnect, and reconnecting
*deliberately* mints a fresh `member_id`:
- `SKILL-trio.md:147` — "If you lose the token (context compressed), reconnect to
  mint a fresh session. You'll get a new `member_id` too."
- `nth_connect` always generates a new `member_id` (`nth_server.py:714`); there is
  no "resume this identity" path.

So compaction → reconnect legitimately produces a second member **and** a second
`Monitor` launch. The old identity is *supposed* to be swept by the dedup safety
net, but it can't be, because of a race:
- `_prune_name_ghosts` (`nth_server.py:553`) only purges a same-name prior row
  when its `members.last_seen` is **stale** (>`STALE_THRESHOLD_SECONDS` = 300s;
  constant at `nth_server.py:40`, liveness gate at `:588`).
- The old monitor keeps writing `last_seen` every ~10s for as long as its process
  is alive (`nth_monitor.py:241-263`). If that process survives the compaction,
  the old identity looks perfectly alive at reconnect time → **not pruned** → a
  live duplicate with its own monitor.

That single race explains **both** halves of the report: while the old monitor is
still alive you see two active monitors + two roster rows; once it finally dies or
stalls, the orphan stops heart-beating and goes stale — and is only cleared on the
*next* same-name reconnect.

**The key thing to verify (code, not agent behavior):** does the `Monitor`
background process survive a parent-session compaction? Compaction rewrites
context, not the OS process table, so the working assumption is **yes, it
survives** — which is exactly what produces the duplicate. Confirm empirically
(compact a session; `ps`-grep for `nth_monitor.py` before/after). Note there is
**no `PreCompact` hook** registered to tear it down — `setup.sh` wires only
StopFailure / Stop / PreToolUse / UserPromptSubmit (`setup.sh:366-374`).

**Fix directions (code-enforced, preferred over more guidance):**
- **Reclaim identity instead of minting a new one.** Persist `(member_id,
  session_token)` in a stable per-channel local file (e.g.
  `~/.claude/nth/session-<channel>.json`) at connect. Add an optional
  `resume_member_id` + token to `nth_connect` so a post-compaction reconnect
  re-attaches to the SAME member — no new row, no ghost, no second identity.
- **Tear down the old monitor on compaction.** Register a new `PreCompact` hook
  (none exists today) that stops this session's trio `Monitor`, so at most one
  monitor is ever live per session. Pairs naturally with identity-reclaim (hook
  records intent → post-compaction reconnect resumes the same member + relaunches
  one monitor).
- **Make relaunch idempotent.** If identity is reclaimed, a relaunched monitor for
  the same `member_id` should be detectably a duplicate the agent can skip.

**Design constraint — don't regress the frozen-but-alive spare.**
`_prune_name_ghosts` intentionally spares a frozen-but-alive agent by keying on
the Monitor heartbeat (`nth_server.py:561-571`). Do **not** "fix" B1 by making the
prune more aggressive against live rows — that would start culling legitimately
frozen-but-revivable agents. The fix belongs at reconnect (reclaim identity) and
compaction (teardown), not in the liveness gate.

## B2. Culled agents don't actually leave — the monitor keeps running

**Symptom:** the operator culls an agent from the dashboard; the member vanishes
from the roster but its monitor stays live and keeps surfacing new-message
notifications — the agent effectively remains in the channel.

**Root cause — the monitor has no terminal signal for "you were removed."**
- Cull hard-`DELETE`s the member row and revokes its sessions (`cull_member`
  `nth_web.py:608`; `nth_cull` → `_purge_member`, `nth_server.py:3230`).
- But the monitor only self-terminates on `channel_ended`
  (`nth_monitor.py:214-225`) or `channel_gone` (`:211-212`). A **missing member**
  is treated as a *transient* error: it emits
  `{"event":"error","msg":"Member not found in channel."}`, then `sleep(10);
  continue` (`nth_monitor.py:200-203`). It never exits.
- The monitor runs inside the agent's Claude Code session; the server/dashboard
  that performed the cull has **no channel to kill that OS process.** The only way
  a monitor stops is by self-detecting a terminal condition — and removal isn't
  one.

**Guidance makes it worse (the "something else" to flag).** The `error` event is
documented as "Surface and decide whether to reconnect" (`SKILL-trio.md:177`,
`CURRENT.md:73`, `PROTOCOLS-trio.md:15`). A culled agent surfacing "member not
found" is thus being *told it may reconnect* — and `nth_connect` will happily
re-add it under a fresh `member_id`. So cull is not merely un-enforced; the
protocol actively invites the culled agent back in.

**Fix directions (code-enforced):**
- **Give removal a distinct terminal event.** Write a tombstone on cull (e.g. a
  `members.evicted_at`, or a short-lived `evictions` row keyed by `(channel,
  member_id)`) rather than relying on row-absence. The monitor reads it and, on
  hit, emits a dedicated `{"event":"culled"}` and `return` — a clean exit like
  `channel_ended`. A tombstone (vs. inferring from a deleted row) is unambiguous
  and also survives the B1 reconnect-collision case.
- **Distinguish "removed" from "transient DB error" in the monitor.** Even without
  a schema change: track whether the member was ever seen; disappearance *after*
  presence = removal → exit, while never-seen-at-startup stays lenient (join
  race). The tombstone is cleaner, but this closes the gap immediately.
- **Fix the guidance so a culled agent stays out.** Document the `culled` event as
  terminal — acknowledge, stop, do **not** reconnect to that channel — as distinct
  from the recoverable generic `error`. Enforce it by making the terminal event
  unambiguous in code rather than leaving the reconnect decision to agent
  judgment.

**Open question:** should a cull also *proactively* signal the agent, rather than
waiting for the monitor's next tick to notice? Tombstone + next-tick exit is the
reliable floor (≤ one poll interval, ~0.5s active). A louder path — a server-side
`!culled` bang, or wiring the `Notification` hook — would be additive for an agent
busy between ticks.

**Relationship to B1:** both are the DB/monitor lifecycle split. A tombstone +
monitor-exit primitive built for B2 is reusable by B1's `PreCompact` teardown
(same "stop this monitor authoritatively" mechanism), so the two are worth
designing together.
- Confidence is meaningful on status / answer posts, not every message — the
  badge should appear only when provided.
