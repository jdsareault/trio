'use strict';

// Focused client contract coverage for the ordered modular web bundle.
const assert = require('assert');
const { load, FakeElement } = require('./dom-harness');
const cx = load();
const H = cx.hooks;
let failures = 0;
function check(name, fn) { try { fn(); console.log('PASS: ' + name); } catch (e) { failures++; console.log('FAIL: ' + name + ' — ' + e.message); } }

check('markdown escapes HTML and renders emphasis', () => {
  const html = H.renderMarkdown('<img> **safe**');
  assert.ok(html.includes('&lt;img&gt;'));
  assert.ok(html.includes('<strong>safe</strong>'));
});
check('system events are plain and links are not system events', () => {
  assert.strictEqual(H.isSystemContent('[joined] alice'), true);
  assert.strictEqual(H.isSystemContent('[channel created] Testing'), true);
  assert.strictEqual(H.isSystemContent('[channel update] Testing'), false);
  assert.strictEqual(H.isSystemContent('[done](https://example.test)'), false);
});
check('system events collapse to concise human-readable copy', () => {
  assert.strictEqual(H.systemMessageText('[joined] Eomer — online for the UI update (skills: coding)'), 'Eomer joined channel');
  assert.strictEqual(H.systemMessageText('[culled] Boromir (ag_123) removed from channel — released tasks: #4'), 'Boromir removed from channel');
  assert.strictEqual(H.systemMessageText('[channel created] Testing the new Atrium UI', 'atrium-test'), 'atrium-test channel created');
});
check('system cards omit authored-message chrome', () => {
  H.Trio.state.channel = 'atrium-test';
  H.Trio.state.operator = { id: 'operator' };
  const card = H.cardFor({ id: 12, member_id: 'operator', member_name: 'jdsareault', content: '[channel created] Testing' });
  assert.ok(card.classList.contains('system-message'));
  assert.strictEqual(card.querySelector('.message-avatar'), null);
  assert.strictEqual(card.querySelector('.message-head'), null);
  assert.strictEqual(card.querySelector('.message-controls'), null);
  assert.strictEqual(card.querySelector('.message-id'), null);
  assert.strictEqual(card.querySelector('.message-body').textContent, 'atrium-test channel created');
});
check('own message actions stay hidden until a long-press gesture', () => {
  H.Trio.state.operator = { id: 'operator' };
  const card = H.cardFor({ id: 13, member_id: 'operator', member_name: 'me', content: 'hello' });
  assert.strictEqual(card.querySelector('.message-controls'), null);
  assert.strictEqual(card.querySelector('.message-actions-menu'), null);
  assert.ok(card._listeners.pointerdown);
  assert.ok(card._listeners.contextmenu);
});
check('operator messages omit the agent role badge', () => {
  H.Trio.state.operator = { id: 'operator' };
  const operatorCard = H.cardFor({ id: 14, member_id: 'operator', member_name: 'me', content: 'from me' });
  assert.strictEqual(operatorCard.querySelector('.message-role'), null);
  const agentCard = H.cardFor({ id: 15, member_id: 'agent-1', member_name: 'Atlas', content: 'from Atlas' });
  assert.strictEqual(agentCard.querySelector('.message-role').textContent, 'agent');
});
check('repeating the message long press hides its action menu', () => {
  H.Trio.state.operator = { id: 'operator' };
  const card = H.cardFor({ id: 16, member_id: 'operator', member_name: 'me', content: 'toggle me' });
  const contextmenu = card._listeners.contextmenu[0];
  const event = { target: card, preventDefault() {} };
  contextmenu(event);
  const menu = card.querySelector('.message-actions-menu');
  assert.ok(menu && !menu.classList.contains('hidden'));
  contextmenu(event);
  assert.ok(menu.classList.contains('hidden'));
});
check('id sigils render with the current display name', () => {
  H.state.members.set('a1', { id: 'a1', name: 'alice' });
  assert.strictEqual(H.humanizeIdSigils('@a1'), '@alice');
});
check('retracted messages replace their body safely', () => {
  const card = new FakeElement('article'), body = new FakeElement('div'); card.append(body);
  H.paintBody(card, body, { id: 1, content: 'secret', retracted_at: 'now', retraction_reason: 'author deleted' });
  assert.strictEqual(body.textContent, '[deleted — author deleted]');
  assert.ok(card.classList.contains('retracted'));
});
check('message rendering decorates mention, ref, and bang sigils', () => {
  H.state.members.set('b1', { id: 'b1', name: 'bob' });
  const card = new FakeElement('article'), body = new FakeElement('div'); card.append(body);
  H.paintBody(card, body, { id: 2, content: '@bob #bob !bob', mentions:['b1'], refs:['b1'], bangs:['b1'] });
  assert.strictEqual(body.querySelectorAll('.inline-mention').length, 1);
  assert.strictEqual(body.querySelectorAll('.inline-ref').length, 1);
  assert.strictEqual(body.querySelectorAll('.inline-bang').length, 1);
});
check('SSE upsert keeps the timeline state keyed by message id', () => {
  H.upsert({ id: 77, member_id: 'b1', content: 'first' });
  H.upsert({ id: 77, member_id: 'b1', content: 'edited', edited_at: 'now' });
  assert.strictEqual(H.state.messages.get(77).content, 'edited');
});
check('answer payload matches the server reply_to and selection contract', () => {
  H.state.operator = { id: 'operator' };
  const message = { id: 91, choices: { target: 'operator', questions: [{ options: ['one', 'two'], mode: 'one' }] } };
  H.state.answers.set(91, [{ picked: new Set([1]), custom: '' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(H.answerPayload(message, message.choices.questions))), {
    content: 'two', reply_to: 91, selection: { answers: [{ picked: [1], custom: [] }] },
  });
  H.state.answers.set(92, [{ picked: new Set([1]), custom: '' }, { picked: new Set([0, 1]), custom: 'Olives' }]);
  const multiMsg = { id: 92, choices: { target: 'operator', questions: [{ question: 'Size?', options: ['S', 'M'] }, { question: 'Top?', options: ['Cheese', 'Pep'] }] } };
  assert.strictEqual(H.answerPayload(multiMsg, multiMsg.choices.questions).content, 'Size? → M\nTop? → Cheese, Pep, Olives');
});
check('private state derives from the server recipients field', () => {
  assert.strictEqual(H.isPrivate({ recipients: ['ag_1'] }), true);
  assert.strictEqual(H.isPrivate({ recipients: [] }), false);
});
check('agent audit history accepts messages without the operator', () => {
  H.Trio.state.dmKey = 'ag_1,ag_2';
  H.Trio.state.dmAudit = true;
  H.Trio.state.dmMemberIds = ['ag_1', 'ag_2'];
  H.upsert({ id: 101, member_id: 'ag_1', recipients: ['ag_2'], content: 'agent-only' });
  assert.strictEqual(H.Trio.state.messages.get(101).content, 'agent-only');
  delete H.Trio.state.dmKey;
  delete H.Trio.state.dmAudit;
  delete H.Trio.state.dmMemberIds;
});
check('composer send payload keeps integer attachment ids and channel targets', () => {
  H.state.selectedTargets = new Set(['ag_1']);
  H.state.pendingAttachments = [{ id: 4 }, { id: 'bad' }, { id: 8 }];
  H.state.dmTargetId = 'ag_1';
  H.Trio.state.channel = 'atrium';
  const input = cx.document.getElementById('input');
  H.Trio.composer.setTargets(['ag_1']);
  H.Trio.composer.init();
  assert.strictEqual(H.Trio.state.composerMode, undefined);
  H.Trio.composer.buildSendPayload();
  H.Trio.state.pendingAttachments = H.state.pendingAttachments;
  input.value = 'hello';
  assert.deepStrictEqual(JSON.parse(JSON.stringify(H.buildSendPayload())), {
    content: '@ag_1 hello', mentions: ['ag_1'], attachment_ids: [4, 8], recipients: ['ag_1'],
  });
  delete H.state.dmTargetId;
});
check('DM send payload includes the conversation recipients, not just a single target id', () => {
  H.Trio.state.dmKey = 'dm-thread';
  H.Trio.state.dmMemberIds = ['ag_1'];
  H.Trio.state.dmTargetId = undefined;
  const input = cx.document.getElementById('input'); input.value = 'hello';
  assert.deepStrictEqual(JSON.parse(JSON.stringify(H.buildSendPayload())), {
    content: '@ag_1 hello', mentions: ['ag_1'], attachment_ids: [4, 8], recipients: ['ag_1'],
  });
  delete H.Trio.state.dmKey;
  delete H.Trio.state.dmMemberIds;
});
check('dictation control disables itself when no speech engine is available', () => {
  const button = cx.document.getElementById('dictate-btn');
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button.title, 'Dictation is unavailable in this browser');
});
check('task filters default to open and all shows every row', () => {
  H.Trio.state.tasks = [{ id: 1, message: 'Open task', status: 'open' }, { id: 2, message: 'Claimed task', status: 'claimed' }];
  H.Trio.workspace.showView('tasks');
  const panel = cx.document.getElementById('trio-tasks-view');
  assert.strictEqual(panel.querySelectorAll('.task-row').length, 1);
  H.Trio.state.taskFilter = 'all';
  H.Trio.workspace.showView('tasks');
  assert.strictEqual(panel.querySelectorAll('.task-row').length, 2);
});
check('sidebar paints the selected channel immediately', () => {
  H.Trio.state.view = 'conversation';
  H.Trio.state.dmKey = '';
  H.Trio.state.channel = 'research';
  H.Trio.state.channels = [{ code: 'general' }, { code: 'research' }];
  H.Trio.state.tasks = { filter: 'open', list: [] };
  H.Trio.state.agents = { list: [] };
  H.Trio.workspace.render();
  const rail = cx.document.getElementById('workspace-rail');
  const active = rail.querySelectorAll('.nav-item.active');
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].querySelector('.nav-label').textContent, 'research');
});
check('A2A sidebar rows render a paired avatar stack', () => {
  H.Trio.state.dms = { your_dms: [], agent_dms: [{ key: 'ag_a,ag_b', name: 'Atlas ↔ Nova', member_ids: ['ag_a', 'ag_b'] }] };
  H.Trio.workspace.render();
  const rail = cx.document.getElementById('workspace-rail');
  const pair = rail.querySelector('.dm-pair');
  assert.ok(pair);
  assert.strictEqual(pair.querySelectorAll('.av').length, 2);
});
check('agent roster panel is not force-hidden by a later render()', () => {
  H.Trio.agents.render([]);
  const panel = cx.document.getElementById('trio-agents');
  assert.ok(panel);
  panel.hidden = false;
  H.Trio.agents.render([]);
  assert.strictEqual(panel.hidden, false);
});
check('agent view model normalizes lifecycle and status', () => {
  const vm = H.Trio.agents.viewModel({ id: 'ag_1', name: 'Test', live: true, busy: true, provider: 'claude', model: 'sonnet', filter_mode: 'about', error: 'boom' });
  assert.strictEqual(vm.lifecycle, 'working');
  assert.strictEqual(vm.wakePolicy, 'about');
  assert.strictEqual(vm.needsAttention, true);
});
check('agent view model surfaces its reasoning effort', () => {
  const vm = H.Trio.agents.viewModel({ id: 'ag_1', effort: 'high' });
  assert.strictEqual(vm.effort, 'high');
  assert.strictEqual(H.Trio.agents.viewModel({ id: 'ag_2' }).effort, '');
});
check('effortsForModel reads the model-specific list from discovered models, not a global default', () => {
  H.Trio.state.agentModels = {
    claude: [{ id: 'haiku', name: 'Claude Haiku', efforts: ['low', 'medium', 'high'] }],
    codex: [{ id: 'fake-codex', name: 'Fake Codex', efforts: ['low', 'high'] }],
  };
  assert.deepStrictEqual(Array.from(H.Trio.agents.effortsForModel('claude', 'haiku')), ['low', 'medium', 'high']);
  assert.deepStrictEqual(Array.from(H.Trio.agents.effortsForModel('codex', 'fake-codex')), ['low', 'high']);
});
check('effortsForModel falls back to a safe default for an undiscovered model', () => {
  H.Trio.state.agentModels = { claude: [] };
  assert.deepStrictEqual(Array.from(H.Trio.agents.effortsForModel('claude', 'unknown-model')), ['low', 'medium', 'high']);
});
check('effortOptions renders a <select>-ready option list with the current value selected', () => {
  const html = H.Trio.agents.effortOptions(['low', 'high'], 'high');
  assert.ok(html.includes('<option value="low">low</option>'));
  assert.ok(html.includes('<option value="high" selected>high</option>'));
});
// LOTC/Frodo (critical): with no explicit selection, browsers auto-select
// the FIRST <option> — which, before this fix, silently created/edited
// agents at the LOWEST effort whenever the user left the control alone
// (create: always; edit: any agent still on its model default, since
// vm.effort is '' there). A real "Model default" option, selected by
// default, is what a blank/'' selection must resolve to.
check('effortOptions: no selection defaults to a real "Model default" option, not the first effort', () => {
  const html = H.Trio.agents.effortOptions(['low', 'medium', 'high'], '');
  assert.ok(html.startsWith('<option value="" selected>Model default</option>'));
  assert.ok(!html.includes('<option value="low" selected>'));
});
check('effortOptions: a custom default label can name the resolved level', () => {
  const html = H.Trio.agents.effortOptions(['low', 'high'], '', { defaultLabel: 'Model default (medium)' });
  assert.ok(html.includes('>Model default (medium)</option>'));
});
// LOTC/Frodo (warning): an agent already set to an effort that discovery
// didn't return (stale/thin catalog, or a value valid at creation time but
// since dropped from the model's advertised list) must not lose that value
// from the dropdown — losing it meant opening-then-saving without any
// change silently downgraded the agent to whatever option landed first.
check('effortOptions: the agent\'s current value is kept as an option even if missing from the discovered list', () => {
  const html = H.Trio.agents.effortOptions(['low', 'medium', 'high'], 'max');
  assert.ok(html.includes('<option value="max" selected>max</option>'));
});
check('agent last-active timestamps are local and human-readable', () => {
  const iso = '2026-08-02T00:45:14+00:00';
  const options = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const formatted = H.Trio.agents.formatLastActive(iso);
  assert.strictEqual(formatted, new Date(iso).toLocaleString([], options));
  assert.notStrictEqual(formatted, iso);
  assert.ok(!formatted.includes('T'));
  assert.strictEqual(H.Trio.agents.formatLastActive('not a timestamp'), 'not a timestamp');
});
check('agent action capabilities filter by lifecycle', () => {
  const caps = H.Trio.agents.actionCaps(H.Trio.agents.viewModel({ id: 'ag_1', live: false, state: 'stopped' }));
  assert.ok(caps.includes('wake'));
  assert.strictEqual(caps.includes('interrupt'), false);
});
check('agent management exposes every supported lifecycle action', () => {
  const live = H.Trio.agents.viewModel({ id: 'ag_live', live: true, busy: false });
  const resting = H.Trio.agents.viewModel({ id: 'ag_resting', live: false, state: 'sleeping' });
  assert.deepStrictEqual(Array.from(H.Trio.agents.actionCaps(live)), ['hibernate', 'compact', 'clear', 'archive']);
  assert.deepStrictEqual(Array.from(H.Trio.agents.actionCaps(resting)), ['wake', 'clear', 'archive']);
  assert.strictEqual(H.Trio.agents.actionLabel('hibernate'), 'Hibernate');
  assert.strictEqual(H.Trio.agents.actionLabel('compact'), 'Compact context');
  assert.strictEqual(H.Trio.agents.actionLabel('archive'), 'Archive agent');
  assert.strictEqual(H.Trio.agents.actionLabel('unarchive'), 'Unarchive agent');
});
check('archived agents expose only the unarchive action', () => {
  const vm = H.Trio.agents.viewModel({ id: 'ag_archived', archived: true, live: false, state: 'stopped' });
  assert.strictEqual(vm.archived, true);
  assert.deepStrictEqual(Array.from(H.Trio.agents.actionCaps(vm)), ['unarchive']);
});
check('viewModel derives archived from archived_at alone (server contract)', () => {
  const vm = H.Trio.agents.viewModel({ id: 'ag_at', archived_at: '2026-08-01T12:00:00Z', live: false, state: 'stopped' });
  assert.strictEqual(vm.archived, true);
  assert.deepStrictEqual(Array.from(H.Trio.agents.actionCaps(vm)), ['unarchive']);
});
check('agent compaction status outranks the ordinary live state', () => {
  const vm = H.Trio.agents.viewModel({ id: 'ag_compact', live: true, busy: false, state: 'compacting' });
  assert.strictEqual(vm.lifecycle, 'compacting');
  assert.strictEqual(vm.compacting, true);
  assert.deepStrictEqual(Array.from(H.Trio.agents.actionCaps(vm)), ['stop', 'archive']);
});
check('clicking a roster tile opens that agent’s management dialog', () => {
  const originalModal = H.Trio.ui.modal;
  let opened = null;
  H.Trio.ui.modal = (title, body) => { opened = { title, body }; };
  H.Trio.store.set('agents.list', [{ id: 'ag_tile', name: 'Tile Agent', live: true, busy: false, state: 'idle' }]);
  const panel = new FakeElement('section');
  H.Trio.agents.renderPage(panel);
  const card = panel.querySelector('.agent-card');
  assert.ok(card);
  card._listeners.click[0]({ target: card });
  H.Trio.ui.modal = originalModal;
  assert.ok(opened);
  assert.strictEqual(opened.title, 'Manage agent: Tile Agent');
  assert.ok(opened.body.includes('Compact context'));
});
check('agent-management dialogs can omit the unrelated Save action', () => {
  const dialog = cx.document.getElementById('trio-control-modal');
  dialog.showModal = () => {};
  H.Trio.ui.modal('Manage agent', '<p>Controls</p>', undefined, { submit: false, cancelLabel: 'Close' });
  const labels = dialog.querySelectorAll('button').map(button => button.textContent);
  assert.ok(labels.includes('Close'));
  assert.strictEqual(labels.includes('Save'), false);
});
check('agent model options normalize provider model records', () => {
  const models = H.Trio.agents.normalizeModels([
    { id: 'sonnet', name: 'Claude Sonnet' },
    { id: 'opus', name: 'Claude Opus' },
  ]);
  assert.deepStrictEqual(models.map(model => model.id), ['sonnet', 'opus']);
  assert.ok(H.Trio.agents.modelOptions(models).includes('value="sonnet"'));
  assert.ok(H.Trio.agents.modelOptions(models).includes('Claude Sonnet'));
});
check('agent model options are selected from the active provider', () => {
  H.Trio.state.agentModels = {
    claude: [{ id: 'sonnet', name: 'Claude Sonnet' }],
    codex: [{ id: 'gpt-5-codex', name: 'GPT-5-Codex' }],
  };
  assert.ok(H.Trio.agents.modelOptions(H.Trio.state.agentModels.claude).includes('sonnet'));
  assert.ok(H.Trio.agents.modelOptions(H.Trio.state.agentModels.codex).includes('gpt-5-codex'));
});
check('permission profiles expose the backend enum as a dropdown', () => {
  const html = H.Trio.agents.permissionOptions();
  assert.ok(html.includes('name="permission_profile"'));
  assert.ok(html.includes('value="observe"'));
  assert.ok(html.includes('value="balanced"'));
  assert.ok(html.includes('value="autonomous"'));
  assert.ok(html.includes('value="balanced" selected'));
});
check('preferences save persists the dictation switch', () => {
  H.Trio.preferences.save({ dictation: false });
  assert.strictEqual(H.Trio.preferences.read().dictation, false);
  H.Trio.preferences.save({ dictation: true });
});

