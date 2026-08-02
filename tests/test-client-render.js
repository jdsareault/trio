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
  assert.strictEqual(H.isSystemContent('[done](https://example.test)'), false);
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
  H.Trio.composer.setTargets(['ag_1']);
  H.Trio.composer.init();
  H.Trio.composer.buildSendPayload();
  H.Trio.state.pendingAttachments = H.state.pendingAttachments;
  const input = cx.document.getElementById('input'); input.value = 'hello';
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
check('agent action capabilities filter by lifecycle', () => {
  const caps = H.Trio.agents.actionCaps(H.Trio.agents.viewModel({ id: 'ag_1', live: false, state: 'stopped' }));
  assert.ok(caps.includes('wake'));
  assert.strictEqual(caps.includes('interrupt'), false);
});
check('preferences save persists the dictation switch', () => {
  H.Trio.preferences.save({ dictation: false });
  assert.strictEqual(H.Trio.preferences.read().dictation, false);
  H.Trio.preferences.save({ dictation: true });
});

console.log((failures ? 'FAILED' : 'OK') + ' — ' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
