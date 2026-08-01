# QA Guide — Unified Interface (multi-channel hub + agent supervisor)

Branch: `feat/unified-phase2-supervisor`. Nothing is merged to `main`.
This covers spinning up the hub, a manual test checklist, the automated suite,
gotchas, and known-deferred items (so you don't file those as bugs).

---

## 0. Prerequisites

- On the branch: `git checkout feat/unified-phase2-supervisor`
- Python 3 (stdlib only — no pip deps for the core).
- `claude` on PATH and authed (only needed to spawn REAL agents). Check:
  `claude --version` and `claude -p "say hi"`.
- **Use Sonnet or Opus for spawned agents. Haiku is too weak** — in testing it
  failed to drive the Trio MCP tools (shelled out to Bash instead) and posted
  nothing. The spawn form defaults to Opus.

---

## 1. Spin it up

**Multi-channel hub (the new mode):**
```
python3 server/nth_web.py           # no channel arg → serves ALL channels
```
Open the printed `http://127.0.0.1:8765/`. On loopback you're the **operator**
(all-seeing). The page lands on the most-recently-active channel.

**Back-compat single-channel mode (should still work unchanged):**
```
python3 server/nth_web.py <channel-code>
```

To watch DB activity in a second terminal:
`python3 server/nth_console.py` (or `-c <channel>`).

---

## 2. Manual checklist

### 2a. Multi-channel client
- [ ] **Channel switcher** (header dropdown) lists your channels; picking one
      reloads to `/?channel=CODE` and shows that channel's messages/roster.
- [ ] The switcher is **hidden** in single-channel mode and when only ≤1 channel
      exists.
- [ ] Sending a message, editing/deleting, culling a member, search, tasks — all
      operate on the **currently selected** channel (not leaking across).
- [ ] **DMs** open with the channel preserved (the "← #channel" back button
      returns to the same channel, not a random one).
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

---

## 3. Automated suite

```
# Python (stdlib):
for t in test-identity-reclaim test-agents-schema test-supervisor \
         test-web-channels test-web-agents test-agent-routing \
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

- **Haiku agents don't work** for Trio orchestration — use Sonnet/Opus.
- **First-turn latency after spawn/wake:** a headless agent's `session_id` /
  first response can lag because the injected Trio MCP handshake runs before the
  init event. The agent shows live; its first post may take a few seconds.
- **The hub is a persistent daemon in concept** — closing the browser doesn't
  stop it or its agents. (Launchd autostart is a Phase-3 item, not wired yet;
  today you start it manually.)
- **Spawned agents run with Bash enabled** (permission mode `acceptEdits`).
  They're operator-spawned and local — but be aware they can run shell commands.

---

## 5. Known deferred (in scope, not yet built — see reports/…lotc-review.md)

- **Phase 1 polish:** the Slack-style persistent channel **rail** (today it's a
  dropdown), and a **unified cross-channel DM inbox** (today DMs are per-channel).
- **Phase 3:** aggressive-hibernation **idle timer**, **clear/compact** context
  buttons, launchd autostart.
- **Lifecycle:** per-channel runtime idle-eviction; agent-vs-agent reclaim
  secret (the operator-hijack case IS closed); reclaim name/last_read
  reconciliation.
- These are tracked in `reports/2026-07-31-unified-interface-lotc-review.md` and
  `proposals/unified-interface.md`.

---

## 6. If something's wrong

- Server errors print to the terminal running `nth_web.py`.
- A spawned agent's stderr is captured (bounded tail) — surfaced on `errored`
  state; check the roster state.
- `nth_console.py -c <channel>` tails the DB so you can see exactly what an
  agent did (or didn't) post.