// LOTC: the channel drawer used to disagree with the Agent roster page
// because the supervisor-backed {state,live,busy} merge only ran on the DM
// code path — a normal channel's member list fell through to the raw
// heartbeat-only rows, so channelStatus()'s "prefer the roster" branch never
// fired for the common case. showDetails() must now merge state.agents into
// EVERY channel's member list, not just DMs.
check('channel drawer status agrees with the Agent roster for a regular (non-DM) channel', () => {
  H.Trio.state.dmKey = null;
  H.Trio.state.channel = 'atrium-test';
  H.Trio.state.channels = [{ code: 'atrium-test', topic: 'Testing' }];
  H.Trio.state.members = new Map([
    ['ag_sleepy', { id: 'ag_sleepy', name: 'Sleepy', status: 'active' }],
  ]);
  H.Trio.state.agents = [{ id: 'ag_sleepy', name: 'Sleepy', state: 'sleeping', live: false, busy: false }];
  H.Trio.workspace.showDetails();
  const html = cx.document.getElementById('channel-drawer-body').innerHTML;
  // The Agent roster page renders a sleeping (hibernated) agent as
  // 'sleeping', not the heartbeat row's stale 'active' — the drawer must
  // agree, matching channelStatus()'s own state==='sleeping' branch.
  assert.ok(html.includes('channel-status-chip sleeping'),
    'expected the roster-backed "sleeping" status, got: ' + html);
  assert.ok(!html.includes('channel-status-chip active'),
    'drawer still showed the stale heartbeat-only "active" status');
});
check('channel drawer never shows the operator as offline while they are viewing it', () => {
  H.Trio.state.dmKey = null;
  H.Trio.state.channel = 'atrium-test';
  H.Trio.state.channels = [{ code: 'atrium-test', topic: 'Testing' }];
  H.Trio.state.members = new Map(); // operator hasn't posted in this channel
  H.Trio.state.agents = [];
  H.Trio.state.operator = { id: '_op_l_jdsareault', name: 'jdsareault', source: 'loopback', pending: false };
  H.Trio.workspace.showDetails();
  const html = cx.document.getElementById('channel-drawer-body').innerHTML;
  assert.ok(!html.includes('channel-status-chip offline'),
    'operator rendered offline while actively viewing the page: ' + html);
});
check('channelStatus prefers roster-backed compacting/error states over heartbeat status', () => {
  assert.strictEqual(H.Trio.workspace.channelStatus({ live: true, state: 'compacting', busy: true }), 'sleeping');
  assert.strictEqual(H.Trio.workspace.channelStatus({ live: false, state: 'errored' }), 'errored');
  assert.strictEqual(H.Trio.workspace.channelStatus({ live: true, state: 'running', busy: false }), 'idle');
});

