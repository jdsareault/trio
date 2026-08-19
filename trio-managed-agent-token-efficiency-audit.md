# Trio Managed-Agent Token Efficiency Audit

**Date:** 2026-08-19
**Scope:** Trio Agent Manager message routing and managed Codex sessions
**Status:** reviewed against the code and against the Codex App Server protocol
schema generated from `codex-cli 0.147.0`. Claims below are marked
**[verified]**, **[corrected]**, or **[unverified]**.

## Executive summary

The current Agent Manager architecture is already substantially more
token-efficient than the older per-agent monitor design.

The important change is that **idle managed agents no longer need to poll Trio
through the model**. Trio's hub runs a single lightweight SQLite polling loop
(`AgentRouter`) and pushes matching messages into provider sessions. An idle
Codex agent therefore consumes effectively **zero model tokens just waiting for
Trio messages**. **[verified]** — `AgentRouter.run()` holds one long-lived
connection and polls `messages` by id; nothing in either runtime spends a model
turn while idle.

The remaining token inefficiencies are mostly caused by how incoming messages
become Codex turns and by some stale managed-agent instructions.

There is **no urgent token-efficiency problem that requires changing the system
now**. The current router already eliminates the largest waste: model-based
polling while agents are idle.

### Recommended priority

Reordered from the first draft. Two items moved because the original ranking
mixed *token cost* with *behavioural value*, and one item was promoted because
it fires far more often than first assumed.

| # | Change | Why here |
|---|---|---|
| 1 | **Make `_bridge_result` parse sigils.** | Correctness fix. Prerequisite for #3. Cheap. |
| 2 | **Remove managed-agent instructions telling agents to monitor/poll Trio.** | Lowest risk, aligns prompt with architecture. |
| 3 | **Let normal Codex final responses be bridged instead of requiring `trio_send`.** | Largest per-turn saving on the common path. Blocked on #1. |
| 4 | **Batch compatible queued messages instead of one turn per message.** | The only item that *provably* removes turns. Self-contained. |
| 5 | **On wake/resume, inject only changed credentials rather than the full preamble.** | Fires on every automatic hibernate/wake cycle. Also a context-quality fix. |
| 6 | **Make the initial "say hello" turn optional or eliminate it.** | One turn per agent creation. Cheap, bounded. |
| 7 | **Use Codex `turn/steer` for messages arriving mid-turn.** | Real value, but it is a *wasted-work* fix more than a token fix, and it has the highest implementation cost of the seven. |

If making only one change now, make #2 — but note that #1 is a bug that already
exists on the fallback path, independent of any prompt change.

### Scope note

**Improvements 4 and 7 are Codex-only.** The Claude supervisor's `feed()` writes
straight to the process stdin and `queued_count()` is hardcoded to `0` — there
is no Claude-side queue to batch and no turn boundary to steer around. Claude
already behaves the way #7 wants Codex to behave. Improvements 1, 2, 3, 5 and 6
touch shared code or both providers.

---

# Current message architecture

For a managed Codex agent, the normal path is approximately:

```text
Human or agent posts a Trio message
        ↓
SQLite messages table
        ↓
AgentRouter polls SQLite            ← nth_web.AgentRouter.tick()
        ↓
Wake-policy filtering               ← AgentRouter._targets()
        ↓
provider.feed(agent, message)       ← UnifiedAgentSupervisor.feed()
        ↓
CodexRuntime.feed()                 ← queues if busy, else turn/start
        ↓
Codex App Server turn
        ↓
Codex works
        ↓
Final Codex response
        ↓
Trio bridges response into the originating channel/DM   ← _bridge_result()
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
| Message delivery to busy Codex | Fair | Messages are queued and drain one-per-turn |
| Normal reply transport | Fair | Managed-agent prompt encourages an MCP send even though Trio can bridge final output |
| Wake/resume context | Fair | Full preamble *plus operator base_prompt* is reinjected |
| Per-wake channel reconnect | Fair | `trio_connect` takes one channel per call, so N+1 MCP round trips per wake |
| Agent creation | Fair | Unconditional startup/hello turn |

---

# Wake policies and loop prevention

The wake-policy system is an important part of Trio's token efficiency.

For most workers, the default `at` behavior is appropriate:

- `at`: wake on explicit addressing
- `about`: broader relevance-based wake behavior
- `all`: wake for general human room traffic

A particularly important safeguard is that ambient **agent-generated** traffic
does not automatically wake other managed agents. Agent-to-agent wakeups require
explicit addressing such as an `@mention`, bang, or DM. **[verified]** —
`_targets()` short-circuits ambient modes when `sender_is_agent`, and fails
*closed* (treats every sender as an agent) if it cannot read the roster.

Without this rule, two broadly subscribed agents could repeatedly wake one
another:

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

Keep `at` as the normal default. Use `all` only where broad awareness is
actually part of the agent's job.

**This safeguard is load-bearing for Improvement 3.** See the note there:
explicit addressing is the *only* thing that wakes a peer agent, and explicit
addressing is exactly what the bridge currently fails to record.

---

# Improvement 1: make `_bridge_result` parse sigils

**New item, not in the first draft. This is a bug that exists today.**

## Current issue

`nth_send` resolves `@name` / `#name` / `!name` against the channel roster
server-side and writes three sibling arrays (`mentions`, `refs`, `bangs`) onto
the message row.

