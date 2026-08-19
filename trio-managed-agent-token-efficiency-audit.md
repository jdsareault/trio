# Trio Managed-Agent Token Efficiency Audit

**Date:** 2026-08-19  
**Scope:** Trio Agent Manager message routing and managed Codex sessions

## Executive summary

The current Agent Manager architecture is already substantially more token-efficient than the older per-agent monitor design.

The important change is that **idle managed agents no longer need to poll Trio through the model**. Trio's hub runs a single lightweight SQLite polling loop (`AgentRouter`) and pushes matching messages into provider sessions. An idle Codex agent therefore consumes effectively **zero model tokens just waiting for Trio messages**.

The remaining token inefficiencies are mostly caused by how incoming messages become Codex turns and by some stale managed-agent instructions.

### Recommended priority

1. **Remove managed-agent instructions telling agents to monitor/poll Trio.**
2. **Use Codex `turn/steer` for appropriate messages that arrive while a turn is active.**
3. **Let normal Codex final responses be bridged to Trio automatically instead of requiring `trio_send`.**
4. **Batch compatible queued messages instead of creating one new turn per message.**
5. **On wake/resume, inject only changed credentials rather than the full Trio preamble.**
6. **Make the initial “say hello” model turn optional or eliminate it.**

The first change is extremely low-risk and easy. The third is also potentially quite small, although it should be tested carefully because it changes the expected messaging convention.

There is **no urgent token-efficiency problem that requires changing the system now**. The current router already eliminates the largest waste: model-based polling while agents are idle.

---

# Current message architecture

For a managed Codex agent, the normal path is approximately:

```text
Human or agent posts a Trio message
        ↓
SQLite messages table
        ↓
AgentRouter polls SQLite
        ↓
Wake-policy filtering
        ↓
provider.feed(agent, message)
        ↓
CodexRuntime.feed()
        ↓
Codex App Server turn
        ↓
Codex works
        ↓
Final Codex response
        ↓
Trio bridges response into the originating channel/DM
```

The important distinction is:

```text
OLD CONCEPT

Each agent/model:
    poll Trio
    poll Trio
    poll Trio
    ...

Each poll can involve model/tool activity.


CURRENT AGENT MANAGER

One Trio Python process:
    poll SQLite
    poll SQLite
    poll SQLite
    ...

Only wake a model when a relevant message exists.
```

The SQLite polling itself has essentially no model-token cost.

---

# Current efficiency by component

| Component | Token efficiency | Notes |
|---|---|---|
| Hub SQLite polling | Excellent | No model inference involved |
| Idle managed agents | Excellent | No periodic Codex polling required |
| Wake-policy filtering | Excellent | Prevents most irrelevant agent wakeups |
| Agent-to-agent loop prevention | Excellent | Ambient agent messages do not automatically wake other agents |
| Message delivery to idle Codex | Good | One real turn for one relevant message |
| Message delivery to busy Codex | Fair | Messages are queued and can become separate turns |
| Normal reply transport | Fair | Managed-agent prompt encourages an MCP send even though Trio can bridge final output |
| Wake/resume context | Fair | Full Trio preamble may be reinjected |
| Agent creation | Fair | Unconditional startup/hello turn |

---

# Wake policies and loop prevention

The wake-policy system is an important part of Trio's token efficiency.

For most workers, the default `at` behavior is appropriate:

- `at`: wake on explicit addressing
- `about`: broader relevance-based wake behavior
- `all`: wake for general human room traffic

A particularly important safeguard is that ambient **agent-generated** traffic does not automatically wake other managed agents. Agent-to-agent wakeups require explicit addressing such as an `@mention`, bang, or DM.

Without this rule, two broadly subscribed agents could repeatedly wake one another:

```text
Agent A says something
    ↓
Agent B wakes and replies
    ↓
Agent A wakes and replies
    ↓
...
```

Every hop could become another real model turn.

### Recommendation

Keep `at` as the normal default.

Use `all` only where broad awareness is actually part of the agent's job.

