# Phase 4 Product Completion Report

Date: 2026-08-01  
Branch: `feat/unified-phase4-product-completion`  
Runtime scope: Claude Code

## Outcome

Phase 4 meets the practical single-user goal: nth can run continuously as a
local Slack-like workspace for creating, messaging, and managing Claude agents.
The normal workflow no longer depends on one terminal or public-channel
placement per agent.

## Delivered

- Installable login/restart service and one-command app lifecycle.
- First-run database creation and actionable runtime/service health reporting.
- Durable Claude agents with spawn, stop, wake, hibernate, compact, clear,
  placement management, and deletion.
- Private per-agent inboxes independent of public channel placement.
- Full 23-tool headless MCP allowlist and user installer permissions.
- Conversation output bridge for ordinary Claude results.
- Cross-process singleton supervision, preventing duplicate agent processes.
- Session revocation on deletion and server-side private-inbox enforcement.
- Copy deployment that safely replaces development symlinks.

## Acceptance evidence

- Installed MCP registration reports `nth-trio` connected.
- User settings contain all 23 `mcp__nth-trio__trio_*` permissions.
- `nth_app.py status --json` reports a ready database, loaded service, healthy
  hub, and authenticated Claude CLI.
- A real Sonnet agent received a DM in its hidden inbox and returned a private
  MCP-authored reply with a persisted session identity.
- Smoke agents, messages, placements, and sessions were removed after the test.
- All normal Python and Node regression programs pass. Experimental multi-minute
  timeout/restart harnesses are explicitly outside the normal suite.

## Deferred deliberately

Codex is not included in the production runtime claim for Phase 4. Claude and
Codex have different CLI stream/authentication semantics; shipping a named
`ClaudeRuntime` boundary is preferable to presenting an untested generic toggle.
A future Codex adapter can reuse the workspace, routing, lifecycle, privacy, and
health architecture established here.

Per-channel runtime eviction and stronger agent-to-agent reclaim credentials
remain defense-in-depth/scale work. Neither blocks a local single-user agent
workspace.
