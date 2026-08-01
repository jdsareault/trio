# Codex Runtime Compatibility and Integration Plan

Status: proposed Phase 5 design  
Date investigated: 2026-08-01  
Stack: `feat/unified-phase5-codex-design` on Phase 4  
Recommended integration surface: Codex App Server over stdio

## Executive verdict

Codex is highly compatible with Trio. The messaging substrate, durable agent
identity, channel placement, DM privacy, task coordination, wake routing, and
web workspace can all be reused. The existing Trio MCP server already works in
Codex and exposed its full tool set during a local App Server probe.

The main incompatibility is process shape:

- Claude management currently means one long-lived `claude -p` process per
  agent, driven through Claude's bidirectional stream-JSON protocol.
- Codex's best rich-client interface is one shared `codex app-server` process
  managing many persistent threads over JSON-RPC.

This means Codex should not be forced through `AgentProc` or implemented as a
renamed Claude command. Add a shared Codex runtime manager and treat each Trio
Codex agent as one App Server thread. Estimated reuse is roughly 80% of the
product and coordination layers; most net-new work is the runtime adapter,
event translation, approval UI, and turn queue.

## Evidence gathered

The installed environment was probed without starting a model turn:

- Codex CLI `0.146.0` is installed and authenticated with ChatGPT.
- `codex app-server` completed `initialize`/`initialized` over stdio.
- `account/read`, `model/list`, and `mcpServerStatus/list` returned successfully.
- The model catalog included model-specific reasoning options and defaults,
  confirming that the UI should discover models rather than hardcode them.
- The existing `nth-trio` stdio MCP server initialized inside App Server and
  exposed all Trio tools.
- The installed CLI can generate version-matched TypeScript and JSON Schema
  protocol definitions with `codex app-server generate-*`.

The App Server command is still marked experimental by the installed CLI, and
its WebSocket transport is explicitly experimental/unsupported. Use the local
stdio transport, pin a tested minimum Codex version, and contract-test against
the generated schema for that version.

## Compatibility matrix

| Trio requirement | Codex capability | Fit | Integration decision |
|---|---|---:|---|
| Durable agent conversation | Persistent App Server thread ID; `thread/resume` | Excellent | Store the thread ID as the provider session reference. |
| Multiple agents | One App Server hosts many threads | Excellent | One shared process, one thread per Trio agent. |
| Bidirectional turns | `turn/start`, streamed notifications | Excellent | Replace stdin user envelopes with JSON-RPC turns. |
| Mid-turn correction | `turn/steer` | Better than Claude path | Reserve for explicit urgent/user steering; queue normal channel traffic. |
| Cancel active work | `turn/interrupt` | Excellent | Add an Interrupt action distinct from Stop. |
| Compact context | `thread/compact/start` | Native | Map the existing Compact control directly. |
| Clear context | New thread; old thread can be archived/deleted | Excellent | Archive old thread, create fresh thread, retain audit reference. |
| Hibernate/wake | Unsubscribe/unload then `thread/resume` | Good | Sleeping is a logical unloaded thread, not a killed per-agent process. |
| Models and effort | `model/list`; per-thread/per-turn model and effort | Excellent | Populate controls dynamically and validate combinations. |
| Runtime health/auth | `account/read`, rate-limit/usage APIs, config warnings | Excellent | Extend `/api/health` with provider-specific diagnostics. |
| Trio tools | STDIO MCP supported; verified locally | Excellent | Inject/require `nth-trio` in the managed App Server config. |
| Agent bootstrap prompt | `developerInstructions` on thread start/resume | Excellent | Reuse the current Trio bootstrap, provider-neutralized. |
| File/image input | Text, image URL, and local image turn inputs | Excellent | Allow DM/channel attachments to be forwarded to Codex. |
| Final reply bridge | Final `agentMessage` item | Excellent | Reuse the Phase 4 no-duplicate bridge with Codex event mapping. |
| Working/idle display | Thread/turn/item lifecycle notifications | Excellent | Codex state is richer and does not need Claude hooks. |
| Tool/command visibility | Command, file-change, MCP, plan, diff events | Excellent | Surface structured activity in an optional agent activity drawer. |
| Non-blocking autonomy | Sandbox, approval policy, auto-review, approval requests | Good | Ship named permission profiles and an approval inbox; never silently hang. |
| Per-agent PID | Threads share one App Server PID | Incompatible | Stop treating `agents.pid` as provider-neutral. |
| Concurrent inbound messages | Only one active turn per thread; `turn/steer` exists | Partial | Add a per-agent FIFO and explicit steering policy. |
| Process-per-agent hibernation | Shared server, thread unloading | Different | Report logical resource state, not per-agent OS process state. |