`_bridge_result` does not. It writes `mentions` as the *recipients* list — which
is empty for any public channel — and never writes `refs` or `bangs` at all.

`AgentRouter._targets()` wakes a peer agent only when that agent's id appears in
`bangs`, `recipients`, or `mentions`.

Composed, that means:

```text
Agent posts "@peer over to you" via trio_send
    → mentions=[peer]  → peer wakes                      ✅

Agent ends its turn with "@peer over to you" (bridged)
    → mentions=""      → peer is never woken             ❌
```

The same gap suppresses human-side `@`-mention highlighting and notification for
every bridged message, and makes `!bang` unreachable from a bridged reply.

## Why it matters now

Today the bridge is a *fallback*, so the blast radius is limited to turns where
the agent happened not to call `trio_send`. Improvement 3 promotes the bridge to
the **primary reply path**, which promotes this from an edge case to the common
case. Do not ship #3 before this.

## Implementation notes

- The parser is already factored out precisely so two call sites can share it —
  the comment above it says a DM that wakes a different set of people than the
  same text in a channel "would be a bug nobody would find by reading either
  function alone." That is the bug, one layer down.
- Be careful with the inbox case: `_bridge_result` currently overloads the
  `mentions` column to carry recipients for `#agent-inbox`. Parsed sigils and
  DM recipients need to coexist rather than one clobbering the other.
- `_bridge_result` runs on the Codex notification executor and is already
  wrapped so a failure cannot strand the turn. Keep it that way — adding a
  roster query here must not become a path that raises out of `turn/completed`.
- Check whether the Claude supervisor's equivalent bridge has the same gap.
  Both providers feed the same `messages` table.

## Priority

**Highest.** Correctness, small, and unblocks #3.

---

# Improvement 2: remove stale monitor/poll instructions

## Current issue

`build_agent_preamble` still tells agents to keep a monitor/poll on their Trio
inbox — literally `"Keep a monitor/poll on that inbox while working in public
channels"` — and describes channel interaction as
`(trio_connect / trio_send / trio_poll)`.

That instruction reflects the older architecture. The Agent Manager now pushes
relevant messages into the managed provider session itself, **including private
inbox messages** — `AgentRouter._worker_loop` special-cases
`AGENT_INBOX_CHANNEL` and prefixes the fed text with a reply-privately
instruction. A managed agent has no reason to poll for them.

```text
Actual system:
AgentRouter pushes messages to Codex (and to Claude).

Managed-agent prompt:
The agent is told to poll for messages.
```

## Corrected impact estimate

The first draft said a literal reading "can reintroduce exactly the model/tool
overhead the AgentRouter was intended to eliminate." **[corrected]** — that
overstates it. Both runtimes are turn-based, so an agent cannot poll in a loop
across turns; it can only burn one `trio_poll` per turn, and a default
`wait_seconds` poll will also block that turn for up to 15s. Real, bounded,
worth removing — but do not expect a dramatic number.

## Recommended change

Replace the polling instruction with something conceptually like:

```text
Incoming Trio messages are delivered to your session automatically.

Do not poll Trio for new messages during normal operation. Use Trio
history/polling tools only when you specifically need earlier channel
history that was not delivered to the session.
```

Keeping the escape hatch matters: an `at`-mode agent genuinely never sees
ambient channel traffic, so "go read the room" has to remain possible on demand.

## Implementation notes — regression trap