---

# Improvement 1: remove stale monitor/poll instructions

## Current issue

The managed-agent preamble still tells agents to keep a monitor/poll on their Trio inbox and references tools such as:

```text
trio_connect
trio_send
trio_poll
```

That instruction reflects the older architecture.

The Agent Manager now pushes relevant messages into the managed provider session itself. A managed Codex agent should not need to periodically call `trio_poll` to discover new messages.

This creates a conflict:

```text
Actual system:
AgentRouter pushes messages to Codex.

Managed-agent prompt:
Codex is told to poll for messages.
```

If the model follows the stale instruction literally, it can reintroduce exactly the model/tool overhead the AgentRouter was intended to eliminate.

## Recommended change

Change the managed-agent instructions to something conceptually like:

```text
Incoming Trio messages are delivered to your session automatically.

Do not poll Trio for new messages during normal operation. Use Trio
history/polling tools only when you specifically need earlier channel
history that was not delivered to the session.
```

## Expected impact

- Removes possibility of unnecessary model-driven polling.
- Simplifies the mental model for managed agents.
- Very low implementation complexity.
- Very low behavioral risk.

## Priority

**Highest / easiest.**

This is the clearest low-hanging fruit.

---

# Improvement 2: use Codex `turn/steer` for active agents

## Current issue

When a Codex agent is idle, a message appropriately starts a new turn.

When the agent is already working, Trio currently queues incoming messages. When the current turn ends, queued messages can each become another `turn/start`.

Example:

```text
Current Codex turn:
    Fix the authentication bug.

Messages arrive while it works:
    1. Don't change the public API.
    2. Check the failing Android test first.
    3. It only reproduces on Android.
```

The current behavior can effectively become:

```text
Turn 1: original task
Turn 2: message 1
Turn 3: message 2
Turn 4: message 3
```

This is inefficient in two ways:

1. More logical Codex turns are created than necessary.
2. Important corrections may arrive too late to affect work already underway.

## Codex already has a better primitive

Codex App Server supports:

```text
turn/steer
```

This allows new user input to be incorporated into an already-running turn rather than waiting for another `turn/start`.

That is a close match for interactive behavior: if the operator sends an important correction while Codex is working, Codex can incorporate it into the current task.

## Recommended policy

A reasonable initial policy:

```text
Agent idle
    → turn/start

Agent busy + direct/high-priority input
    → turn/steer

Agent busy + ordinary/non-urgent traffic
    → queue

Current turn finishes
    → process queued traffic, preferably batched
```

Likely candidates for steering:

- direct human DM
- explicit `@agent` mention
- bang/interrupt-style message
- possibly any direct operator message to that agent

Messages that are merely informational could remain queued.

## Expected impact

Potentially significant when users interact with agents during long-running tasks.

Benefits are not limited to token savings. Steering also reduces wasted work because corrections can affect the current turn before it completes.

## Priority

**High.**

This is probably the most valuable behavioral optimization, but it requires more design thought than removing the stale polling instruction.

---

# Improvement 3: do not require `trio_send` for ordinary replies

## Current issue

The managed-agent preamble encourages Codex to reply through Trio MCP tools.

That means a normal exchange can become:

```text
User message
    ↓
Codex inference/work
    ↓
trio_send(...)
    ↓
MCP tool result
    ↓
Codex continues/finishes
```

However, Trio's Codex runtime already has response-bridging behavior. If Codex simply returns a normal final response, Trio can insert that response into the originating channel or DM.

Therefore the ordinary request/reply case does not necessarily require a Trio MCP tool invocation.

## Recommended behavior

For the message that triggered the current turn:

```text
Return the answer normally.
Trio will deliver the final response to the originating channel or sender.
```

Reserve `trio_send`, `trio_dm`, etc. for cases where the agent actually needs messaging semantics:

- proactively contacting another agent
- sending to another channel
- sending an intermediate update before the task finishes
- messaging someone other than the originator
- posting multiple messages to different destinations

