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
- Confidence is meaningful on status / answer posts, not every message — the
  badge should appear only when provided.