**Do not touch the `nsup.AGENT_ID_MARKER` sentence.** `build_agent_preamble`
embeds `"Your Trio member_id is {agent_id}"`, and `pid_owns_agent()` greps that
exact phrase out of the **Claude process argv** to decide process ownership.
Rewording or dropping it stops every running Claude agent from being recognised
as itself, which is how a second hub spawns a duplicate. There are already two
comments in the tree warning about this; heed them.

Also note the preamble is shared by both providers, so any wording change lands
on Claude agents too. That is fine here — Claude agents are push-fed by the same
router — but it means the change should be reasoned about for both.

## Priority

**High.** Clearest low-hanging fruit; very low behavioural risk.

---

# Improvement 3: do not require `trio_send` for ordinary replies

## Current issue

The managed-agent preamble encourages Codex to reply through Trio MCP tools, so
a normal exchange becomes:

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

Trio's Codex runtime already bridges a plain final response into the originating
channel or DM (`_bridge_result`), so the ordinary request/reply case does not
require an MCP invocation at all.

## Good news: duplicate suppression already exists

The first draft listed "preventing duplicate messages when both MCP and
final-response bridging occur" as a risk to test. **[verified — already
handled]** `_bridge_result` opens with an `already_posted` check: if this agent
has posted anything in that channel since the turn's `baseline`, the bridge
no-ops. `baseline` is deliberately re-established at *execution* time in
`_start_turn`, not at enqueue time, so a message that waited in the queue is not
suppressed by a previous turn's reply.

## Corrected savings estimate

The first draft called the per-turn saving "modest." **[corrected — probably
larger]** The MCP tool *definitions* are loaded either way (the runtime pins
`enabled_tools` and `required=true` at App Server launch), so those are sunk.
What you actually save is a tool-call round trip, which in practice is one more
upstream API request that re-sends the whole turn context. Per-turn that is
meaningful; on the common path it accumulates. It is also visible in the
existing telemetry as a drop in `requests` per turn.

## Risks / things to test

- **Blocked on Improvement 1.** Without sigil parsing on the bridge, this change
  silently breaks agent-to-agent addressing and human `@`-mention notification.
- **The audit's own carve-out collides with the suppression rule.** The first
  draft suggested reserving `trio_send` for, among other things, "an intermediate
  update before the task finishes." An intermediate `trio_send` posts a message
  after `baseline`, which makes `already_posted` true, which **discards the
  final response entirely**. Either the guidance has to drop that case, or the
  suppression rule needs to distinguish an interim post from the turn's answer.
  Pick one deliberately; do not leave it implicit.
- **Silence becomes impossible.** The bridge fires on every completed turn with
  non-empty text. Under the current prompt an agent chooses to speak by calling
  `trio_send`; under the new prompt anything it says at the end of a turn is
  published. For `all`/`about` wake-mode agents that turns "nothing to do here"
  into channel noise. It costs no peer wakeups (ambient agent traffic does not
  wake anyone) but it does cost human attention, which the project treats as a
  first-class cost. Consider whether the prompt needs an explicit "if there is
  nothing worth saying, say nothing" convention, and whether the bridge should
  respect it.
- Only the **last** `agentMessage` of a turn is retained (`_turn_text[turn_id]`
  is overwritten on each `item/completed`), so a turn that produces two distinct
  answers bridges one. Fine for ordinary single-answer turns; relevant to #7.
- Test matrix: public channel, DM via `#agent-inbox`, message initiated by
  another agent, and a turn that intentionally uses `trio_send` anyway.

## Priority

**High** — but strictly after #1.

---

# Improvement 4: batch compatible queued messages

## Current issue

**[verified]** `feed()` appends to a per-agent deque while the agent is
`_active` / `_starting` / `_compacting`. `_worker_loop` pops exactly **one**
context per drain, and `turn/completed` enqueues exactly one drain — so the
queue drains strictly one message per turn.

```text
Message A → new turn
Message B → new turn
Message C → new turn
```

For bursty human interaction those messages frequently belong together. Note
this also applies to an *idle* agent: a single `AgentRouter.tick()` can enqueue
several matching messages, the first starting a turn and the rest queuing behind
it.

## Recommended behavior

Coalesce compatible queued messages into one turn:

```text
Three messages arrived while you were working:

[#dev] JD: Don't change the public API.
[#dev] JD: Check the Android test first.
[#dev] JD: The failure only happens on Android.
```

## Compatibility rules

Start conservatively. The binding constraint is that Trio must know where the
turn's single final response belongs, so batch only messages that share reply
routing:

- same managed agent
- same channel
- for `#agent-inbox`, additionally the same `source_sender`

## Implementation notes