// Notification tier classification — DM > @mention/!bang > #ref > plain,
// first match wins. See 45-notifications.js / 40-preferences.js's
// NOTIFICATION_TIERS comment for the full rationale.
check('classify: a DM to you outranks everything else', () => {
  const msg = { member_id: 'ag_1', recipients: ['me'], mentions: [], refs: [], bangs: [] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), 'dm');
});
check('classify: @mention when not a DM', () => {
  const msg = { member_id: 'ag_1', recipients: [], mentions: ['me'], refs: [], bangs: [] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), 'mention');
});
check('classify: !bang counts as the same tier as @mention', () => {
  const msg = { member_id: 'ag_1', recipients: [], mentions: [], refs: [], bangs: ['me'] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), 'mention');
});
check('classify: #reference below mention, above plain', () => {
  const msg = { member_id: 'ag_1', recipients: [], mentions: [], refs: ['me'], bangs: [] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), 'ref');
});
check('classify: untargeted channel message is plain', () => {
  const msg = { member_id: 'ag_1', recipients: [], mentions: [], refs: [], bangs: [] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), 'plain');
});
check('classify: a DM addressed to someone ELSE is not a DM tier for you', () => {
  const msg = { member_id: 'ag_1', recipients: ['someone-else'], mentions: [], refs: [], bangs: [] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), 'plain');
});
check('classify: your own message never classifies (no self-notify)', () => {
  const msg = { member_id: 'me', recipients: [], mentions: ['me'], refs: [], bangs: [] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), null);
});
check('classify: a system message never classifies', () => {
  const msg = { member_id: 'ag_1', content: '[joined] Someone', mentions: ['me'], refs: [], bangs: [], recipients: [] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), null);
});
check('classify: DM still wins even if you were also @mentioned in it', () => {
  const msg = { member_id: 'ag_1', recipients: ['me'], mentions: ['me'], refs: [], bangs: [] };
  assert.strictEqual(H.Trio.notifications.classify(msg, 'me'), 'dm');
});
check('notifications module exposes the 4-tier priority order and 3 sound presets', () => {
  // Array.from() (not the raw sandboxed array) — the vm sandbox's Array is a
  // different realm than this test's, so a bare literal comparison here
  // fails deepStrictEqual's prototype check despite identical contents.
  assert.deepStrictEqual(Array.from(H.Trio.notifications.TIERS), ['dm', 'mention', 'ref', 'plain']);
  assert.deepStrictEqual(Object.keys(H.Trio.notifications.SOUNDS).sort(), ['alert', 'ping', 'tick']);
});
check('playPreset never throws even with no AudioContext available (headless/CI)', () => {
  assert.doesNotThrow(() => H.Trio.notifications.playPreset('ping', 0.5));
  assert.doesNotThrow(() => H.Trio.notifications.playPreset('nonexistent-preset', 0.5));
  assert.doesNotThrow(() => H.Trio.notifications.playPreset('ping', 0)); // muted — should no-op, not throw
});

