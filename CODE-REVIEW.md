# Code Review Findings

## Findings

### Clean installations omit required runtime modules

**Critical · a few LOC**

[setup.sh (line 146)](/Users/jdsareault/Development/trio/setup.sh:146) copies `nth_web.py`, which imports `nth_agent_manager`, but setup copies neither `nth_agent_manager.py` nor its `nth_codex_runtime.py` dependency. The installed unified app therefore fails at import time with `ModuleNotFoundError`. Add both copy operations and a clean-room import/start smoke test.

---

### Private MCP traffic relies on a forgeable member_id

**Critical · substantial refactor**

[nth_dm:1674 (line 1674)](/Users/jdsareault/Development/trio/server/nth_server.py:1674), [nth_poll:2119 (line 2119)](/Users/jdsareault/Development/trio/server/nth_server.py:2119), and [nth_history:2623 (line 2623)](/Users/jdsareault/Development/trio/server/nth_server.py:2623) validate a session token only when the caller supplies one; history cannot accept one at all. Any MCP caller can pass an existing victim's member ID to read that member's DMs, advance its watermark, or send messages as it. The reclaim-secret fix protects `connect`, but not these operations. This also invalidates the claimed remote-spoke privacy boundary and the new managed-agent inbox boundary. Require capabilities for member-scoped reads and writes; tokenless legacy calls should be broadcast-only and unable to mutate another identity.

---

### A malicious webpage can exercise the loopback operator API

**Critical · minor changes to a few files**

[identity resolution:2343 (line 2343)](/Users/jdsareault/Development/trio/server/nth_web.py:2343), [POST routing:2476 (line 2476)](/Users/jdsareault/Development/trio/server/nth_web.py:2476), and [JSON parsing:2661 (line 2661)](/Users/jdsareault/Development/trio/server/nth_web.py:2661) have no Origin/Referer or CSRF check. A cross-origin simple request with a `text/plain` JSON body avoids preflight; the browser connects from loopback, receives a newly minted identity, and is trusted as the OS operator even without the existing cookie. That can create autonomous agents, resolve approvals, reveal paths, or mutate conversations. Require a same-origin CSRF token on every mutation, validate Origin, and restrict JSON endpoints to expected content types.

---

### Malformed JSON can still create an agent after returning HTTP 400

**High · a few LOC**

[nth_web.py (line 3707)](/Users/jdsareault/Development/trio/server/nth_web.py:3707) uses `self._read_json_body() or {}`. The parser already sends an error and returns `None`; the handler then continues with default values and can spawn an agent before attempting a second response. Replace this with an explicit `None` return guard.

---

### The "private" agent inbox can fall back to a broadcast

**High · a few LOC**

[nth_server.py (line 1395)](/Users/jdsareault/Development/trio/server/nth_server.py:1395) attempts to infer a recipient for `trio_send` in the shared hidden inbox. If there is no prior private sender and no human member row—as with a zero-placement agent's initial prompt—`recipients_json` remains unset and [line 1503 (line 1503)](/Users/jdsareault/Development/trio/server/nth_server.py:1503) stores `[]`, meaning broadcast. Every managed agent is placed in that shared channel. Fail closed: reject recipientless inbox sends or scope them to an explicit recipient/self-only value.

---

### AgentRouter does not provide durable delivery

**High · substantial refactor**

[nth_web.py (line 2097)](/Users/jdsareault/Development/trio/server/nth_web.py:2097) skips every message already committed when the router restarts. It advances `last_id` before successful enqueue, explicitly drops on queue saturation at [line 2147 (line 2147)](/Users/jdsareault/Development/trio/server/nth_web.py:2147), and ignores both failed wakes and a false `feed()` result at [line 2173 (line 2173)](/Users/jdsareault/Development/trio/server/nth_web.py:2173). A transient runtime failure permanently loses directed messages. Use durable per-agent delivery records/watermarks, idempotency by `(source_message_id, agent_id)`, and retry/dead-letter states.

---

### A fully populated channel deterministically loses its newest primed SSE message

**High · a few LOC**

[nth_web.py (line 819)](/Users/jdsareault/Development/trio/server/nth_web.py:819) creates a 200-entry queue, but priming emits one roster plus as many as 200 messages. The 201st payload—the newest message—is silently dropped at [line 837 (line 837)](/Users/jdsareault/Development/trio/server/nth_web.py:837). Since the hub initializes its live cursor to the latest ID, that message is not replayed. Increase/separate the prime buffer and test exact 199/200/201 boundaries.

---

### Codex "Clear context" can leave the old turn executing

**High · a few LOC**

[nth_codex_runtime.py (line 695)](/Users/jdsareault/Development/trio/server/nth_codex_runtime.py:695) archives the thread but never interrupts an active turn or clears `_active`, `_starting`, `_queued`, `_turn_context`, `_turn_text`, and pending approvals. The old turn can continue running tools after the UI reports a fresh context, while its notifications are ignored. Interrupt first, cancel approvals, and atomically clear all per-agent turn state before spawning the replacement.

---

### Late DM responses can render private history in a channel view

**High · a few LOC**

[20-workspace.js (line 61)](/Users/jdsareault/Development/trio/server/web/js/20-workspace.js:61) does not cancel outstanding DM loaders when navigating away. The completion at [line 95 (line 95)](/Users/jdsareault/Development/trio/server/web/js/20-workspace.js:95) unconditionally inserts messages; once `dmKey` has been cleared, the DM filter no longer runs. `openDmByKey` has the same stale-navigation problem. Add a conversation generation/route identity check and cancel all superseded requests.

---