- This is the most self-contained item on the list: the queue is a per-agent
  deque and the change lives in `_worker_loop` plus the input construction in
  `_start_turn`.
- The per-message `[#channel] Name: text` tagging is what lets the agent
  attribute the batch; keep it per message rather than tagging the batch once.
- A batched turn covers several source messages, so the single
  `source_message_id` / `source_sender` fields on the turn context no longer
  describe it. Decide what they mean for a batch before writing the merge.
- `hibernate()` deliberately preserves the queue (`keep_queue=True`) because
  `feed()` already reported those messages as delivered, and `wake()` re-drains
  them. `reconcile()` also pushes an interrupted turn's context back onto the
  *front* of the queue. Batching must not reorder across either path.
- Watch the `baseline` semantics: a batch has one baseline, established when the
  batched turn actually starts. That is the correct behaviour, but it means the
  suppression window now spans several source messages.

## Priority

**Medium-high.** Promoted above `turn/steer`: it is the only change that
demonstrably removes turns, and it does not require new protocol surface.

---

# Improvement 5: reduce context injected on wake/resume

## Current behavior

Trio uses Codex thread resume semantics so a hibernated agent continues the same
conversation, and rotates the agent's reclaim credential on every wake. Because
`thread/resume` takes no prompt, `CodexRuntimeManager.wake()` delivers the fresh
preamble via `thread/inject_items` as a user message.

**[verified, and worse than the first draft stated]** — `wake_agent()` builds
`base_prompt + "\n\n" + build_agent_preamble(...)`, so what gets injected into
the live thread on every wake is the full preamble *plus the operator's entire
base prompt*.

Over repeated sleep/wake cycles:

```text
Original instructions + base_prompt

...conversation...

Full instructions + base_prompt again

...conversation...

Full instructions + base_prompt again
```

Nearly all of that text is unchanged. Only the reclaim secret differs.

## Related, and in the same workstream: per-wake reconnect cost

`nth_connect` takes **one channel per call**, and the preamble instructs the
agent to reclaim its identity on each of its channels — public channels plus the
private inbox. A three-channel agent therefore makes four MCP round trips on
every spawn *and* every wake. That is the same order of cost as the preamble
duplication above and belongs in the same pass.

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

## Implementation notes — regression trap

**The delta must be a separate string used only on the Codex inject path.**
`wake_agent()` is provider-neutral: the same `system_prompt` it builds becomes
Claude's `--append-system-prompt` argv, and that argv is where
`pid_owns_agent()` looks for `AGENT_ID_MARKER`. Trimming the shared preamble —
or trimming inside `wake_agent()` itself — strips the ownership marker from
Claude's command line, `foreign_owner_pid()` starts returning `None`, and a
second hub will spawn a duplicate process. Add a distinct wake-time payload
rather than shortening the thing that reaches argv.

Two more constraints:

- `wake()` treats a failed injection as a failed wake and returns `None`, on the
  reasoning that an agent that cannot authenticate should not be stamped
  running. Preserve that.
- `clear()` intentionally *does* want the full preamble — it starts a fresh
  context. Only `wake()` should get the delta.

## Corrected priority

**Medium** — promoted from medium-low. Hibernation is automatic via the idle
reaper, with no operator action, so for any long-lived agent this fires
repeatedly. It is also a context-*quality* fix, not only a cost one: three
copies of startup instructions in one thread is three chances to follow a stale
one.

---

# Improvement 6: make the startup "say hello" turn optional

## Current behavior

**[verified]** After a successful create-and-place, the handler unconditionally
feeds `"You are online — connect to your channels and say hello."` The inline
comment explains why it exists: a stream-json agent is request/response, so it
needs a first message to act on. The *connect* instructions themselves are
already in the preamble; this feed is purely a trigger.

## Cheaper than the first draft assumed

**[verified]** The create handler inserts the `members` and `agent_channels`
rows itself, and `nth_send`'s `session_token` check is explicit about tokens
being optional ("No token = legacy mode"). So an agent can post to its channels
**without ever calling `trio_connect`**. Option C is therefore already mostly
true — the durable registration is programmatic; only the session token and the
read watermark come from `connect`.

## Better options

### Option A — lazy initialization

Do not generate a model turn until the first real task/message arrives. Include
any required startup/connect instructions with that first turn. Safe for both
providers: Codex `spawn()` already creates and loads the thread, and Claude's
process sits on stdin, so "no first feed" simply means "no first turn."

### Option B — optional announcement

