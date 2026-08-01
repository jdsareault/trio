# Trio / nth Polished UI Prototype Brief

Audience: UI-focused product designer or prototyper  
Product state: Phase 4 works end to end with managed Claude agents  
Near-term extension: Phase 5 adds managed Codex agents  
Prototype target: desktop-first responsive local web app

## The short version

Trio is “Slack for my AI agents.” It gives one human a persistent workspace
where they can create channels, spin up AI workers, talk to them publicly or
privately, coordinate shared work, see what each agent is doing, and control
their lifecycle without arranging a terminal window for every agent.

The current implementation proves the complete workflow but grew from a dense
developer dashboard. The polished prototype should make the system feel like a
calm, legible communication product—not a process monitor with chat bolted on.
The operator should be able to answer these questions at a glance:

1. Where are my conversations and agents?
2. Who is working, idle, sleeping, stopped, blocked, or broken?
3. Who will receive the message I am about to send?
4. Does anything need my attention?
5. What changed while I was away?

## Why the product exists

Using several coding agents currently creates operational clutter:

- Every agent tends to live in a separate terminal or app thread.
- Conversations fragment across terminal windows, browser tabs, and channels.
- The human has no single roster or authoritative lifecycle controls.
- An idle agent consumes resources unless manually stopped, while stopping it
  often risks losing context or identity.
- Public coordination, private questions, task ownership, and file locks are
  separate concerns with no coherent visual home.
- It is difficult to tell whether an agent is working, waiting, asleep,
  disconnected, blocked on approval, or simply failed.

Trio separates the deterministic “stage manager” from the AI workers. A local
hub owns the database, live event feeds, message routing, and managed agent
sessions. The browser is a durable control room: closing it does not stop the
hub or orphan agents. Agents can hibernate to zero per-agent process cost and
resume with context when directly contacted.

The emotional goal is important: this should feel like having a reliable small
team available, not like babysitting a collection of CLI processes.

## Product principles

- **Conversation first.** Normal chat should look and behave like a polished
  messaging app. Runtime detail is available on demand, not sprayed into chat.
- **Attention is explicit.** Unread, mentions, questions, approvals, failures,
  and blocked work are visually distinct and easy to clear.
- **Autonomy without mystery.** Agents can work unattended, but the operator
  can inspect plans, tools, errors, permissions, and changes when needed.
- **Identity survives lifecycle.** An agent remains the same teammate when it
  sleeps, wakes, changes channels, compacts, or starts a fresh context.
- **Privacy is visible.** DMs and private attachments must look private before
  send and after delivery.
- **Provider differences stay secondary.** Claude and Codex are runtime types,
  not separate products. Shared behaviors should look shared; provider-specific
  controls appear only where they matter.
- **Safe defaults, fast expert flow.** Destructive actions get confirmation;
  keyboard navigation and shortcuts keep daily use fast.

## Core product objects

| Object | Meaning in the UI |
|---|---|
| Workspace | The local, persistent home containing all conversations and agents. |
| Human/operator | The trusted local user. Can see all conversations and manage agents. |
| Channel | A public coordination room with topic/objective, members, messages, and tasks. |
| DM thread | A private thread between the operator and an agent/member; agent-to-agent DMs are auditable by the operator. |
| Durable agent | A named AI teammate with provider, model, prompt, context, state, and channel placements. |
| Placement | Membership of a durable agent in a public channel. An agent can have zero or many. |
| Message | Markdown content, addressing metadata, attachments, replies, confidence, and audit state. |
| Task | Claimable work with dependencies and a lifecycle. |
| Lock | Temporary exclusive ownership of a named resource. |
| Runtime activity | A provider-specific turn, plan, tool call, command, diff, usage update, approval, warning, or error. |
| Approval | A decision needed before an agent performs a command, file, network, or destructive action. |

## Recommended information architecture

```text
Workspace shell
├─ Left navigation
│  ├─ Home / attention summary
│  ├─ Direct messages
│  ├─ Channels
│  └─ Agents
├─ Main content
│  ├─ Conversation header
│  ├─ Message timeline
│  └─ Composer
├─ Context drawer
│  ├─ Channel members
│  ├─ Tasks
│  ├─ Channel activity/stats
│  └─ Agent activity/details (when an agent is selected)
└─ Global layers
   ├─ Search
   ├─ New channel / new DM / new agent flows
   ├─ Attention and approval inbox
   ├─ Settings and diagnostics
   └─ Confirmation dialogs / toasts
```

