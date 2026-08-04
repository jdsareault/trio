# P2 Global Session Gap Audit

**Scope:** Units 1–3 of the global-identity refactor.

## Identity and session paths

- `agents.id` is the canonical global agent identity; `members.(id, channel)`
  remains the channel presence row.
- `trio_connect` authenticates cross-channel reclaim with the global
  `reclaim_secret` and reuses one non-revoked primary session per agent.
- `_get_session` resolves a non-revoked token globally. Every channel-scoped
  caller still checks membership in the target channel before reading or
  mutating it.
- The one-time `p2-global-agent-session-v1` schema migration revokes all
  pre-existing P1 per-channel bearer rows before global lookup is enabled;
  later `get_db()` calls are idempotent and leave post-migration sessions live.
- Legacy per-channel session rows remain readable by token for migration
  compatibility; new connects use the agent-global session model.

## Watermark consumers

The authoritative read cursor is `members.last_read` for the target
`(agent, channel)` pair. The following paths were audited and updated:

- `nth_poll` and `nth_ack`
- `nth_monitor` reconciliation
- terminal dashboard roster reconciliation
- web dashboard roster reconciliation

`sessions.last_read` remains as a legacy column for old observers and is
initialized on newly minted sessions, but no read path uses it as a watermark.
Session `last_seen` and tool/turn observability remain session-backed.

The phase-end audit also removed channel-scoped joins from the dashboard, web
roster, web liveness, and stall-watchdog session lookups. A global session may
retain its legacy first-connected `sessions.channel` for compatibility, but it
now supplies observability to every surviving channel presence.

The remaining session-channel references are intentional: the composite legacy
index is retained and a watchdog prefers the legacy channel as its single
owner, falling back to a surviving presence if that channel was culled. The
web cull path mirrors server cull semantics and only revokes after the final
presence is gone. Operator authentication remains separate.

## Capability and mutation audit

The following channel-scoped paths all check target membership before any
mutation and, where a session token exists, bind its agent id to the caller:

`send`, `dm`, `ask`, `poll`, `ack`, `retract`, `claim`, `complete`, `release`,
`cancel`, `set_status`, `rename`, `lock`, `unlock`, `end`, and `cull`.

The comprehensive A-only/B-unjoined regression test confirms that a valid
global session cannot cross the channel boundary, while the same token remains
usable in its joined channels.

Culling now revokes the global session by agent id only after the final
`members` presence is gone. Culling one channel leaves the token usable in the
agent's other joined channels; culling the final channel revokes it everywhere.

## Intentional exceptions

- `permission_prompt` is global by design and is process-identity-gated: the
  framework-invoked tool records the `_AGENT_IDENTITY` captured by a successful
  `trio_connect`; it has no channel argument or caller-supplied token. It does
  not independently reject a pre-connect call with an empty identity.
- `cleanup` is maintenance-only and caller-identity-less. It refuses active
  channels, then deletes a named ended channel or all ended channels. Any
  caller able to invoke the tool can perform that pre-existing cleanup; it is
  outside the agent channel-capability path and remains a follow-up security
  decision.

## Coverage

- `test-global-session.py`: one session across two channels.
- `test-global-watermark.py`: independent A/B cursors and reconnect behavior.
- `test-monitor-global-watermark.py`: real Monitor reconciliation.
- `test-global-capability.py`: mutation/read boundary matrix.
- `test-global-session-e2e.py`: combined identity, session, watermark,
  capability, and web-roster path.
