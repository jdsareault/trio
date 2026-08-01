# Phase 6 Completion — Reversible Conversation Archives

Date: 2026-08-01

Branch: `feat/unified-phase6-archives`, stacked on
`feat/unified-phase5-codex-design`

## Outcome

Channels and direct messages no longer have to remain in the everyday workspace
forever. Operators can archive a conversation, keep its complete history, view
it through a compact secondary browser, and restore it later. Archived content
does not clutter the primary channel rail or DM inbox.

## Behavior

- Channel archives preserve the channel row, messages, membership, tasks, and
  managed-agent runtime state. Archiving is organizational metadata, not ending
  a channel or deleting an agent.
- DM archives are scoped to the current operator. A message-id watermark marks
  the thread archived through its latest known message.
- A DM received above that watermark automatically resurfaces in the active
  inbox, preventing hidden unread work.
- The default channel and DM APIs return active conversations only. Explicit
  `archived=1` views return archive-browser data and archived DM history.
- Archived history opens read-only in the web client. Restore re-enables normal
  conversation controls.
- Desktop users open Archives from one quiet rail entry. On narrow layouts the
  same browser is available under Settings. Each item supports View and Restore.
- The current conversation has an Archive/Restore control, while active DM
  inbox rows also offer a compact archive action.

## Persistence and migration

The additive schema introduces `channels.archived_at`,
`channels.archived_by`, and `dm_archives(owner_id, thread_key,
archived_through_id, archived_at)`. Both the MCP server and web-app startup paths
apply the migration idempotently, including fresh installations.

## Validation

The archive HTTP integration suite covers channel archive/list/restore, DM
archive/list/history/restore, automatic DM resurfacing, invalid targets, and the
protected internal agent inbox. Fresh-install schema, unified workspace,
multi-channel isolation, served-bundle, JavaScript DOM, and Python compilation
checks remain green.

## Atomic implementation commits

- `0b7d5b4` — reversible channel and DM archive state/API
- `40c6ebf` — compact archive browser and conversation controls