The current product has Channels, DMs, and Agents in the left rail and puts
roster/tasks/stats in a right sidebar. Preserve that mental model, but give
attention items and agent details a more intentional hierarchy.

## Required primary views

### 1. Workspace home / attention summary

The current app lands directly in the most recently active channel. A polished
prototype should explore an optional home that summarizes:

- unread DMs and mentions;
- structured questions awaiting the human;
- approval requests;
- errored, stalled, or blocked agents;
- active agents and what they are doing;
- recently active channels;
- open/claimed/blocked tasks;
- runtime health for Claude, Codex, database, and background service.

This page must remain a shortcut, not a required administrative checkpoint.

### 2. Channel conversation

Header:

- channel name, topic/objective, connection state, and member count;
- channel switcher on narrow layouts;
- search, channel details, notification state, and overflow actions;
- clear indication if the channel has ended or is unavailable.

Timeline:

- live updates over SSE;
- chronological markdown messages with code formatting and clickable local
  file paths;
- author avatar/color, name, model/provider badge where useful, timestamp, and
  optional real database message number;
- public, @mention, #reference, !bang, DM, task, question, system, edited,
  retracted, and confidence states;
- inline image attachments with a viewer/lightbox affordance;
- unread divider, “new messages” bar, jump-to-latest button, and scroll
  position preservation;
- compact display mode that clamps long messages but allows per-message expand;
- read/acknowledgement indicators for other members;
- contextual edit/delete actions for the human's own messages;
- retracted messages remain as audit placeholders rather than disappearing;
- muted system events for joins, renames, placements, task changes, culls, and
  channel lifecycle changes.

Context drawer:

- member roster;
- task list/graph summary;
- channel message/activity statistics;
- channel objective and management actions;
- responsive drawer/backdrop behavior on small screens.

### 3. Unified DM area

- one thread per durable agent, independent of public-channel placement;
- start a new DM from the rail, agent row, roster, or global picker;
- agents with zero public channels remain messageable through their hidden
  private inbox;
- unread count and last-message preview per thread;
- origin channel badges when a private interaction was initiated from a public
  channel context;
- a separate auditable “Agent ↔ Agent” group so autonomous coordination is
  visible but does not pollute the human's own inbox;
- private composer state and attachment treatment that is visually unmistakable;
- only sender, recipients, and trusted operator can see private content.

The hidden internal inbox channel is an implementation detail and must never
appear as a normal channel.

### 4. Agent directory and detail

Directory rows/cards must show:

- name and stable identity;
- provider (Claude now; Codex next), model, and reasoning effort;
- state: spawning, working/running, idle, sleeping, stopped, errored, external;
- last active time and current task/status text;
- public channel placements;
- unread/queued messages or attention badge;
- abandoned state when the agent has zero public placements;
- managed versus external/unmanaged distinction.

Primary row actions:

- Message;
- Wake or Stop, depending on state;
- overflow menu for Hibernate, Interrupt, Compact context, Clear context,
  channel placement management, and Delete.

Agent detail should provide:

- editable display name and base prompt/role;
- provider, model, effort, working directory, and permission profile;
- channel placement chips with add/remove;
- lifecycle state and clear plain-language explanation;
- session/context metadata and last active time;
- current/queued turn summary;
- recent errors and runtime health;
- locks held, task ownership, tool/activity summary, and read watermark;
- operator-only runtime activity timeline;
- usage/context meter when the provider supplies it.

### 5. New agent flow

Current Phase 4 fields:

- optional name;
- Claude model;
- reasoning/thinking effort;
- optional initial role/prompt;
- zero or more channel placements.

Codex-ready additions:

- provider first, then dynamically loaded provider model and supported effort;
- coding workspace/working directory;
- understandable permission profile: Observe, Balanced, or Autonomous;
- network policy or advanced permissions behind progressive disclosure;
- provider readiness and authentication feedback inline;
- summary of where the agent will appear and who can message it.

The preferred flow is a focused modal or sheet with sensible defaults, not a
dense inline row of inputs. Successful spawn should open the new DM thread and
show progress from “starting” to “ready.” A failed spawn should retain the form
values and provide an actionable diagnosis.

### 6. Attention and approval inbox

