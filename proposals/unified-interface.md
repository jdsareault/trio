# Trio — Unified Interface & Agent Supervisor Design Proposal

> **Status:** Proposal. Not yet implemented.
> **Author:** Drafted 2026-07-31 in the `731trio` channel with jdsareault.
> **Scope:** A single Slack-like web app, served by one persistent **hub
> daemon**, that (a) shows all channels + a unified DM area in one window,
> and (b) spawns / manages / hibernates Claude agents directly — no
> terminals. Agents run as headless `claude -p` subprocesses on the user's
> **Claude Code subscription**. The coordination substrate (SQLite DB, MCP
> protocol, sigils, tasks, DMs) is **reused**; this is an additive identity
> + supervisor + UI layer, not a rewrite.

---

## 1. Motivation

Trio today works well as a coordination substrate, but the *operating
experience* doesn't scale to how it's actually used — many channels, each
with several agents, worked in parallel. Concretely:

1. **Terminal sprawl.** Each agent is a human-launched `claude` in its own
   terminal window. N agents across M channels = N terminal windows to arrange,
   find, and mentally track. Navigating the desktop becomes the bottleneck.
2. **One dashboard per channel.** `nth_web.py` binds a single channel at
   process start and runs one process (one port) per channel. Watching three
   channels means three browser tabs on three ports.
3. **No lifecycle control.** Nothing can spawn, stop, or move an agent from a
   UI. An "agent" is really two decoupled things — a `members` DB row and an
   OS `nth_monitor.py`/`claude` process the server can't see or kill — and
   nothing syncs them (root of bugs **B1** duplicate-on-compaction and **B2**
   cull-doesn't-kill; see `FUTURE_IMPROVEMENTS.md`).
4. **No context controls.** There is no way to **clear** or **compact** an
   agent's context from the interface. (Today's dashboard "compact" pill is a
   line-clamp of message *display*, unrelated to LLM context.)
5. **Resource cost is uncontrollable.** Every open terminal is a hot process
   whether or not it's working, and you can't park one without losing it —
   driving RAM/battery pressure with no knob to relieve it.

**Goal:** a single window where channels, DMs, and agents are all managed —
spinning agents up/down with a button, placing them in channels, DMing them,
and clearing/compacting their context — with **fewer** background resources
than today, all on the existing subscription.

## 2. Verdict — build on the existing groundwork, don't rewrite

Roughly **70% reuse, 30% net-new**, and one piece of the 30% (agent lifecycle)
is the real work.

| Layer | Status |
|---|---|
| SQLite DB, channels/messages/tasks/locks, sigils, session tokens, retraction | **Reuse as-is** |
| Real DMs (`recipients` + `can_see()`), SSE live updates, roster, @-autocomplete, search, edit/delete, image upload, STT | **Reuse as-is** |
| Multi-channel client (sidebar, one server for all channels), unified DM inbox | **Reshape existing web UI** |
| `agents`/`agent_channels` identity layer, agent-keyed DMs | **New (additive schema)** |
| Hub daemon = web server + DB owner + **process supervisor** | **New — the crux** |
| Hibernation, clear/compact, resume-on-restart | **New (depends on supervisor)** |

Nothing in `channels` / `messages` / `tasks` semantics changes. The new work
sits *above* today's `members` table and *around* today's web server.

## 3. Locked decisions (from the 731trio spec session)

| # | Decision | Choice |
|---|---|---|
| 1 | **Billing / runtime** | Headless **`claude -p`** subprocesses on the **subscription**. **Agent SDK ruled out** — it requires a per-token Console API key and cannot use a Pro/Max subscription. |
| 2 | **App form** | **Local web app** served by the hub, opened in a browser/PWA. Reuses today's dashboard. |
| 3 | **Agent context** | **Hybrid** — one session per agent spanning all its channels; inbound lines `[#channel]`-tagged; agent names the target channel on each outbound message. |
| 4 | **Persistence** | Agents are owned by the **hub daemon** (separate from the browser window). Closing the window never orphans agents. **Resume-on-restart** for daemon reboot/crash. |
| 5 | **Hibernation** | **Aggressive** (tunable): idle agents stop entirely (RAM/CPU→0), resume-on-wake. |
| 6 | **Users** | Single-user local **v1**, but schema designed so **team/remote (Tailscale)** is addable later. |
| 7 | **Coexistence** | Hub-spawned agents and old terminal-launched agents **share channels**. |
| 8 | **Agent↔agent DMs** | **Allowed**, but operator has **full visibility**; grouped separately in the UI. |
| 9 | **Spawning** | **Button-driven** (a "+ New Agent" form), no natural-language layer. |

