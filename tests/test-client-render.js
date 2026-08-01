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
    content: 'Answered question #91', reply_to: 91, selection: { answers: [{ picked: [1], custom: [] }] },
  });
});
check('private state derives from the server recipients field', () => {
  assert.strictEqual(H.isPrivate({ recipients: ['ag_1'] }), true);
  assert.strictEqual(H.isPrivate({ recipients: [] }), false);
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

console.log((failures ? 'FAILED' : 'OK') + ' — ' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