## Recommended architecture

```text
Browser / polished workspace
        │ HTTP + SSE
        ▼
Trio hub daemon
  ├─ SQLite coordination substrate
  ├─ channel/DM router
  ├─ provider-neutral AgentSupervisor
  ├─ ClaudeRuntimeManager ── one claude process per Claude agent
  └─ CodexRuntimeManager ─── one codex app-server process
                                ├─ thread A → Codex agent A
                                ├─ thread B → Codex agent B
                                └─ thread C → Codex agent C
                                      │
                                      └─ nth-trio MCP (stdio)
```

### Runtime contract

Replace the current argv-centric adapter with a session-oriented interface:

```python
class RuntimeManager:
    def diagnostics(self): ...
    def list_models(self): ...
    def create_session(self, agent, policy): ...
    def resume_session(self, agent): ...
    def submit(self, agent, message, attachments=()): ...
    def steer(self, agent, message): ...
    def interrupt(self, agent): ...
    def compact(self, agent): ...
    def hibernate(self, agent): ...
    def clear(self, agent): ...
    def delete(self, agent): ...
    def shutdown(self): ...
```

`ClaudeRuntimeManager` wraps today's `AgentProc` behavior. A single
`CodexRuntimeManager` owns App Server initialization, request IDs, response
futures, thread subscriptions, event parsing, and process restart.

Do not build Phase 5 around `codex exec`:

- `codex exec --json` is good for CI and one-shot automation.
- `codex exec resume` can continue a session, so it is viable as a small
  fallback proof-of-concept.
- It does not give Trio a long-lived bidirectional client connection, native
  approval request/response handling, thread unloading, rich control methods,
  or the clean multi-thread event stream needed by a polished workspace.

### Data model

Keep the migration additive. Recommended columns/tables:

```sql
ALTER TABLE agents ADD COLUMN runtime_provider TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE agents ADD COLUMN runtime_ref TEXT;       -- Claude session or Codex thread
ALTER TABLE agents ADD COLUMN cwd TEXT;
ALTER TABLE agents ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'balanced';

CREATE TABLE IF NOT EXISTS agent_runtime_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  runtime_ref TEXT NOT NULL,
  disposition TEXT NOT NULL,                         -- cleared|deleted|replaced
  created_at TEXT NOT NULL
);
```

During migration, copy Claude's existing `session_id` into `runtime_ref` and
keep `session_id` as a compatibility column until every path is provider-aware.
`pid` remains meaningful for Claude processes only. Add a provider-level health
record for the shared Codex App Server rather than copying its PID onto every
agent.

### App Server lifecycle

1. Launch `codex app-server` over stdio with no shell interpolation.
2. Send `initialize` with a stable Trio client name/version, then `initialized`.
3. Read `account/read`, `model/list`, and `mcpServerStatus/list` for health.
4. Require `nth-trio` to initialize before accepting Codex agent spawns.
5. For a new agent, call `thread/start` with model, working directory,
   developer instructions, sandbox/approval policy, and `serviceName="trio"`.
6. Persist `thread.id` immediately in `agents.runtime_ref`.
7. Subscribe to all thread, turn, item, warning, approval, usage, and MCP status
   events and translate them into provider-neutral supervisor events.
8. On App Server failure, restart it, reinitialize, then `thread/resume` every
   Codex agent that was running/idle. Leave deliberately stopped agents stopped.