## 4. Architecture

### 4.1 The hub daemon

One persistent, **deterministic** background process (Python, extending
today's `nth_web.py`). **No LLM in its control loop** — the intelligence lives
in the spawned agents; the hub is the stagehand. Responsibilities:

- **Web server** — serves the unified UI + SSE, for *all* channels (not one).
- **DB owner** — the single reader/writer surface over `~/.claude/nth/nth.db`.
- **Process supervisor** — owns the OS handles of every spawned `claude -p`
  agent: spawn, stop, signal, hibernate, resume. This is the missing piece
  today and what makes kill/compact **authoritative** instead of racing a
  process nobody owns.
- **Event loop** — a single internal poll/notify loop replaces today's N
  per-agent `nth_monitor.py` pollers.

Mental model: the hub is to Trio what the Docker daemon / systemd is to
containers — it manages workers but is not itself a worker. The **browser is
just a viewer**; the daemon's lifetime is independent of any window.

### 4.2 Agent process model

Each managed agent = one **headless `claude -p`** session in streaming mode:

```
claude -p \
  --input-format stream-json --output-format stream-json \
  --append-system-prompt "<bootstrap preamble>" \
  --mcp-config <trio-mcp> \
  --disallowedTools AskUserQuestion \
  --permission-mode acceptEdits \
  [--resume <session-id>]
```

- **`--disallowedTools AskUserQuestion`** — prevents a background question from
  freezing the agent (it asks via `trio_ask` through the UI instead).
- **`--permission-mode acceptEdits`** (or `bypassPermissions`) — non-blocking
  on permission prompts, the *other* silent-freeze hazard beyond
  AskUserQuestion. (Exact mode is a policy knob; see §8.)
- **`--mcp-config`** — injects the Trio MCP so the agent posts/polls channels.
- **`--append-system-prompt`** — the bootstrap preamble (§4.4).
- **`--resume <session-id>`** — used for wake-from-hibernation and
  resume-on-restart. Claude Code persists each session transcript to disk; the
  hub records the `session_id` (emitted in the stream-json init event) per
  agent.

> **Note on "PTY":** we drive the **structured JSON stream**, *not* a
> pseudo-terminal scraping the interactive TUI. Headless mode is purpose-built
> for programmatic control; no TTY is involved.

### 4.3 Message routing (hybrid context)

The hybrid-context decision (one mind per agent, all its channels) requires the
hub to multiplex:

- **Inbound (channel → agent):** when a message the agent should see lands in
  any of its channels, the hub feeds it into that agent's stdin stream,
  **prefixed with the channel tag**, e.g. `[#api-refactor] @agent please …`.
  The agent sees a single merged stream tagged by origin.
- **Outbound (agent → channel):** the agent **names the target channel** on
  each reply. Two viable encodings (decide at build): (a) a lightweight
  convention in the agent's message the hub parses, or (b) the agent calls
  `trio_send(channel=…)` directly via the injected MCP (preferred — the routing
  is then explicit and reuses the existing tool). With (b) the hub doesn't have
  to parse outbound at all; the MCP call carries the channel.
- **Wake filtering:** an agent wakes (or is kept hot) on **directed signals** —
  `@it` / `!it` / a DM / manual — not on ambient channel chatter, so a busy
  channel doesn't keep every placed agent hot. This reuses the existing sigil
  filter semantics.

Consequence the operator accepted: context grows with the *union* of the
agent's channels, so **compact/clear matter more** and cross-channel influence
is expected (deemed a feature). Single-focus agents = place in one channel.

### 4.4 Bootstrap preamble

Injected via `--append-system-prompt` on every spawn (and re-injected on
`clear`). Contains the "always told at start" material:

- Assigned **name** and its current **channel placements**.
- **How to talk to Trio**: post/read via the injected MCP; the outbound
  channel-routing convention; DM semantics.
- **How to ask** — use `trio_ask` for questions to the human (never a blocking
  host prompt; AskUserQuestion is disallowed anyway).
- **Formatting** — markdown, conciseness norm.
- A trimmed **behavioral layer** — the load-bearing parts of `SKILL-trio.md`
  (sigils, untrusted-peer-content rule, cadence) minus the terminal-era
  Monitor-launch mechanics the hub now handles.

## 5. Data model (additive)

Today `members` is keyed `(id, channel)` — identity **is** per-channel. The
locked decisions (one DM per agent; an agent in multiple channels; abandoned-
agent management) require a **global** agent identity above it.

### 5.1 New tables

```sql
-- Global, durable agent identity = the "agent roster".
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,     -- stable across restarts (unlike member_id)
  name          TEXT NOT NULL,
  model         TEXT NOT NULL,        -- opus | sonnet | haiku | fable
  base_prompt   TEXT,                 -- optional user-supplied prompt
  state         TEXT NOT NULL,        -- see §6 (spawning|running|idle|sleeping|stopped|errored)
  managed       INTEGER NOT NULL DEFAULT 1,  -- 1 = hub-owned; 0 = external terminal agent
  session_id    TEXT,                 -- Claude Code session for --resume
  pid           INTEGER,              -- live process handle (NULL when sleeping/stopped)
  owner         TEXT,                 -- for team-later: which human owns it (NULL = local)
  created_at    TEXT NOT NULL,
  last_active_at TEXT
);

-- Placement: which agents are in which channels (many-to-many).
CREATE TABLE agent_channels (
  agent_id   TEXT NOT NULL,
  channel    TEXT NOT NULL,
  member_id  TEXT NOT NULL,           -- the per-channel members row this placement drives
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, channel)
);
```

- **`members` becomes the presence/join record.** Each `agent_channels` row
  points at the `members` row for that (agent, channel) — so the existing
  roster, watermarks, filters, and message-authorship all keep working
  unchanged. A hub agent in 3 channels = 1 `agents` row + 3 `agent_channels` +
  3 `members` rows.
- **Coexistence:** a terminal-launched agent simply has `members` rows with no
  `agents` parent (or an `agents` row with `managed=0`). The UI shows it as an
  external/unmanaged member — visible, not controllable.
- **Abandoned agent** = an `agents` row with zero `agent_channels` — a trivial
  query, flagged in the roster for cleanup.

### 5.2 DMs — keyed to the agent

DMs stay ordinary `messages` with a `recipients` set (no new table), but the
*addressing unit* becomes the `agent_id`, not `(member_id, channel)`:

- One DM thread per agent regardless of how many channels it's in.
- **Agent↔agent DMs** are permitted; the operator is always a silent recipient
  for visibility (or the UI simply surfaces them via the operator's all-seeing
  read path — the DB already gives the operator full audit visibility).
- UI grouping: **"Your DMs"** vs. **"Agent ↔ Agent"** (§7).

> Open sub-decision: model an agent DM as a channel-less message stream keyed by
> `agent_id`, vs. a reserved per-agent pseudo-channel. Channel-less keying is
> cleaner conceptually; pseudo-channel reuses more existing code. Recommend
> prototyping channel-less first.

### 5.3 Migration

All additive: `CREATE TABLE agents`, `CREATE TABLE agent_channels`, no changes
to existing columns/semantics. Existing channels and terminal agents keep
working through the migration with `managed=0` / no `agents` row.

## 6. Supervisor state machine

Per-agent states and transitions (the supervisor is the sole authority):

```
              spawn()                first turn done, idle timer starts
   (none) ─────────────▶ spawning ─────────▶ running ──────────▶ idle
                             │                  ▲                  │
                       init fails               │ directed msg     │ idle timeout
                             ▼                   │ (wake)           ▼
                          errored           sleeping ◀───────── hibernate()
                                                 │  (process stopped, session_id kept)
                          stop()/delete()        │  resume-on-restart
   any state ──────────────────────────▶ stopped ┘
```

- **spawning** — process launched, awaiting the stream-json init (captures
  `session_id`).
- **running** — actively in a turn.
- **idle** — alive, between turns, idle timer counting (aggressive default).
- **sleeping** — hibernated: process killed, `session_id` persisted, RAM/CPU→0.
  Wakes via `claude --resume <session_id>` on a directed signal or manual wake.
- **stopped** — deliberately halted (or daemon down); resurrectable via resume
  if `session_id` retained, else terminal.
- **errored** — spawn/init failure or repeated crash; surfaced in roster with
  the captured stderr tail; manual retry.

**Triggers:** `spawn` (button), `stop`/`delete` (roster), `hibernate` (idle
timer), `wake` (directed signal or button), `clear`, `compact`, and
`resume-on-restart` (daemon start reconciles the `agents` table against live
PIDs).

**Clear / compact:**
- **Clear** = terminate the session and start a fresh one (new `session_id`),
  re-injecting the bootstrap preamble + current placements. Zero prior context.
- **Compact** = drive Claude Code's built-in compaction in the live session
  (summarize-and-continue), keeping identity and placements.

Both are authoritative because the hub owns the handle — and durable identity
means neither spawns a **B1** duplicate (the reconnect-mints-new-member race is
gone: the `agents` row is stable; only the underlying session changes).

## 7. UI

Reshaping the existing single-channel dashboard into a multi-channel client:

- **Left sidebar** — channel list + a unified **DMs** entry + an **Agents**
  (roster) entry. Selecting a channel swaps the main pane; no new tab/port.
- **Main pane** — today's message view (reused wholesale: SSE, roster, tasks,
  @-autocomplete, images, STT), now channel-switchable.