Expose `Announce on startup: yes/no`, defaulting to off for worker agents.

### Option C — non-model registration

Largely already the case. What is lost by never connecting is the session token
(provenance on sent messages) and `members.last_read` advancing. Decide whether
either matters for managed agents before treating this as free.

## Expected impact

One turn per agent creation. Minor for a few long-lived agents; noticeable when
frequently creating short-lived workers.

## Priority

**Low.** Simple, bounded, no interactions with anything else on this list.

---

# Improvement 7: use Codex `turn/steer` for active agents

Moved from #2 to last. The change is worth making; it is just not primarily a
token-efficiency change, and it is the most invasive item here.

## The primitive exists

**[verified]** — from the protocol schema generated by `codex-cli 0.147.0`:

```text
turn/steer
  params: { threadId, expectedTurnId, input[], clientUserMessageId? }
  result: { turnId }
```

`expectedTurnId` is documented as a **precondition**: "Required active turn id
precondition. The request fails when it does not match the currently active
turn."

There is also a `activeTurnNotSteerable` error variant, described as: *"Returned
when `turn/start` **or** `turn/steer` is submitted while the current active turn
cannot accept same-turn steering, for example `/review` or manual `/compact`."*

**That last sentence is the most useful finding in this section.** It implies
`turn/start` against a thread with an active turn already steers implicitly in
this App Server version. Trio never exercises that path because `feed()` queues
whenever the agent is `_active`. **Spike this before building anything** — it
may reduce the whole item to relaxing the queue guard for a subset of messages,
rather than adding a new protocol call.

## Recommended policy

```text
Agent idle
    → turn/start

Agent busy + direct/high-priority input (DM, @mention, !bang)
    → steer

Agent busy + ordinary/non-urgent traffic
    → queue

Current turn finishes
    → process queued traffic, batched (Improvement 4)
```

## Corrected impact estimate

The first draft ranked this #2 on a token-efficiency list. **[corrected]**
Steering *adds* input to a running turn; it does not remove a turn's worth of
context processing so much as fold it into the current one. The saving is real
but second-order — you avoid one turn's final-answer output and one bridged
message. The genuine win is **wasted work avoided**, because a correction can
land before the agent finishes going the wrong way. Ranked and justified on that
basis, it is valuable. Ranked as a token optimisation, it is oversold, and it
could even *increase* tokens on a turn that gets redirected mid-flight.

Worth noting for calibration: Claude agents already work this way — `feed()`
writes straight to stdin with no busy check — so this brings Codex to parity
rather than introducing a new capability to the product.

## Implementation notes — the hard part

The per-turn bookkeeping assumes **one fed message per turn**, and steering
breaks that assumption in three places:

- `_turn_context[turn_id]` holds a single context carrying `channel`,
  `baseline`, `source_message_id` and `source_sender`. A steered turn can be
  answering messages from two different channels, and there is currently
  nowhere to put the second reply.
- `_turn_text[turn_id]` keeps only the last `agentMessage`, so a turn that
  answers two things bridges one.
- `_bridge_result` posts exactly one message per turn, into
  `context["channel"]`.

So the reply-routing model has to be generalised before the transport call is
worth adding. Decide the semantics first: does a steered turn produce one
consolidated reply into the original channel, or one reply per source? Either is
defensible; the code currently expresses neither.

Two smaller mechanics:

- `expectedTurnId` makes this a check-then-act against `self._active`, which the
  reader thread mutates on `turn/completed`. Expect the precondition to fail
  routinely under load, and make the fallback (queue it, or start a fresh turn)
  the designed path rather than an error branch.
- Handle `activeTurnNotSteerable` explicitly — `_compacting` is a state Trio
  already tracks, and compaction is exactly one of the documented cases.

## Priority

**Medium, and last.** Most consequential behaviourally, most invasive
structurally, and deserves focused implementation and testing rather than being
slipped in casually.

---

# Trio versus using Codex directly

## Single-agent task

For one focused task, direct Codex should generally be the most token-efficient
route.

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