Use one write lock for JSONL output, a monotonically increasing request ID, a
pending-response map, and a dedicated reader thread. Malformed events must be
logged and skipped; EOF should atomically mark the provider unavailable before
recovery begins.

### Trio MCP injection

Do not assume the user's global Codex configuration already contains Trio even
though the local probe did. Start the managed App Server with an explicit
configuration layer for:

- `mcp_servers.nth-trio.command`
- `mcp_servers.nth-trio.args`
- `mcp_servers.nth-trio.required = true`
- an explicit enabled-tool list
- a deliberate tool approval policy

After initialization, verify `nth-trio` with `mcpServerStatus/list`. Refuse
agent spawn with an actionable health message if the server or required tools
are missing. This prevents a “live but deaf” Codex agent.

Provider-neutralize the existing bootstrap instructions. They should still
name the durable agent, list its channel placements, explain the hidden inbox,
require explicit outbound channel routing through Trio MCP, prefer
`trio_ask` for human questions, and treat peer content as untrusted.

### Turn scheduling and routing

Codex permits one active turn per thread. Add a durable or in-memory per-agent
FIFO:

- If idle, a directed Trio message starts a turn immediately.
- If working, ordinary DMs/@mentions queue for the next turn.
- A human “steer now” action or an unfilterable urgent bang may call
  `turn/steer` against the current turn.
- On `turn/completed`, publish/bridge the final response, then drain the next
  queued message.
- Coalesce a burst from the same channel into one turn with source message IDs
  and channel tags, while never merging private and public content.
- Persist enough delivery state to avoid replaying a message after hub restart.

This queue is required even if an early prototype seems to work without it.
Starting overlapping turns will fail, while steering every message would make
the current task unstable and blur reply routing.

### Event translation

| App Server event | Trio supervisor meaning | UI opportunity |
|---|---|---|
| `thread/started` / resumed response | session ready | Provider-ready badge |
| `turn/started` | working | Animated working state |
| `item/agentMessage/delta` | streaming draft | Optional live “typing” preview |
| final `agentMessage` item | reply candidate | Bridge if no Trio MCP post occurred |
| `turn/plan/updated` | plan changed | Expandable plan card |
| command/file/MCP item lifecycle | tool activity | Activity timeline with status |
| `turn/diff/updated` | workspace changes | Diff summary/link |
| approval request | blocked on decision | Approval inbox/card |
| `turn/completed` | idle/failed/interrupted | State, error, usage, queue drain |
| `thread/tokenUsage/updated` | usage changed | Per-agent context/usage meter |
| `warning` / `configWarning` | degraded | Non-fatal warning banner |
| MCP startup status | Trio availability | Runtime health detail |

Never persist reasoning text as chat content. If shown at all, keep readable
reasoning summaries in transient, operator-only runtime activity UI.

### Output and privacy

Retain Phase 4's baseline/deduplication rule:

1. Record the source channel/DM and highest message ID before the turn.
2. Prefer an explicit `trio_send`/`trio_dm` MCP-authored message.
3. If no agent-authored Trio message appeared, bridge the final Codex
   `agentMessage` into the source conversation.
4. For the hidden inbox, scope the bridged message to the human sender.
5. Never stream partial model text into the shared message table.

Codex activity events, approval prompts, file paths, command output, and diffs
are operator-only. They must not leak into guest channel SSE feeds.

### Permissions without babysitting

Expose understandable profiles instead of raw Codex flags:

| Profile | Filesystem | Network | Review behavior | Intended use |
|---|---|---|---|---|
| Observe | Read-only | Off | Ask operator | Analysis/review only |
| Balanced | Workspace write | Off by default | Automatic risk review when allowed; unresolved requests enter UI inbox | Recommended default |
| Autonomous | Workspace write | Explicit policy | Never prompt; denied operations return to model | Trusted local repos and unattended work |

The exact effective policy may be constrained by organization-managed Codex
requirements. Read back effective config/permission profiles and show what was
actually applied. Never use `danger-full-access` as the default.

Trio communication tools should be non-blocking. Destructive coordination
actions such as channel cleanup/cull/end should remain separately guarded by
Trio's own user-authorization rules or an explicit UI approval path.