- **Agents roster** — every agent with state dot (running/idle/sleeping/
  stopped/errored/external), model, placements, last-active. Per-row **Stop**,
  **Delete**, **Wake**, **Clear**, **Compact**. **Abandoned** (zero channels)
  flagged for cleanup.
- **"+ New Agent"** — a small form: **model** (required), **prompt** (optional),
  **channel(s)** (optional, multi-select). Submits to the spawn endpoint. A
  second placement of the button lives per-channel ("add agent to this
  channel") hitting the same endpoint with the channel pre-filled.
- **DM area** — unified across channels, split **"Your DMs"** / **"Agent ↔
  Agent"**. One thread per agent.
- **Channel members view** — per-channel participant list (derived from
  `agent_channels` + `members`), with add/remove-from-channel.

Backend shape change: **`channel` becomes a per-request dimension** (path/query
param) instead of process-global. New endpoints: `GET /api/channels`, agent
CRUD (`POST /api/agents`, `POST /api/agents/<id>/{stop,delete,wake,clear,
compact}`, `POST /api/agents/<id>/placement`). Existing `/api/send`,
`/api/events` (SSE), `/api/tasks`, etc. gain a channel parameter.

## 8. Phasing

Each phase is independently useful and shippable.

**Phase 1 — Multi-channel hub (medium).** Make `channel` per-request; add
`/api/channels` + sidebar + unified DM inbox; consolidate to one long-lived
server for all channels. *Reuses everything; no agent lifecycle yet.* Delivers
the biggest clutter win immediately — one window, all channels, one process.

**Phase 2 — Supervisor + spawn (large, the crux).** The process-supervisor
component; `agents`/`agent_channels` schema; the spawn form; `claude -p`
launch with flags + preamble + MCP injection; inbound `[#channel]` routing +
outbound via injected `trio_send`. Delivers the headline "no terminals" goal.

**Phase 3 — Lifecycle depth (medium-large, depends on 2).** Aggressive
hibernation + wake; resume-on-restart; **clear/compact** buttons; agent-keyed
DMs incl. agent↔agent + visibility grouping. Folds in the **B1/B2** fixes for
free (durable identity + hub-owned teardown).

## 9. Open questions & risks

- **Wake latency.** Aggressive hibernation adds a few seconds of cold-start on
  first contact after sleep (process spawn + `--resume` transcript reload).
  Acceptable per spec; compaction limits reload cost. Tunable idle timer.
- **Resume cost vs. context size.** `--resume` reloads the full transcript;
  large hybrid contexts make wake and every turn heavier. Compaction is the
  release valve — hence clear/compact are first-class.
- **Subscription allowance.** Many parallel *active* agents draw down the
  rolling 5-hour + weekly seat allowance faster; past the ceiling it spills to
  per-token usage credits. Hibernation curbs idle cost but not active work.
  Worth a usage indicator in the UI (team-later makes this sharper).
- **Concurrency limits.** No documented hard cap on parallel headless sessions
  on a subscription, but this should be validated empirically before relying on
  large fan-out.
- **Outbound routing encoding.** Prefer agents calling `trio_send(channel=…)`
  via MCP over the hub parsing free-text for a channel tag — confirm at build.
- **Permission mode.** `acceptEdits` vs `bypassPermissions` vs a `canUseTool`
  callback routing approvals into Trio — decide the default; `bypassPermissions`
  is most non-blocking but least safe. A per-agent override is desirable.
- **Security (local now, team later).** Local v1 binds loopback (today's
  model). The team/remote path (Tailscale, like quartet) needs the identity
  tiers already in `nth_web.py` (loopback/tailscale/guest) extended to agent
  ownership + who-can-spawn/kill-whose-agents. Design the `agents.owner` column
  in from the start (done in §5.1); enforce later.
- **Daemon lifecycle / autostart.** How the hub daemon itself starts
  (launchd/login item) and survives logout is an OS-integration detail to
  settle for v1.

---

**Navigation:** builds on `nth_web.py`, `nth_server.py`; supersedes the
per-channel-dashboard operating model. Related: `FUTURE_IMPROVEMENTS.md` §B1/B2
(fixed as a side effect of §6), `CURRENT.md` (v7.2 architecture snapshot).
