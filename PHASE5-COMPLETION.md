# Phase 5 Completion — Managed Claude and Codex Workspace

Date: 2026-08-01

Branch: `feat/unified-phase5-codex-design`, stacked on
`feat/unified-phase4-product-completion`

## Outcome

Phase 5 turns the Phase 4 Claude-only workspace into a provider-neutral local
agent product. A user can install the app once, open the Agents panel, choose
Claude Code or Codex, and chat with both providers in channels or private DMs.
The hub owns their lifecycle and wakes them from normal Trio messages without
model polling or terminal babysitting.

## Delivered

- One shared Codex App Server stdio process with correlated JSON-RPC requests,
  streamed notifications, asynchronous server requests, bounded stderr, and
  automatic restart/re-subscription after a provider crash.
- One persistent Codex thread per managed agent, with durable resume, FIFO turn
  scheduling, final-reply bridging, duplicate suppression, interrupt, compact,
  hibernate, wake, archive-on-clear, and permanent delete.
- Required managed `nth-trio` MCP injection and verification of all 23 exposed
  `trio_*` tools before any Codex agent can spawn.
- Additive provider-neutral schema, Claude session backfill, runtime history,
  project working directory, named permission profile, and wake-policy fields.
- Provider-neutral supervisor and HTTP control plane while retaining Phase 4
  Claude behavior and compatibility surfaces.
- Dynamic Codex model/reasoning discovery, provider health, safe permission
  profiles, approval inbox, runtime activity view, busy/queue state, and native
  local-image turn inputs.
- Token-free managed wake policies: `at`, `about`, and `all`; private DMs and
  `!bangs` always route, while Stop remains deliberate and sticky.
- Mixed-provider acceptance coverage: Claude and Codex coexist in the same room
  and both respond to one directed channel message.

## Validation

Deterministic suites cover protocol correlation, malformed output, server
requests, model discovery, required MCP tools, permissions, persistent threads,
queue ordering, output privacy, lifecycle controls, approvals, activity, crash
recovery, image input, HTTP APIs, mixed-provider routing, and browser bundle
integrity. Existing Claude supervisor, routing, first-run, schema, DM, workspace,
activity, and client-render suites remain green.

The repository-wide run also completed the five-minute heartbeat theory test.
The files `test-timeout-battery.py`, `test-timeout-ceiling.py`, and
`test-timeout-unfakeable.py` are manual duration probes (up to 3,500 seconds),
not assertion suites, and were intentionally excluded from release automation.

The installed real Codex CLI/App Server was validated without a model turn:
authentication, model discovery, generated schema, required Trio MCP startup,
and all 23 managed tools succeeded. That probe found and fixed two real contract
issues: MCP allowlist names require the `trio_` prefix, and this installed schema
uses `read-only`/`workspace-write` sandbox values. The opt-in
`tests/smoke-real-codex.py` script is separated from normal tests because it
consumes subscription usage. Its actual model turn was not executed in this run
because the environment's security reviewer required a separate, payload-specific
approval for external prompt transmission.

## Atomic implementation commits

- `f61f63d` — App Server protocol client
- `6072f4e` — persistent Codex thread manager
- `4d6921e` — provider-neutral runtime schema
- `51a6295` — provider lifecycle dispatcher
- `41cfaa6` — dual-provider HTTP controls
- `d280a92` — managed wake policies
- `33a631d` — Codex UI configuration
- `21c3a04` — approval inbox and runtime activity
- `ebae12b` — App Server crash recovery
- `4d3e69a` — image attachment forwarding
- `48815c7` — Claude session-readiness race fix
- `45ee9df` — mixed-provider room acceptance
- `71dee52` — installed App Server schema alignment and opt-in real smoke

## Operation

Install or upgrade normally:

```bash
python3 server/nth_app.py install
python3 server/nth_app.py doctor
```

Open `http://127.0.0.1:8765/`, select **Agents**, choose a provider, model,
effort, channels, wake policy, and—when using Codex—project directory and
permission profile. Spawned agents are immediately available in the unified DM
inbox and their placed channels.
