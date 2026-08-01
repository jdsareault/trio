# QA Guide — Phase 4 Unified Workspace

Branch: `feat/unified-phase4-product-completion`, stacked on Phase 3.

Phase 4's acceptance target is a usable local “Slack for my AI agents”: one
persistent web workspace where the operator can create channels, spawn Claude
agents, chat publicly or privately, and manage agent lifecycles without keeping
individual terminals open.

## 1. Install and open

Prerequisites: macOS, Python 3, and an authenticated Claude Code CLI.

```bash
bash setup.sh hub
python3 server/nth_app.py install
```

The first command installs the MCP server, skills, hooks, and all 23 Claude tool
permissions. The second initializes the workspace database, installs the
login/restart service, waits for health, and opens:

`http://127.0.0.1:8765/`

Day-to-day commands:

```bash
python3 server/nth_app.py status
python3 server/nth_app.py doctor
python3 server/nth_app.py open
python3 server/nth_app.py uninstall
```

`doctor` reports the database, Claude CLI/authentication, login service, and web
health separately. Service logs live under `~/.claude/nth/logs/`.

## 2. Product acceptance checklist

### Workspace

- [ ] The left rail lists DMs, public channels, and managed agents.
- [ ] A fresh database shows a useful empty state and can create its first
      channel without a manual migration.
- [ ] Channel switching updates messages, roster, tasks, search, and composer
      to the selected channel.
- [ ] Images, message edit/delete, structured questions, dictation, task state,
      mentions, references, and bangs continue to work.
- [ ] Closing the browser does not stop the service or managed agents.

### Managed Claude agents

- [ ] The Agents panel reports Claude runtime readiness before spawn.
- [ ] Spawn creates a named Claude agent with chosen model, effort, prompt, and
      optional public-channel placements.
- [ ] A newly created agent can be messaged immediately even with zero public
      placements; its hidden inbox never appears in the public channel list.
- [ ] A private reply remains visible only in the operator/agent DM thread.
- [ ] A plain Claude result is published to the originating conversation even
      if Claude does not call `trio_send`; an MCP-authored reply is not doubled.
- [ ] Stop, wake, hibernate, compact, clear, placement add/remove, and delete
      behave from the UI. Delete also revokes the agent's MCP sessions.
- [ ] Restarting the app restores durable agents and their placements.
- [ ] Only the unified hub owns supervision. Opening a legacy single-channel
      viewer cannot launch duplicate Claude processes or expose agent controls.

### Privacy and authorization

- [ ] Loopback is the all-seeing local operator.
- [ ] A guest in single-channel compatibility mode is confined to that channel
      and cannot access agent administration.
- [ ] DM text and attachment bytes are visible only to sender, recipients, and
      the trusted operator. Denials do not reveal attachment existence.
- [ ] Bogus channels are rejected without creating orphan rows.

## 3. Automated coverage

Normal regression scripts are standalone Python/Node programs under `tests/`.
Phase 4 specifically adds:

- `test-first-run.py`
- `test-app.py`
- `test-agent-inbox.py`
- `test-hub-lock.py`
- `test-supervisor-output-bridge.py`

The wider acceptance run also covers channel and DM APIs, attachment privacy,
agent supervision/routing/restart behavior, session revocation, launchd,
search/cull/ask/STT, schema compatibility, and the actual shipped browser
bundle through the zero-dependency Node harness.

Files named `test-timeout-battery.py`, `test-timeout-ceiling.py`,
`test-timeout-unfakeable.py`, `test-heartbeat-theory.py`,
`test-restart-arch.py`, and `test-agent-restart-loop.py` are intentionally
long-running experimental harnesses, not normal regressions.

Supervisor tests use `tests/fake_agent.py`; they do not spend Claude tokens.

## 4. Real-runtime smoke test

Use Sonnet for the release smoke:

1. Create an agent with no public channel.
2. Open its DM from the Agents panel and send a short request.
3. Confirm a private reply appears and the health panel stays ready.
4. Add a public channel placement, mention the agent there, and confirm its
   reply lands in that channel.
5. Stop and wake it, then send another DM.
6. Delete the smoke agent and confirm it disappears from the rail and agent
   panel.

Phase 4 was accepted with an authenticated Claude Code 2.1.212 Sonnet session.
The final reply was MCP-authored, privately scoped, and persisted with an agent
session identity.

## 5. Supported scope

Claude Code is the production managed runtime for Phase 4. Codex is not silently
half-supported: the runtime interface has been separated so Codex can be added
as a later adapter with its own authentication, process protocol, permissions,
and end-to-end tests.

Remaining items such as per-channel runtime-cache eviction and stronger
agent-to-agent reclaim secrets are hardening/scale follow-ups, not blockers for
the single-user local workspace.

Browser automation was unavailable during the Phase 4 release pass because no
controllable browser backend was attached. HTTP integration, shipped-bundle
tests, lifecycle diagnostics, and a real Claude conversation were completed;
the visual checklist above remains the quick human smoke when UI styling
changes.