// LOTC/Sauron: the priming guard used to be a single timer-based flag shared
// across the per-channel AND cross-channel SSE streams — a reconnect on
// EITHER could silently suppress a genuinely live chime on an unrelated,
// already-open channel. isPrimedHistory() replaces that with a per-message
// age check (immune to which stream delivered it, no shared state at all).
check('isPrimedHistory: a message from long ago is primed history', () => {
  const old = new Date(Date.now() - 60_000).toISOString();
  assert.strictEqual(H.Trio.notifications.isPrimedHistory({ created_at: old }), true);
});
check('isPrimedHistory: a message from right now is live, not primed', () => {
  const now = new Date().toISOString();
  assert.strictEqual(H.Trio.notifications.isPrimedHistory({ created_at: now }), false);
});
check('isPrimedHistory: missing/unparseable created_at fails open (treated as live)', () => {
  assert.strictEqual(H.Trio.notifications.isPrimedHistory({}), false);
  assert.strictEqual(H.Trio.notifications.isPrimedHistory({ created_at: 'not-a-date' }), false);
});
check('notifications: real message-event dispatch never throws for an old or a live DM', () => {
  // onMessage's internal calls to classify()/isPrimedHistory()/playPreset are
  // closures over the module's own function bindings, not live reads of
  // Trio.notifications — so this can't spy on playPreset from the outside.
  // What IS worth asserting end-to-end: dispatching a real 'message' event
  // (the actual production code path, not just calling classify() directly)
  // never throws for either an old or a live message, for every field shape
  // onMessage touches (recipients/mentions/refs/bangs/created_at).
  H.Trio.state.operator = { id: 'me' };
  H.Trio.preferences.save({ chime: true, chimeTierDm: true });
  const live = { id: 101, member_id: 'ag1', recipients: ['me'], mentions: [], refs: [], bangs: [], created_at: new Date().toISOString() };
  const old = { id: 100, member_id: 'ag1', recipients: ['me'], mentions: [], refs: [], bangs: [], created_at: new Date(Date.now() - 60_000).toISOString() };
  assert.strictEqual(H.Trio.notifications.classify(old, 'me'), 'dm');
  assert.strictEqual(H.Trio.notifications.isPrimedHistory(old), true);
  assert.strictEqual(H.Trio.notifications.classify(live, 'me'), 'dm');
  assert.strictEqual(H.Trio.notifications.isPrimedHistory(live), false);
  assert.doesNotThrow(() => H.Trio.events.dispatchEvent(new cx.window.CustomEvent('message', { detail: old })));
  assert.doesNotThrow(() => H.Trio.events.dispatchEvent(new cx.window.CustomEvent('message', { detail: live })));
});

console.log((failures ? 'FAILED' : 'OK') + ' — ' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