This is required for a polished dual-provider system even though Phase 4 does
not yet expose Codex approvals. Group:

- questions from agents;
- command/file/network/tool approval requests;
- stalled/errored agents;
- usage or authentication problems;
- blocked tasks and lock conflicts.

Each approval card needs agent, conversation, reason, affected command/path or
network destination, risk/scope, elapsed time, and allowed decisions. Decisions
may include allow once, allow for session, decline, cancel, or a provider-
specific safe amendment. Resolved/stale requests should disappear from the
active queue but remain in a compact audit history.

The UI should distinguish “agent is thinking” from “agent is waiting for me.”

### 7. Search

- quick local filter for messages already loaded in the current timeline;
- full-history channel search in a dedicated overlay/panel;
- results with author, snippet, time, channel, addressing/privacy cues, and
  jump-to-message;
- future-friendly global search across channels and DMs, with private results
  clearly marked.

### 8. Settings and diagnostics

Existing preferences to preserve:

- themes: Midnight, Nord, Dracula, Daylight, Solarized;
- message font selection;
- roster sidebar visibility;
- compact messages;
- message number visibility;
- desktop notifications on/off, scope (@mentions or all), and timing
  (background tab or always);
- message chime on/off, scope, and volume;
- dictation engine: local Whisper or browser speech recognition;
- local transcription health and microphone test flow.

System diagnostics:

- database integrity/path/counts;
- background service loaded/running;
- hub reachable and single owner;
- Claude installed/authenticated/version;
- Codex installed/authenticated/version when added;
- provider MCP/Trio tool readiness;
- logs/help actions and concise remediation text.

Diagnostics should be approachable status cards, with raw detail/logs behind an
advanced disclosure.

## Composer requirements

The composer is one of the most important product surfaces.

- Persistent recipient target chips; clicking a roster member can toggle them.
- Clear “broadcast,” public targeted message, or private DM state before send.
- `@name` = direct ping; wakes on normal directed filters.
- `#name` = reference/about; creates a breadcrumb without necessarily waking.
- `!name` = urgent unfilterable bang; visually loud and intentionally harder to
  send casually.
- `@all` and `!all` group addressing.
- Autocomplete for all three sigils with keyboard navigation and visible
  preservation of the chosen sigil.
- Live message preview explaining who will receive/wake from the draft.
- Confirm an accidental untargeted broadcast when multiple agents are present.
- Markdown text with highlighted sigils, resizable height, Enter to send,
  Shift+Enter newline, and draft-loss confirmation on navigation.
- Create a claimable task with `$task <description>`.
- Attach up to eight PNG/JPEG/GIF/WebP images by picker, paste, or drop; show
  upload progress, thumbnails, errors, and remove controls.
- Dictate through local on-device Whisper or browser speech recognition; show
  microphone permission, live waveform, recording, transcription, silence,
  fallback, timeout, and error states. Never leave the microphone active after
  closing the relevant surface.
- Structured question answers use a dedicated picker rather than the normal
  freeform composer.

Current keyboard shortcuts worth preserving or rationalizing:

- Enter send; Shift+Enter newline;
- arrows navigate autocomplete; Tab accepts; Esc dismisses;
- Alt+1…9 toggles target; Alt+A selects all; Alt+0 clears;
- Ctrl/Cmd+B toggles roster;
- paste/drop attaches an image.

## Messaging and coordination features

### Three attention levels

| Signal | Meaning | Visual treatment |
|---|---|---|
| Ambient | Public information for the room | Normal message |
| `@` mention | Direct request or handoff | Accent target chips and notification |
| `#` reference | Talking about someone without interrupting | Muted reference chips |
| `!` bang | Emergency/override that always wakes | High-salience warning treatment |

Agents declare listening mode: All, About (`@` + `#`), or At (`@` only); bangs
always wake. The roster and composer preview should expose when a recipient is
filtering out the proposed message.

### Structured human questions

Agents can ask one or a batch of questions specifically to a human:

- single-select or multi-select option pills;
- optional custom/free-text answers;
- Back/Next paging for batches;
- unanswered validation and jump-to-missing;
- one final Confirm sends the whole answer set;
- target sees interactive controls; everyone else sees read-only pending state;
- answered state locks and highlights selections with respondent identity.

This is the normal alternative to an invisible agent terminal prompt.

### Tasks

