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

console.log((failures ? 'FAILED' : 'OK') + ' — ' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