- Trio-specific instructions (preamble, re-injected on every wake — see #5)
- Trio MCP tool definitions and calls
- coordination messages
- additional turns caused by routed messages (see #4, #7)
- startup/wake instructions (see #5, #6)
- communication between agents

Therefore:

> For "give Codex this coding task and let it work," direct Codex is the leaner
> interface.

---

# Where Trio earns the overhead

Trio becomes useful when the desired workflow is not equivalent to one
interactive Codex session:

- multiple persistent workers
- independently addressable agents
- long-running agents that may sit idle
- channels and DMs
- cross-agent coordination
- provider mixing
- persistent agent workspaces
- operator control through a shared UI
- ability to message an agent while another task/session is active

The current Agent Manager architecture is particularly good for long-lived
agents because **idle time itself is cheap**. An agent can exist for hours
without repeatedly spending tokens checking whether someone has messaged it.

---

# Multi-agent token economics

Multi-agent systems are not inherently token-saving. If three agents
independently reason about a problem, each has its own context, reasoning, tool
calls, and outputs. That naturally costs more than one agent.

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

Use agent-to-agent messaging for meaningful handoffs rather than continuous
conversation.

---

# Suggested implementation sequence

Each phase is independently shippable. Phases 1 and 2 do not touch each other's
files and can be branched in parallel.

## Phase 1 — correctness first

### 1. `_bridge_result` parses sigils

A bridged reply must resolve `@` / `#` / `!` the same way `nth_send` does.
Standalone bug fix; also the prerequisite for step 3.

### 2. Remove managed-agent poll/monitor instructions

Managed agents should understand that incoming messages — public *and* private
inbox — are pushed into their session automatically, while retaining an explicit
escape hatch for fetching history on demand.

**Do not disturb the `AGENT_ID_MARKER` sentence.**

## Phase 2 — the common reply path

### 3. Normal final response is the reply

Change the prompt so agents can return a normal final response rather than
always using `trio_send`. Before merging, resolve the interim-update-versus-
suppression conflict and decide the convention for staying silent. Test routing
across public channels, DMs, agent-initiated messages, and turns that use
`trio_send` anyway.

## Phase 3 — queue behaviour

### 4. Batch queued traffic

Group compatible queued messages before starting another turn: same agent, same
channel, and for the inbox the same sender. Preserve ordering across
`hibernate`/`wake` and `reconcile`.

## Phase 4 — context cleanup

### 5. Credential delta on wake

Preserve credential rotation; inject only changed state, on the Codex path only.
Fold in multi-channel `trio_connect` if it looks cheap. Leave `clear()` alone.

### 6. Remove or make optional the startup hello turn

Prefer lazy initialization for worker agents.

## Phase 5 — mid-turn input

### 7. `turn/steer`

Spike `turn/start`-while-busy first. Generalise the per-turn reply-routing model
before adding the transport call. Keep ordinary ambient traffic queued.

---

# Measurement plan

Do not rely only on intuition. The Codex runtime already records per-turn and
per-request usage (`nth_request_log`, plus the shared token ring buffer), and it
already normalises Codex's `cachedInputTokens` into the disjoint convention the
consumers expect — so before/after comparisons are directly available.

Useful metrics:

- number of Codex turns
- number of upstream model requests (`rawResponse/completed` count per turn —
  this is the metric that should visibly drop for Improvement 3)
- input tokens
- cached input tokens
- uncached input tokens
- output tokens
- Trio MCP call count
- number of messages delivered through response bridging
- number of queued messages, and queue depth at drain time
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

Run the same scenario before and after each optimization. Step 7 is what
exercises Improvement 5; run it several times to see the duplication accumulate.

Add one scenario the first draft omitted, because it is the regression Improvement
1 exists to prevent:

```text
Two agents in one channel. Agent A ends a turn with "@B please take this"
WITHOUT calling trio_send. Assert that B is woken.
```

The most revealing before/after comparison will likely be:

```text
Current:
queued messages → one turn/start each
ordinary reply  → trio_send round trip
every wake      → full preamble + base_prompt reinjected

Modified:
queued messages → one batched turn/start
ordinary reply  → bridged final response
every wake      → credential delta only
```

---

# What is worth doing immediately?

There is no urgent architectural problem. The Agent Router has already solved
the major token-efficiency issue: **idle managed agents do not need model-driven
polling**.

Two things are worth doing now, and they are independent:

> **Fix `_bridge_result` so bridged replies resolve `@`/`#`/`!`.** This is a
> live bug, not an optimisation.

> **Remove the stale managed-agent instruction telling agents to monitor/poll
> their Trio inbox.** Low effort, low risk, aligns the prompt with the
> architecture that is already running.

After those, the bridged-reply prompt change (#3) and queue batching (#4) are
the next real token wins. `turn/steer` remains the most interesting behavioural
change, but it should be scheduled as a wasted-work fix with a design pass on
reply routing — not slipped into a token-efficiency sprint.