Task states:

```text
Open → Claimed → Done
  ↑       │
  └ Released

Blocked → Open when dependencies finish
Open / Claimed / Blocked → Cancelled
```

The UI must represent:

- task number and description;
- open, blocked, claimed, done, cancelled;
- owner/claimant;
- dependency/blocker relationships;
- result or cancellation reason;
- claim, complete, release, and cancel events;
- compact channel-side task view with a path to deeper graph/detail treatment.

### Resource locks

Agents can acquire expiring exclusive locks on named resources such as a file
or build directory. Show locks on member/agent detail and optionally beside
related tasks. Include owner and expiry/renewal state; conflicts are attention
items, not ordinary chat noise.

### Message controls and audit

- author may edit or delete their own message;
- agents can retract an authored rogue/incorrect post while retaining an audit
  marker and reason;
- operator can remove/cull stale channel participants, releasing tasks/locks;
- deleting a durable agent revokes its sessions and placements;
- ending a channel exports its conversation to Markdown;
- destructive actions require clear confirmation and scope.

## Member and agent presence

Presence is richer than online/offline:

- **working:** actively in a turn/tool flow;
- **active:** connected but provider does not expose precise turn state;
- **idle:** connected and waiting;
- **sleeping:** context preserved, runtime parked;
- **stopped:** deliberately halted, resumable;
- **errored:** failed and needs attention;
- **stale/disconnected:** heartbeat lost;
- **blocked:** explicit status or waiting on a dependency/approval.

Do not encode these states by color alone. Use label, icon, tooltip, and motion
sparingly. The existing working state has a breathing pulse; respect reduced-
motion preferences.

The roster can also surface:

- model/provider;
- listening/filter mode;
- skills and self-declared status;
- last read watermark and read acknowledgements;
- message volume, reply behavior, queue depth, and recent activity;
- held locks and task ownership;
- remove-member action for trusted operator only.

## Runtime activity layer

Conversation content and runtime telemetry must be separate.

For Claude, available signals include process state, Trio tool activity,
turn/activity hooks, session ID, stderr tail, and final result.

For Codex, the future adapter can expose:

- streamed agent draft;
- current plan and plan progress;
- command execution and output;
- file changes and aggregate diff;
- MCP calls;
- web search and image inspection;
- approvals;
- turn usage, warnings, interruption, failure, and completion;
- queued incoming messages and urgent steering.

Prototype this as an agent activity drawer/timeline or inspector, not as dozens
of system messages in the channel. Provide a concise live summary in the agent
row (“running tests,” “editing 3 files,” “waiting for network approval”) with
expandable detail.

Never show raw private reasoning as normal product content. Readable plan/status
summaries are appropriate; hidden reasoning is not a UI requirement.

## Important empty, loading, and failure states

Prototype these intentionally:

- first launch with no channels and no agents;
- channel with no messages;
- agent with no public placements but a working DM inbox;
- no DMs yet;
- no search results;
- reconnecting SSE versus fully offline;
- background service not installed/not running;
- provider missing or not authenticated;
- provider ready but Trio MCP unavailable (“agent would be deaf”);
- agent spawning slowly;
- agent waking from hibernation;
- message queued behind an active turn;
- agent waiting for an approval/question;
- agent crashed with actionable error;
- send/upload/transcription failure with draft retained;
- stale member and abandoned agent;
- ended/deleted/unknown channel;
- guest pending identity and guest-restricted view;
- usage/rate-limit problem.

## Responsive behavior

Desktop is the primary control-room experience, but the app should remain useful
on a phone over a secure local/Tailscale connection.

- Desktop: persistent workspace rail, main conversation, optional context
  sidebar; drawers for agent details/settings/attention.
- Tablet: collapsible rail and overlaid context drawer.
- Phone: one pane at a time; channel/DM/agent navigator as a drawer; sticky
  conversation header and composer; large touch targets; no hover-only actions.
- Preserve drafts and scroll state when drawers open/close.
- The current compact channel picker can remain as a narrow-layout fallback.

## Accessibility requirements

- Full keyboard navigation and visible focus states.
- Semantic buttons rather than clickable spans in the polished build.
- Labels for icon-only controls and clear destructive-action wording.
- Screen-reader announcements for new messages, state changes, approval
  requests, upload/transcription results, and connection loss without reading
  the entire live stream.
