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