## Expected impact

Possible savings per ordinary turn:

- one MCP call
- one MCP result
- associated model-visible tool context
- possible extra inference continuation

The absolute savings per interaction may be modest, but this happens on the common path and could accumulate.

## Risks / things to test

The response bridge needs to remain reliable for:

- public channels
- direct messages
- messages initiated by another agent
- turns where the agent also intentionally uses `trio_send`
- preventing duplicate messages when both MCP and final-response bridging occur

## Priority

**High-medium.**

Potentially small code change, but test the routing semantics before treating it as trivial.

---

# Improvement 4: batch compatible queued messages

## Current issue

If multiple messages arrive while a Codex agent is busy, processing them one-by-one can create several unnecessary turns.

Example:

```text
Message A → new turn
Message B → new turn
Message C → new turn
```

For bursty human interaction, those messages frequently belong together.

## Recommended behavior

Coalesce compatible queued messages:

```text
Three messages arrived while you were working:

[#dev] JD: Don't change the public API.
[#dev] JD: Check the Android test first.
[#dev] JD: The failure only happens on Android.
```

Then start one turn for the batch.

## Compatibility rules

Start conservatively. Batch only messages that share routing semantics, for example:

- same managed agent
- same channel
- compatible sender/reply destination

For DMs, it may be safest to batch only messages from the same sender.

This matters because Trio must know where the final response belongs.

## Interaction with `turn/steer`

Ideally:

```text
Important active-task update
    → steer immediately

Ordinary traffic while busy
    → queue

Several compatible queued items
    → coalesce

Turn finishes
    → one new turn for the batch
```

## Priority

**Medium.**

Useful after steering behavior is defined.

---

# Improvement 5: reduce context injected on wake/resume

## Current behavior

Trio appropriately uses Codex thread resume semantics so a hibernated agent can continue the same conversation.

However, Trio also rotates the agent's reclaim credential. The resumed thread therefore needs updated credential information.

The current implementation can inject the full freshly generated Trio preamble into the existing thread.

Over repeated sleep/wake cycles, this can produce duplicated context:

```text
Original Trio instructions

...conversation...

Full Trio instructions again

...conversation...

Full Trio instructions again
```

Most of that text is unchanged.

## Recommended change

Inject only the delta that changed:

```text
Trio session resumed.

Your Trio reclaim credential has been refreshed:

<new credential>

Reconnect/reclaim your existing identity using this credential.
All other Trio operating instructions remain unchanged.
```

Do not weaken credential rotation merely to save tokens.

## Expected impact

Probably modest for short-lived agents.

More meaningful for persistent agents that repeatedly hibernate and resume.

## Priority

**Medium-low.**

Worth doing, but not urgent.

---

# Improvement 6: make the startup “say hello” turn optional

## Current behavior

Creating a managed agent triggers an initial model message telling it to connect and announce itself.

That consumes a real model turn before the agent has received useful work.

## Better options

Possible designs:

### Option A — lazy initialization

Do not generate a model turn until the first real task/message arrives.

Include any required startup/connect instructions with that first turn.

### Option B — optional announcement

Expose:

```text
Announce on startup: yes/no
```

Default to off for worker agents.

### Option C — non-model registration

If all required Trio registration can happen programmatically, establish the connection without asking the model to do it.

## Expected impact

Minor for a few long-lived agents.

Potentially noticeable when frequently creating short-lived workers.

## Priority

**Low-medium.**

Simple savings, but less important than active-turn behavior.

---

# Trio versus using Codex directly

## Single-agent task

For one focused task, direct Codex should generally be the most token-efficient route.

```text
Direct Codex

User
  ↓
Codex
  ↓
Tools/work
  ↓
Answer
```

Trio adds additional orchestration context:

```text
Trio

User
  ↓
Trio router/database
  ↓
Codex
  ↕
Trio MCP / messaging semantics
  ↓
Trio response bridge
  ↓
User
```

The router/database itself is effectively free from a token perspective.

The model-visible overhead comes from:

- Trio-specific instructions
- Trio MCP tool definitions and calls
- coordination messages
- additional turns caused by routed messages
- startup/wake instructions
- communication between agents

Therefore:

> For “give Codex this coding task and let it work,” direct Codex is the leaner interface.

---

# Where Trio earns the overhead

Trio becomes useful when the desired workflow is not equivalent to one interactive Codex session.

Examples:

- multiple persistent workers
- independently addressable agents
- long-running agents that may sit idle
- channels and DMs
- cross-agent coordination
- provider mixing
- persistent agent workspaces
- operator control through a shared UI
- ability to message an agent while another task/session is active

The current Agent Manager architecture is particularly good for long-lived agents because **idle time itself is cheap**.

An agent can exist for hours without repeatedly spending tokens checking whether someone has messaged it.

---

# Multi-agent token economics

Multi-agent systems are not inherently token-saving.

If three agents independently reason about a problem, each has its own:

- context
- reasoning
- tool calls
- outputs

That naturally costs more than one agent.

The expensive pattern is conversational ping-pong:

```text
Coordinator → Worker
Worker → Coordinator
Coordinator → Worker
Worker → Coordinator
...
```

Each message can wake another model turn.

The preferred pattern for cost efficiency is:

```text
Coordinator → Worker:
    Complete, bounded assignment.

Worker:
    Works independently.

Worker → Coordinator:
    Consolidated result.
```

Use agent-to-agent messaging for meaningful handoffs rather than continuous conversation.

---

# Suggested implementation sequence

## Phase 1 — trivial cleanup

### 1. Remove managed-agent poll/monitor instructions

Goal:

```text
Managed agents should understand that incoming messages are pushed
into their session automatically.
```

This is the safest immediate change.

### 2. Review normal-reply instructions

Change the prompt so agents can return a normal final response rather than always using `trio_send`.

Test routing thoroughly before merging.

---

## Phase 2 — improve active-agent messaging

### 3. Add `turn/steer`

Define which incoming message types should steer an active turn.

Suggested initial rule:

```text
DM / explicit human mention / bang
    → steer
```

Keep ordinary ambient traffic queued.

### 4. Batch queued traffic

Group compatible queued messages before starting another turn.

---

## Phase 3 — context cleanup

### 5. Replace full resume preamble with a credential delta

Preserve credential rotation.

Only inject changed state.

### 6. Remove or make optional the startup hello turn

Prefer lazy initialization for worker agents.

---

# Measurement plan

Do not rely only on intuition. The Codex runtime already tracks usage information, so compare the same workflow before and after changes.

Useful metrics:

- number of Codex turns
- number of upstream model requests
- input tokens
- cached input tokens
- uncached input tokens
- output tokens
- reasoning tokens, if exposed
- Trio MCP call count
- number of messages delivered through response bridging
- number of queued messages
- number of steered messages

A useful test scenario:

```text
1. Create one Codex agent.
2. Give it a moderately long coding task.
3. Send 3–5 follow-up messages while it is working.
4. Include:
   - one correction
   - one extra constraint
   - one informational note
5. Let it complete.
6. Send another independent task.
7. Hibernate and resume it.
8. Send one final task.
```

Run the same scenario before and after each optimization.

The most revealing comparison will likely be:

```text
Current:
queued messages → multiple turn/start calls

Modified:
direct updates → turn/steer
remaining queue → one batched turn/start
```

---

# What is worth doing immediately?

There is no urgent architectural problem.

The current Agent Router has already solved the major token-efficiency issue: **idle managed agents do not need model-driven polling**.

If making only one change now, make this one:

> **Remove the stale managed-agent instruction telling Codex to monitor/poll its Trio inbox.**

It is low effort, low risk, and aligns the prompt with the architecture that is already running.

The next change worth doing when actively working on Trio is `turn/steer`. That is more consequential and deserves focused implementation/testing rather than being slipped in casually.

The other optimizations can safely wait until a dedicated token-efficiency pass.