### setup.sh still fails after link.sh for the web directory

**Medium · a few LOC**

[link.sh (line 33)](/Users/jdsareault/Development/trio/link.sh:33) makes `$SERVER_DIR/web` a symlink to the source tree. [setup.sh (line 164)](/Users/jdsareault/Development/trio/setup.sh:164) then copies that source tree into the symlinked source itself; this reproduces as "are identical (not copied)." Apply the same symlink-removal logic used for release files before copying the directory.

---

### Unified cross-channel DMs are live on only one backing channel

**Medium · minor changes to a few files**

The server merges a thread across channels at [nth_web.py (line 3335)](/Users/jdsareault/Development/trio/server/nth_web.py:3335), but `openDm` starts SSE only for `dm.channel` at [20-workspace.js (line 90)](/Users/jdsareault/Development/trio/server/web/js/20-workspace.js:90). A new DM from the same peer through another channel will not appear until reopen. Provide a channel-tagged workspace/DM stream and filter it by thread; the existing workspace stream lacks enough channel context to enable safely as-is.

---

### Filtered history pagination can return a non-advancing cursor

**Medium · a few LOC**

[nth_server.py (line 2697)](/Users/jdsareault/Development/trio/server/nth_server.py:2697) truncates raw rows and then removes invisible DMs. [Line 2744 (line 2744)](/Users/jdsareault/Development/trio/server/nth_server.py:2744) derives the continuation from visible messages; an all-hidden page returns the original `from_id`, creating an infinite paging loop. Capture the last raw row ID before visibility filtering.

---

### Concurrent Codex spawns can start the shared worker/client twice

**Medium · a few LOC**

[nth_codex_runtime.py (line 399)](/Users/jdsareault/Development/trio/server/nth_codex_runtime.py:399) checks and starts shared threads without a global start lock. Different agents use different per-agent locks, so simultaneous requests can both call `Thread.start()`, raising `RuntimeError` or starting competing provider processes. Serialize the full initialization sequence.

---

### An early Codex completion can leave durable state as running

**Medium · 1 LOC**

`_start_turn` correctly detects that the notification may have already completed the turn, but [nth_codex_runtime.py (line 607)](/Users/jdsareault/Development/trio/server/nth_codex_runtime.py:607) still unconditionally writes `running`. Only set `running` when the returned turn is still pending/active.

---

### Generated patch snapshots dominate and recursively degrade future reviews

**Medium · minor changes to a few files**

The six committed `diff-*.patch` files total 131,504 lines and account for more than 85% of inserted lines. They obscure the 14.8k-line production change, inflate repository history, and consume LOTC context repeatedly. Store them outside Git or as release artifacts and ignore generated diff snapshots.

---

### The oldest monitor compatibility fallback still crashes without recipients

**Low · a few LOC**

Every fallback query at [nth_monitor.py (line 363)](/Users/jdsareault/Development/trio/server/nth_monitor.py:363) now selects `recipients`. A genuinely pre-DM schema has no such column, so the final fallback raises rather than operating in broadcast-only mode. Add a final pre-recipient-schema query.

---

### Spoke wake decisions use fresh flags, but emitted metadata remains stale

**Low · a few LOC**

[nth_spoke_monitor.py (line 556)](/Users/jdsareault/Development/trio/server/nth_spoke_monitor.py:556) computes `fresh_flags`, while [lines 577–579 (line 577)](/Users/jdsareault/Development/trio/server/nth_spoke_monitor.py:577) still emit aggregate backlog flags. Consumers can be told a fresh ambient event contained a bang/mention/ref. Emit `fresh_flags`.

---

### Thread subclasses shadow Python's internal `_stop()` method

**Low · a few LOC**

`AgentIdleReaper` and `AgentRouter` assign an `Event` to `self._stop` at [nth_web.py (line 2022)](/Users/jdsareault/Development/trio/server/nth_web.py:2022) and [line 2079 (line 2079)](/Users/jdsareault/Development/trio/server/nth_web.py:2079). `Thread.join()` eventually calls `_stop()`, causing `TypeError`. Rename these fields to `_stop_event`.

---

## Token-efficient deeper LOTC strategy

The best follow-up is not to submit the 96k-line recursive patch again.

Review three canonical slices independently:

- **Python/install/runtime:** 10,662 changed lines.
- **Browser JavaScript:** 2,816 changed lines.
- **HTML/CSS and packaging residue:** about 1,350 lines.

Run fresh, unanchored passes in this order:

1. **Trust boundaries:** web identity, CSRF, MCP capabilities, DM visibility.
2. **Delivery invariants:** DB → EventHub/Router → provider → reply bridge.
3. **Lifecycle/concurrency:** spawn, wake, clear, interrupt, delete, restart.
4. **Browser async state:** delayed requests, rapid routing, cross-channel streams.
5. **Installation/migrations:** clean install, linked development install, old schemas.

Require each LOTC finding to supply a concrete counterexample or deterministic test. This removes speculative findings cheaply.

### Prioritized adversarial tests

- Forge another member ID across every MCP read/write tool.
- Cross-origin `text/plain` POSTs to loopback.
- Clean-room `setup.sh` import/start and `link.sh` → `setup.sh`.
- EventHub queues at exactly 199/200/201 messages.
- Router restart, `feed=False`, wake exception, and queue-full injection.
- Codex completion-before-turn/start response and clear-during-active-turn.
- Deferred DM promises followed by channel/other-DM navigation.
- History pages containing only invisible rows.

Only after those passes should prior LOTC reports be supplied for reconciliation. That prevents anchoring while still deduplicating already-fixed findings.