- Do not depend on color, animation, or emoji alone.
- Respect reduced motion and system theme; maintain strong contrast in every
  supplied theme.
- Structured questions, autocomplete, menus, tabs, drawers, dialogs, and
  notifications need correct focus trapping/restoration and ARIA semantics.

## Visual direction

Aim for “calm professional team room” rather than cyberpunk agent dashboard.

- Keep normal conversations spacious and familiar.
- Use compact, consistent status chips for provider/model/state.
- Let attention color carry meaning: unread/mention, warning/approval, error,
  success—not decorative rainbow noise.
- Agent cards should feel like teammates, with runtime telemetry as a secondary
  layer.
- Clearly separate public channel, private DM, and operator-only runtime data.
- Prefer a strong information hierarchy and progressive disclosure over the
  current header's many persistent pills.
- Preserve the option for dense monospace presentation, but do not make the
  entire product look like a terminal.

## Prototype scenarios to deliver

At minimum, provide connected desktop flows for:

1. Fresh install → empty workspace → create first channel.
2. Spawn a Claude agent → progress → private welcome DM → public placement.
3. Send an @mention with an image → agent works → posts a reply.
4. Agent asks a three-question batch → human answers → completed state.
5. Two agents claim coordinated tasks and show a resource lock conflict.
6. Agent becomes idle → hibernates → wakes from a DM with context preserved.
7. Compact context, then Clear context with clear distinction and confirmation.
8. Agent error and provider authentication/MCP health remediation.
9. Unified DM inbox including a visible Agent ↔ Agent audit thread.
10. Full-history search and jump to a message.
11. Dictation recording → transcription → editable draft.
12. Codex-ready spawn flow with dynamic model/effort, workspace, permission
    profile, structured activity, queued turn, and approval request.
13. Mobile channel/DM navigation and roster drawer.

Also provide component states for every presence status, message addressing
type, task state, approval decision, and runtime health state.

## Backend realities the prototype must respect

- The hub is persistent and independent of the browser.
- The current backend is a local stdlib Python HTTP/SSE server with SQLite.
- Channels are selected per request; one hub serves all channels.
- The operator is all-seeing on loopback; guests have narrower single-channel
  access and cannot manage agents.
- Messages use global numeric IDs, so gaps inside one channel are normal.
- DMs are ordinary messages with recipient sets; privacy applies equally to
  text and attachment bytes.
- Managed agents have a hidden system inbox and can exist with no public
  placement.
- One durable agent spans all of its channels in one context; inbound prompts
  carry source channel tags.
- Ambient messages do not wake sleeping agents; directed signals and DMs do.
- Explicit agent MCP posts are preferred; a final runtime response is bridged
  only when the agent did not post, preventing duplicates.
- Only one unified hub may own supervision. Legacy single-channel views are
  viewers, not additional process owners.
- Claude currently uses one process per agent. Codex should use one shared App
  Server with one thread per agent, so per-agent PID is not a universal concept.
- Codex allows one active turn per thread; incoming messages may be queued or
  explicitly steered into the active turn.

## Scope boundaries

Current product claim:

- single-user local workspace;
- managed Claude agents;
- external terminal agents can coexist;
- optional secure Tailscale access exists through the wider nth/quartet system.

Near-term planned:

- managed Codex agents;
- provider-neutral agent creation and lifecycle;
- approvals/attention inbox;
- richer structured activity/usage UI.

Do not imply yet:

- multi-tenant SaaS administration;
- private DMs hidden from the trusted local operator;
- arbitrary remote internet exposure;
- identical lifecycle mechanics for every provider;
- unlimited concurrent subscription usage.

## Success criteria for the polished prototype

The prototype succeeds when a new user can, without reading technical docs:

- understand that the app contains conversations and persistent AI teammates;
- create a channel and an agent;
- know whether a message is public, targeted, urgent, or private before send;
- see when an agent is working versus waiting for them;
- find and answer every attention item;
- sleep/wake/compact/clear an agent without confusing those actions;
- inspect runtime details when something goes wrong without those details
  dominating ordinary chat;
- move comfortably between many channels, DMs, and agents in one window;
- use the essential flow on desktop and phone.

Implementation behavior and current acceptance details are documented in
`QA-unified-interface.md`. The proposed Codex runtime architecture is in
`proposals/codex-runtime-integration.md`.

