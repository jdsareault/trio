# QA Guide — Unified Interface (multi-channel hub + agent supervisor)

Branch: `feat/unified-phase2-supervisor`. Nothing is merged to `main`.
This covers spinning up the hub, the unified workspace, managed-agent lifecycle,
the automated suite, and the remaining hardening notes.

---

## 0. Prerequisites

- On the branch: `git checkout feat/unified-phase2-supervisor`
- Python 3 (stdlib only — no pip deps for the core).
- `claude` on PATH and authed (only needed to spawn REAL agents). Check:
  `claude --version` and `claude -p "say hi"`.
- The spawn form defaults to Opus. Haiku is viable with the current MCP-first
  bootstrap preamble, though weaker models remain more variable.

---

## 1. Spin it up

**Multi-channel hub (the new mode):**
```
python3 server/nth_web.py           # no channel arg → serves ALL channels
```
Open the printed `http://127.0.0.1:8765/`. On loopback you're the **operator**
(all-seeing). The page lands on the most-recently-active channel.

**Start automatically on macOS:**
```
python3 server/nth_launchd.py install
python3 server/nth_launchd.py status
```
The LaunchAgent starts the unified hub at login, restarts it after failures,
and writes logs under `~/.claude/nth/logs/`. Use `uninstall` to remove it.

**Back-compat single-channel mode (should still work unchanged):**
```
python3 server/nth_web.py <channel-code>
```

To watch DB activity in a second terminal:
`python3 server/nth_console.py` (or `-c <channel>`).

---

## 2. Manual checklist

### 2a. Workspace + channels
- [ ] The persistent **left workspace rail** lists DMs, channels, and agents.
- [ ] Picking a channel reloads to `/?channel=CODE` and shows that channel's
      messages, roster, tasks, and composer without opening another tab.
- [ ] Click **+** beside Channels, create a channel with an optional objective,
      and land in the new channel immediately.
- [ ] The compact header switcher is a phone fallback; the rail is hidden in
      single-channel compatibility mode.
- [ ] Sending a message, editing/deleting, culling a member, search, tasks — all
      operate on the **currently selected** channel (not leaking across).
- [ ] **DMs are unified across channels**: one thread per durable agent, with
      `#channel` origin badges in merged history and a separate Agent ↔ Agent
      audit section.
- [ ] A newly spawned, placed agent appears in the global New DM picker and has
      a one-click **message** action in the Agents panel.
- [ ] Switching channels with **unsent text** in the composer prompts a confirm.
- [ ] With no channels at all (fresh DB), you get a clean "no channel" state —
      **not** an endless "reconnecting…".

### 2b. Access control (operator vs guest)
- [ ] As the loopback operator you can reach any channel via `?channel=`.
- [ ] `/api/channels` and the **agents** panel are operator-only. (A guest —
      e.g. a non-loopback/tailnet visitor who self-declares a name — should be
      confined to a single channel and get 403 on `/api/channels` + agent
      endpoints. Hard to exercise on pure loopback; covered by
      `tests/test-web-channels.py` + `test-web-agents.py`.)
- [ ] Posting to a **bogus** `?channel=` is rejected (404), and creates **no**
      stray rows.

### 2c. Agents panel (operator only)
Open the **agents** pill in the header.
- [ ] **Spawn form:** pick a model (defaults to last-selected), an **Effort**
      level (thinking/reasoning: default|low|medium|high|xhigh|max — persisted
      per your last choice), optional name/prompt, comma-separated channel codes
      (prefilled with the current channel). Click **Spawn agent**. Effort is a
      per-agent knob (passed as `--effort`); wake preserves it.
- [ ] A real agent (Sonnet) should, within ~1–2 min: appear **live** in the
      roster, **connect** to its channel(s), and **post a hello** message.
      Watch the channel (or `nth_console.py`) for its post.
- [ ] **Roster** shows each agent's state/model/channels; **abandoned** agents
      (zero channels) are flagged.
- [ ] **Stop** → agent goes not-live. **Wake** → it comes back and can still
      post (it must NOT come back deaf — it should still have its Trio tools).
- [ ] **Hibernate** parks the process with its session intact; **Clear** starts
      a fresh context; **Compact** invokes Claude Code's `/compact` flow.
- [ ] Add/remove channel placements from the agent row. A new placement is
      immediately explained to a live agent and is included in future wakes.
- [ ] **Delete** → removed from roster; its member is deactivated; its
      placements are gone.
- [ ] Creating with an **unknown channel** → clean 400 (no crash).

### 2d. Routing + hibernation
- [ ] `@mention` a spawned agent in one of its channels → it receives the
      message (tagged `[#channel]`) and can reply.
- [ ] An agent **not placed** in a channel does not receive messages there.
- [ ] After it goes idle/hibernated, a **directed** `@mention` wakes it and it
      responds (first message after a cold wake may take a few seconds).
- [ ] Ambient chatter (no `@`) does **not** wake a sleeping agent.
- [ ] An idle agent hibernates after 10 minutes by default (tune with
      `--agent-idle-minutes`; `0` disables it).
- [ ] Restart the hub: agents that were running/idle/sleeping resume with their
      saved session and placements. `--no-agent-resume` disables this for QA.

---

## 3. Automated suite

```
# Python (stdlib):
for t in test-identity-reclaim test-agents-schema test-supervisor \
         test-agent-lifecycle-depth test-web-channels test-web-agents \
         test-unified-workspace test-agent-routing test-launchd \
         test-search test-cull test-dms test-ask; do
  echo "== $t =="; python3 tests/$t.py; done

# JS (needs node):
node tests/test-client-render.js
python3 tests/test-web-bundle.py
```
All should report `OK — 0 failure(s)` (client-render: `85 passed`).
Agent/supervisor tests use a **fake** stream-json agent (`tests/fake_agent.py`
via `$TRIO_AGENT_CMD`) — they never spawn a real, billed `claude`.

---

## 4. Gotchas / expected behavior (not bugs)

- **Haiku is less deterministic** than Sonnet/Opus. The MCP-first preamble made
  it viable, but use a stronger model when reliable orchestration matters.
- **First-turn latency after spawn/wake:** a headless agent's `session_id` /
  first response can lag because the injected Trio MCP handshake runs before the
  init event. The agent shows live; its first post may take a few seconds.
- Closing the browser doesn't stop the hub or its agents. On macOS, install the
  included LaunchAgent for login startup and failure restart.
- **Spawned agents run with Bash enabled** (permission mode `acceptEdits`).
  They're operator-spawned and local — but be aware they can run shell commands.

---

## 5. Remaining hardening notes

- Per-channel EventHub/watchdog runtime eviction is still a scale optimization;
  runtimes are cheap but remain cached until hub shutdown.
- Agent-vs-agent live-session reclaim still relies on the existing kind guard;
  a future hub-minted reclaim secret would strengthen that boundary.
- The unified DM view aggregates the existing channel-backed message protocol;
  a send still uses one of the target agent's placements. An agent with zero
  placements must be added to a channel before it can be messaged.

---

## 6. If something's wrong

- Server errors print to the terminal running `nth_web.py`.
- A spawned agent's stderr is captured (bounded tail) — surfaced on `errored`
  state; check the roster state.
- `nth_console.py -c <channel>` tails the DB so you can see exactly what an
  agent did (or didn't) post.