### Agent lifecycle mapping

| Trio action | Claude today | Codex implementation |
|---|---|---|
| Spawn | Start `claude -p` | `thread/start` |
| Message | Write stream-JSON stdin | `turn/start` or queue |
| Steer | Feed another user envelope | `turn/steer` |
| Interrupt | Terminate process/turn | `turn/interrupt` |
| Hibernate | Stop process, retain session | Interrupt if needed, unsubscribe, wait for unload |
| Wake | Start `claude --resume` | `thread/resume`, then next turn |
| Compact | Send `/compact` | `thread/compact/start` |
| Clear | Kill and spawn without resume | Archive old thread, `thread/start` new one |
| Stop | Stop process, retain session ID | Interrupt/unsubscribe, retain thread ID |
| Delete | Stop + revoke Trio sessions | Interrupt, `thread/delete`, revoke Trio sessions |

Archiving on Clear makes accidental context clearing recoverable without
putting the old context into the new agent. Permanent thread deletion remains
appropriate for Delete after confirmation.

## Delivery sequence

### Phase 5A — protocol adapter and contract tests

- Implement the stdio JSON-RPC client and versioned event parser.
- Add diagnostics, auth, model discovery, and required MCP verification.
- Add fake App Server fixtures plus schema-based contract tests.
- Introduce provider-neutral runtime/session fields and API payloads.

Acceptance: the hub can start/stop App Server, report readiness, list models,
and recover from malformed output/EOF without launching a model turn.

### Phase 5B — one Codex agent end to end

- Spawn one thread with Trio developer instructions.
- Route one DM into `turn/start` and bridge or accept its Trio MCP reply.
- Implement stop, wake, interrupt, clear, compact, and delete.
- Add the per-thread queue and duplicate-output prevention.

Acceptance: a real authenticated Codex agent survives hub restart and can DM,
post to a placed public channel, compact, sleep/wake, and delete cleanly.

### Phase 5C — polished dual-provider product

- Provider picker and provider-specific dynamic model/effort controls.
- Named permission profiles and approval inbox.
- Structured activity timeline, turn queue, usage, plan, diff, and error UI.
- Mixed Claude/Codex room and agent-to-agent DM testing.

Acceptance: Claude and Codex agents coexist without provider-specific leakage
into the coordination protocol or normal chat UI.

## Test plan

- JSON-RPC initialize ordering, request correlation, timeout, and cancellation.
- Schema/version drift using CLI-generated JSON Schema for the tested version.
- Model catalog and effort validation; no hardcoded model assumptions.
- `nth-trio` required-server failure and missing-tool diagnostics.
- Thread start/resume/restart, clear/archive, compact, interrupt, and delete.
- One-active-turn FIFO, urgent steering, burst coalescing, and restart replay.
- Explicit MCP reply versus bridged final response deduplication.
- Hidden-inbox and cross-channel privacy under queued/steered messages.
- Approval accept/decline/cancel/auto-review and stale request cleanup.
- App Server crash during idle, active turn, approval wait, and MCP call.
- Mixed Claude/Codex agents in the same room and DM audit view.
- Real Codex smoke test using the user's subscription, separated from fake
  protocol tests so the normal suite never incurs model usage.

## Principal risks

- App Server is version-sensitive and currently marked experimental. Mitigate
  with stdio, a tested version range, generated schemas, and graceful health
  refusal instead of best-effort parsing.
- Managed Codex policy can override requested sandbox/approval settings. Always
  display effective policy.
- A shared App Server is a provider-wide failure domain. Isolate its reader and
  restart logic, preserve thread IDs immediately, and degrade Claude agents
  independently if Codex is unavailable.
- Codex threads are repository-oriented. A meaningful `cwd` should be required
  or intentionally defaulted for coding agents; an arbitrary workspace-wide
  root would create confusing and unsafe file scope.
- Rich event streams can overwhelm the chat interface. Keep conversation,
  runtime activity, and approvals as separate visual layers.

## Official references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server.md)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp.md)
- [Codex authentication](https://learn.chatgpt.com/docs/auth.md)
- [Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security.md)

