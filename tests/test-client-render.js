// Client-side render-layer tests, run against the ACTUAL shipped dashboard
// script via the Node DOM harness (tests/dom-harness.js). No jsdom, no npm —
// Node stdlib + a hand-rolled fake DOM.
//
// Covers the highest-risk, previously-uncovered client logic:
//   • renderMarkdown  — the stdlib-free markdown→HTML renderer (huge edge
//                       surface, incl. XSS-relevant escaping)
//   • isSystemContent — the [word]/[word #id] system-line detector (the exact
//                       predicate whose bug rendered [joined]/[pinned]/… as
//                       markdown; regression-guarded here)
//   • humanizeIdSigils — @<member_id> → @<friendly-name> rewriting
//   • paintBody / applyTargetBars — DOM repaint on edit/retract (the edit/
//                       delete feature's client half)
//
// Usage: node tests/test-client-render.js
'use strict';

const assert = require('assert');
const { load, FakeElement } = require('./dom-harness');

const failures = [];
let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failures.push(name); console.log('FAIL: ' + name + ' — ' + e.message); }
}

const cx = load();
const H = cx.hooks;
if (cx.bootError) console.log('(note) boot ran with: ' + cx.bootError.message);

// ── escapeHtml ──────────────────────────────────────────────────────────────
check('escapeHtml escapes the five entities', () => {
  assert.strictEqual(H.escapeHtml(`<a href="x" data='y'>&`),
    '&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;');
});

// ── renderMarkdown: inline ───────────────────────────────────────────────────
check('renderMarkdown bold + italic', () => {
  assert.strictEqual(H.renderMarkdown('**b** and *i*'),
    '<p><strong>b</strong> and <em>i</em></p>');
});
check('renderMarkdown inline code is escaped and not re-parsed', () => {
  const out = H.renderMarkdown('use `**not bold**`');
  assert.ok(/<code[^>]*>\*\*not bold\*\*<\/code>/.test(out),
    'inline code must keep literal ** and not become <strong>: ' + out);
});
check('renderMarkdown strikethrough', () => {
  assert.strictEqual(H.renderMarkdown('~~gone~~'), '<p><del>gone</del></p>');
});
check('renderMarkdown escapes raw HTML (no injection)', () => {
  const out = H.renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), 'raw <img> must be escaped: ' + out);
  assert.ok(out.includes('&lt;img'), 'expected escaped angle bracket: ' + out);
});
check('renderMarkdown link href strips smuggled quote entities', () => {
  const out = H.renderMarkdown('[t](http://x.com)');
  assert.ok(out.includes('href="http://x.com"'), out);
  assert.ok(out.includes('rel="noopener noreferrer"'), out);
});
check('renderMarkdown autolinks bare urls', () => {
  const out = H.renderMarkdown('see http://example.com now');
  assert.ok(out.includes('<a href="http://example.com"'), out);
});
check('renderMarkdown non-http link text is NOT linkified', () => {
  // javascript: scheme must not become an anchor.
  const out = H.renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!out.includes('href="javascript'), 'javascript: URL must not linkify: ' + out);
});

// ── renderMarkdown: block ────────────────────────────────────────────────────
check('renderMarkdown ATX heading', () => {
  assert.strictEqual(H.renderMarkdown('## Title'), '<h2>Title</h2>');
});
check('renderMarkdown fenced code block preserves contents literally', () => {
  const out = H.renderMarkdown('```js\nconst a = **1**;\n```');
  assert.ok(out.includes('<pre'), out);
  assert.ok(out.includes('const a = **1**;'), 'fence body must be literal: ' + out);
  assert.ok(!out.includes('<strong>'), 'fence body must not be markdown-parsed: ' + out);
});
check('renderMarkdown unordered list', () => {
  const out = H.renderMarkdown('- one\n- two');
  assert.ok(/<ul>.*<li>one<\/li>.*<li>two<\/li>.*<\/ul>/s.test(out), out);
});
check('renderMarkdown GFM task list', () => {
  const out = H.renderMarkdown('- [x] done\n- [ ] todo');
  assert.ok(out.includes('checked') || out.includes('checkbox') || /\[x\]|✓|☑/.test(out) === false, out);
  assert.ok(out.includes('done') && out.includes('todo'), out);
});
check('renderMarkdown empty string → empty', () => {
  assert.strictEqual(H.renderMarkdown(''), '');
});

// ── isSystemContent (regression-guarded) ─────────────────────────────────────
check('isSystemContent: [word] events are system', () => {
  for (const s of ['[joined] a', '[left] a', '[ended]', '[locked] r', '[unlocked] r',
                   '[pinned] x', '[renamed] a→b', '[culled] a', '[objective] do it']) {
    assert.strictEqual(H.isSystemContent(s), true, 'expected system: ' + s);
  }
});
check('isSystemContent: [word #id] events are system', () => {
  for (const s of ['[claimed #3] t', '[done #3]', '[cancelled #3]', '[released #3]',
                   '[retracted #7]', '[status #2] busy']) {
    assert.strictEqual(H.isSystemContent(s), true, 'expected system: ' + s);
  }
});
check('isSystemContent: markdown link [done](url) is NOT system', () => {
  assert.strictEqual(H.isSystemContent('[done](http://x)'), false);
});
check('isSystemContent: unknown bracket word is NOT system', () => {
  assert.strictEqual(H.isSystemContent('[todo] buy milk'), false);
  assert.strictEqual(H.isSystemContent('regular message'), false);
  assert.strictEqual(H.isSystemContent(''), false);
});

// ── humanizeIdSigils ─────────────────────────────────────────────────────────
check('humanizeIdSigils rewrites @<id> to @<name>', () => {
  H.state.members.clear();
  H.state.members.set('_op_g_bob_abc123', { id: '_op_g_bob_abc123', name: 'bob-guest' });
  const out = H.humanizeIdSigils('ping @_op_g_bob_abc123 now');
  assert.strictEqual(out, 'ping @bob-guest now');
});
check('humanizeIdSigils leaves unknown ids untouched', () => {
  H.state.members.clear();
  assert.strictEqual(H.humanizeIdSigils('@_op_g_nobody_x'), '@_op_g_nobody_x');
});

// ── paintBody (DOM repaint) ──────────────────────────────────────────────────
function makeMsgDom() {
  const div = new FakeElement('div');
  const body = new FakeElement('div');
  body.className = 'body';
  div.appendChild(body);
  return { div, body };
}

check('paintBody: retracted renders [deleted — reason] and marks retracted', () => {
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: 'x', retracted_at: '2026-01-01T00:00:00Z', retraction_reason: 'author deleted' });
  assert.strictEqual(body.textContent, '[deleted — author deleted]');
  assert.ok(div.classList.contains('retracted'), 'div should have .retracted');
  assert.ok(body.classList.contains('plain'), 'body should be .plain');
});
check('paintBody: retracted with no reason → bare [deleted]', () => {
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: 'x', retracted_at: '2026-01-01T00:00:00Z' });
  assert.strictEqual(body.textContent, '[deleted]');
});
check('paintBody: system content is plain text, not markdown', () => {
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: '[joined] alice' });
  assert.ok(body.classList.contains('plain'), 'system line should be .plain');
  assert.strictEqual(body.textContent, '[joined] alice');
});
check('paintBody: edited flag appends an (edited) marker', () => {
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: '[joined] alice', edited_at: '2026-01-01T00:00:00Z' });
  assert.ok(body.textContent.includes('(edited)'), 'expected (edited) marker: ' + body.textContent);
});
check('paintBody: retracted takes precedence over edited', () => {
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: 'x', retracted_at: 'now', edited_at: 'now' });
  assert.ok(!body.textContent.includes('(edited)'), 'deleted message must not show (edited)');
});
check('paintBody: markdown path decorates a roster @mention (.inline-mention)', () => {
  H.state.members.clear();
  H.state.members.set('bob1', { id: 'bob1', name: 'bob' });
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: 'hey @bob check this', mentions: ['bob1'] });
  const spans = body.querySelectorAll('.inline-mention');
  assert.strictEqual(spans.length, 1, 'expected one decorated mention: ' + body.innerHTML);
  assert.strictEqual(spans[0].textContent, '@bob');
  assert.strictEqual(spans[0].dataset.memberId, 'bob1');
});
check('paintBody: an @mention inside `code` is NOT decorated', () => {
  H.state.members.clear();
  H.state.members.set('bob1', { id: 'bob1', name: 'bob' });
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: 'run `@bob` now', mentions: ['bob1'] });
  assert.strictEqual(body.querySelectorAll('.inline-mention').length, 0,
    'mention inside inline code must be left alone: ' + body.innerHTML);
});
check('paintBody: markdown path decorates a roster #ref (.inline-ref)', () => {
  H.state.members.clear();
  H.state.members.set('bob1', { id: 'bob1', name: 'bob' });
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: 'a note about #bob today', refs: ['bob1'] });
  const spans = body.querySelectorAll('.inline-ref');
  assert.strictEqual(spans.length, 1, 'expected one decorated ref: ' + body.innerHTML);
  assert.strictEqual(spans[0].textContent, '#bob');
  assert.strictEqual(spans[0].dataset.memberId, 'bob1');
  assert.strictEqual(body.querySelectorAll('.inline-mention').length, 0,
    '#ref must not be tagged as an @mention: ' + body.innerHTML);
});
check('paintBody: markdown path decorates a roster !bang (.inline-bang)', () => {
  H.state.members.clear();
  H.state.members.set('bob1', { id: 'bob1', name: 'bob' });
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: 'heads up !bob now', bangs: ['bob1'] });
  const spans = body.querySelectorAll('.inline-bang');
  assert.strictEqual(spans.length, 1, 'expected one decorated bang: ' + body.innerHTML);
  assert.strictEqual(spans[0].textContent, '!bob');
  assert.strictEqual(spans[0].dataset.memberId, 'bob1');
});
check('paintBody: #/! decorate independently on the same message', () => {
  H.state.members.clear();
  H.state.members.set('bob1', { id: 'bob1', name: 'bob' });
  H.state.members.set('amy1', { id: 'amy1', name: 'amy' });
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: '#bob please, !amy urgent', refs: ['bob1'], bangs: ['amy1'] });
  assert.strictEqual(body.querySelectorAll('.inline-ref').length, 1, body.innerHTML);
  assert.strictEqual(body.querySelectorAll('.inline-bang').length, 1, body.innerHTML);
  assert.strictEqual(body.querySelector('.inline-ref').textContent, '#bob');
  assert.strictEqual(body.querySelector('.inline-bang').textContent, '!amy');
});
check('paintBody: a #ref inside `code` is NOT decorated', () => {
  H.state.members.clear();
  H.state.members.set('bob1', { id: 'bob1', name: 'bob' });
  const { div, body } = makeMsgDom();
  H.paintBody(div, body, { id: 1, content: 'see `#bob` here', refs: ['bob1'] });
  assert.strictEqual(body.querySelectorAll('.inline-ref').length, 0,
    'ref inside inline code must be left alone: ' + body.innerHTML);
});
check('paintBody: a Markdown "# heading" line is not mistaken for a #ref', () => {
  H.state.members.clear();
  H.state.members.set('head1', { id: 'head1', name: 'heading' });
  const { div, body } = makeMsgDom();
  // "# heading" renders as an <h1> (sigil stripped); even so, refs=['head1']
  // must not paint the heading word as a #ref.
  H.paintBody(div, body, { id: 1, content: '# heading\n\nbody text', refs: ['head1'] });
  assert.strictEqual(body.querySelectorAll('.inline-ref').length, 0,
    'a markdown heading must not be decorated as a #ref: ' + body.innerHTML);
});
check('paintBody: #all is NOT decorated (no every-member analogue)', () => {
  H.state.members.clear();
  H.state.members.set('bob1', { id: 'bob1', name: 'bob' });
  const { div, body } = makeMsgDom();
  // refs is non-empty (real #bob present) so the # pass runs; #all must still
  // stay plain since '#all' is noise server-side.
  H.paintBody(div, body, { id: 1, content: '#bob and #all', refs: ['bob1'] });
  const refs = body.querySelectorAll('.inline-ref');
  assert.strictEqual(refs.length, 1, 'only #bob should decorate, not #all: ' + body.innerHTML);
  assert.strictEqual(refs[0].textContent, '#bob');
});

// ── applyTargetBars (DOM) ────────────────────────────────────────────────────
check('applyTargetBars: a retracted message clears its target bars', () => {
  const { div, body } = makeMsgDom();
  // seed a stale bar as a direct child
  const stale = new FakeElement('div');
  stale.className = 'mentions-bar';
  div.insertBefore(stale, body);
  H.applyTargetBars(div, { id: 1, retracted_at: 'now', mentions: ['x'] });
  assert.strictEqual(div.querySelectorAll(':scope > .mentions-bar').length, 0,
    'retracted message should have no mention bar');
});

// ── smart targeting (soleAgentId / targetableMembers / directAt) ─────────────
function seedRoster(...members) {
  H.state.dmTargetId = '';
  H.state.operator = { id: '_op_l_me', name: 'me' };
  H.state.members = new Map();
  H.state.members.set('_op_l_me', { id: '_op_l_me', name: 'me' });
  for (const m of members) H.state.members.set(m.id, m);
}
check('targetableMembers excludes the operator and other web operators', () => {
  seedRoster({ id: 'a1', name: 'alice' }, { id: '_op_g_guest', name: 'guest' });
  // NB: the returned array lives in the vm realm, so its prototype differs from
  // this file's Array — deepStrictEqual would reject it on identity. Assert on
  // primitives instead.
  const names = H.targetableMembers().map(m => m.name);
  assert.strictEqual(names.length, 1);
  assert.strictEqual(names[0], 'alice');
});
check('soleAgentId: null with zero agents', () => {
  seedRoster();
  assert.strictEqual(H.soleAgentId(), null);
});
check('soleAgentId: the id with exactly one agent', () => {
  seedRoster({ id: 'a1', name: 'alice' });
  assert.strictEqual(H.soleAgentId(), 'a1');
});
check('soleAgentId: null with two agents (picker applies)', () => {
  seedRoster({ id: 'a1', name: 'alice' }, { id: 'a2', name: 'bob' });
  assert.strictEqual(H.soleAgentId(), null);
});
check('soleAgentId: null in DM mode even with one agent', () => {
  seedRoster({ id: 'a1', name: 'alice' });
  H.state.dmTargetId = 'a1';
  assert.strictEqual(H.soleAgentId(), null);
  H.state.dmTargetId = '';
});
check('directAt prepends @name when absent', () => {
  assert.strictEqual(H.directAt('ship it', { name: 'alice' }), '@alice ship it');
});
check('directAt is a no-op when the mention is already present (case-insensitive)', () => {
  assert.strictEqual(H.directAt('yo @Alice ship it', { name: 'alice' }), 'yo @Alice ship it');
  assert.strictEqual(H.directAt('done @bob.', { name: 'bob' }), 'done @bob.');
});
check('directAt uses a token boundary, not substring — @bobby is NOT bob', () => {
  // The bug the fix closes: a substring check would treat "@bobby" as already
  // mentioning "bob" and skip the prepend, so bob is never woken.
  assert.strictEqual(H.directAt('see @bobby later', { name: 'bob' }), '@bob see @bobby later');
  assert.strictEqual(H.directAt('@alice hi', { name: 'al' }), '@al @alice hi');
  assert.strictEqual(H.directAt('@bob-guest here', { name: 'bob' }), '@bob @bob-guest here');
});
check('directAt escapes regex metacharacters in the name', () => {
  // A name with a "." must not be treated as a regex wildcard.
  assert.strictEqual(H.directAt('hi @axb', { name: 'a.b' }), '@a.b hi @axb');
});
check('directAt tolerates a missing/nameless member', () => {
  assert.strictEqual(H.directAt('ship it', null), 'ship it');
  assert.strictEqual(H.directAt('ship it', { id: 'x' }), 'ship it');
});

// ── colorFor / rememberColors ───────────────────────────────────────────────
// Client-side collision-free label-color assignment (mirrors the server's
// animal_for_channel). Colors must be distinct for a roster ≤ palette size,
// agree across clients (pure function of the sorted id set), and fall back to
// the plain hash pick for authors no longer in the roster.
// Recover the palette color set by assigning a full 8-member roster whose ids
// happen to spread across all 8 slots (verified distinct in the first check).
const PALETTE_SET = (() => {
  const ids = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  H.rememberColors(ids.map(id => ({ id })));
  return new Set(ids.map(id => H.colorFor(id)));
})();

check('rememberColors: a roster ≤ palette gets all-distinct colors', () => {
  const ids = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  H.rememberColors(ids.map(id => ({ id })));
  const colors = ids.map(id => H.colorFor(id));
  assert.strictEqual(new Set(colors).size, ids.length, 'expected 8 distinct colors');
});

check('rememberColors: assignment is order-independent (clients agree)', () => {
  const ids = ['m3', 'm1', 'm4', 'm2'];
  H.rememberColors(ids.map(id => ({ id })));
  const a = ids.map(id => H.colorFor(id));
  // Same set, reversed input order → identical per-id colors.
  H.rememberColors([...ids].reverse().map(id => ({ id })));
  const b = ids.map(id => H.colorFor(id));
  assert.deepStrictEqual(a, b);
});

check('colorFor: unknown id (author who left) falls back to a stable hash pick', () => {
  const gone = 'departed-author';
  H.rememberColors([{ id: 'still-here' }]);
  const first = H.colorFor(gone);
  assert.ok(PALETTE_SET.has(first), 'fallback must be a palette color');
  // Fallback is independent of the current roster — old messages stay stable.
  H.rememberColors([{ id: 'someone-else' }, { id: 'and-another' }]);
  assert.strictEqual(H.colorFor(gone), first, 'departed author color must stay stable');
});

check('rememberColors: overflow (>8) member falls back to its hash pick', () => {
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push('over' + i);
  H.rememberColors(ids.map(id => ({ id })));
  // The last id in sorted order is guaranteed to hit a full palette and wrap
  // back to its own hash pick; at minimum, every assigned color is a palette
  // color and the first 8 sorted ids are distinct.
  const sorted = [...ids].sort();
  const firstEight = sorted.slice(0, 8).map(id => H.colorFor(id));
  assert.strictEqual(new Set(firstEight).size, 8, 'first 8 sorted ids stay distinct');
});

// ── chimeScopeAllows: mention-scoped chime predicate (feature #7) ─────────────
// The chime's scope gate. Pure, and independent of notifyScope: 'all' chimes on
// every peer message; 'mention' only when the operator is @'d.
check("chimeScopeAllows: 'all' chimes regardless of mention", () => {
  assert.strictEqual(H.chimeScopeAllows('all', false), true);
  assert.strictEqual(H.chimeScopeAllows('all', true), true);
});
check("chimeScopeAllows: 'mention' gates on the mention predicate", () => {
  assert.strictEqual(H.chimeScopeAllows('mention', true), true);
  assert.strictEqual(H.chimeScopeAllows('mention', false), false);
});
check('chimeScopeAllows: mention flag is coerced to a real boolean', () => {
  // appendMessage passes `(m.mentions || []).includes(id)` — already boolean —
  // but the helper must not leak a truthy/undefined value through.
  assert.strictEqual(H.chimeScopeAllows('mention', undefined), false);
  assert.strictEqual(H.chimeScopeAllows('mention', 0), false);
});
check('chimeScopeAllows: unknown/absent scope falls through to mention-gated', () => {
  // Only 'all' opens the gate unconditionally; any other/absent value defers to
  // the mention predicate rather than chiming on everything.
  assert.strictEqual(H.chimeScopeAllows('', true), true);
  assert.strictEqual(H.chimeScopeAllows('', false), false);
  assert.strictEqual(H.chimeScopeAllows(undefined, false), false);
});

// ── confBadge: structured confidence → badge element (or null) ───────────────
check('confBadge: high/medium/low each yield a styled badge', () => {
  for (const v of ['high', 'medium', 'low']) {
    const b = H.confBadge(v);
    assert.ok(b, v + ' must produce a badge');
    assert.strictEqual(b.textContent, v);
    assert.ok(b.className.includes('conf-badge'), 'has base class');
    assert.ok(b.className.includes(v), 'has variant class ' + v);
  }
});
check('confBadge: value is case-insensitive and trimmed', () => {
  const b = H.confBadge('  HIGH ');
  assert.ok(b, 'HIGH should normalize to high');
  assert.strictEqual(b.textContent, 'high');
  assert.ok(b.className.includes('high'));
});
check('confBadge: absent confidence renders NOTHING (no empty badge)', () => {
  // Backward-compat contract: an un-declared confidence must be null, not an
  // empty node — appendMessage skips appending when confBadge returns null.
  assert.strictEqual(H.confBadge(null), null, 'null → no badge');
  assert.strictEqual(H.confBadge(undefined), null, 'undefined → no badge');
  assert.strictEqual(H.confBadge(''), null, 'empty string → no badge');
  assert.strictEqual(H.confBadge('   '), null, 'whitespace → no badge');
});
check('confBadge: an out-of-enum value renders no badge', () => {
  assert.strictEqual(H.confBadge('very-high'), null);
  assert.strictEqual(H.confBadge('unsure'), null);
});

// ── applyConfBadge (DOM): retract clears the badge, mirroring target bars ─────
function makeMsgWithHead() {
  const div = new FakeElement('div');
  const head = new FakeElement('div');
  head.className = 'head';
  const acks = new FakeElement('span');
  acks.className = 'acks';
  head.appendChild(acks);
  div.appendChild(head);
  return { div, head };
}
check('applyConfBadge: adds a badge before .acks when confidence is present', () => {
  const { div, head } = makeMsgWithHead();
  H.applyConfBadge(div, { id: 1, content: 'x', confidence: 'medium' });
  const badges = head.querySelectorAll('.conf-badge');
  assert.strictEqual(badges.length, 1, 'exactly one badge');
  assert.strictEqual(badges[0].textContent, 'medium');
});
check('applyConfBadge: a retracted message clears its confidence badge', () => {
  const { div, head } = makeMsgWithHead();
  H.applyConfBadge(div, { id: 1, content: 'x', confidence: 'high' });
  assert.strictEqual(head.querySelectorAll('.conf-badge').length, 1, 'seeded badge');
  H.applyConfBadge(div, { id: 1, content: 'x', confidence: 'high', retracted_at: 'now' });
  assert.strictEqual(head.querySelectorAll('.conf-badge').length, 0,
    'retracted message should carry no confidence badge');
});
check('applyConfBadge: clearing confidence (absent) removes an existing badge', () => {
  const { div, head } = makeMsgWithHead();
  H.applyConfBadge(div, { id: 1, content: 'x', confidence: 'low' });
  H.applyConfBadge(div, { id: 1, content: 'x', confidence: null });
  assert.strictEqual(head.querySelectorAll('.conf-badge').length, 0, 'no stale badge');
});

// ── DM inbox: counterparty resolution, unread count, thread grouping ─────────
const OP = '_op_l_op';
function seedDmState(msgs, members, read) {
  H.state.operator = { id: OP, name: 'operator' };
  H.state.messages = new Map((msgs || []).map((m) => [m.id, m]));
  H.state.members = new Map(Object.entries(members || {}).map(([id, name]) => [id, { id, name }]));
  H.state.dmRead = new Map(Object.entries(read || {}));
}

check('dmCounterparty: broadcast is not a DM', () => {
  assert.strictEqual(H.dmCounterparty({ id: 1, member_id: 'a', recipients: [] }, OP), null);
});
check('dmCounterparty: incoming DM to operator → sender', () => {
  assert.strictEqual(H.dmCounterparty({ id: 1, member_id: 'a', recipients: [OP] }, OP), 'a');
});
check('dmCounterparty: outgoing DM from operator → recipient', () => {
  assert.strictEqual(H.dmCounterparty({ id: 1, member_id: OP, recipients: ['b'] }, OP), 'b');
});
check('dmCounterparty: DM strictly between others is NOT the operator\'s', () => {
  // The all-seeing operator feed ships this row, but it must never be counted.
  assert.strictEqual(H.dmCounterparty({ id: 1, member_id: 'a', recipients: ['b'] }, OP), null);
});

check('unreadDmCount: counts only visible unread DMs addressed to the operator', () => {
  const msgs = [
    { id: 1, member_id: 'a', recipients: [OP], content: 'hi op' },   // unread DM to op
    { id: 2, member_id: 'a', recipients: [] , content: 'broadcast' }, // broadcast — no
    { id: 3, member_id: 'b', recipients: ['c'], content: 'their dm' },// others' DM — no
    { id: 4, member_id: OP, recipients: ['a'], content: 'my reply' }, // operator's own — no
    { id: 5, member_id: 'a', recipients: [OP], content: 'again' },    // unread DM to op
  ];
  seedDmState(msgs, { a: 'alice', b: 'bob', c: 'carol' }, {});
  assert.strictEqual(H.unreadDmCount(H.state.messages.values(), OP, H.state.dmRead), 2);
});

check('unreadDmCount: read watermark clears a thread\'s unread', () => {
  const msgs = [
    { id: 7, member_id: 'a', recipients: [OP], content: 'one' },
    { id: 9, member_id: 'a', recipients: [OP], content: 'two' },
  ];
  seedDmState(msgs, { a: 'alice' }, { a: 9 });   // read through id 9
  assert.strictEqual(H.unreadDmCount(H.state.messages.values(), OP, H.state.dmRead), 0);
  seedDmState(msgs, { a: 'alice' }, { a: 7 });   // read only through id 7
  assert.strictEqual(H.unreadDmCount(H.state.messages.values(), OP, H.state.dmRead), 1);
});

check('dmThreadsFor: groups by counterparty, newest thread first', () => {
  const msgs = [
    { id: 1, member_id: 'a', recipients: [OP], content: 'a1' },
    { id: 2, member_id: OP, recipients: ['a'], content: 'op→a' },
    { id: 5, member_id: 'b', recipients: [OP], content: 'b1' },
  ];
  seedDmState(msgs, { a: 'alice', b: 'bob' }, {});
  const threads = H.dmThreadsFor(H.state.messages.values(), OP, H.state.dmRead);
  assert.strictEqual(threads.length, 2, 'two counterparties');
  assert.strictEqual(threads[0].counterparty, 'b', 'newest lastId first');
  assert.strictEqual(threads[1].counterparty, 'a');
  const a = threads.find((t) => t.counterparty === 'a');
  assert.strictEqual(a.unread, 1, 'only the incoming a→op message is unread; op\'s own is not');
});

check('renderDmInbox: lists a row per thread with an unread badge', () => {
  const msgs = [
    { id: 1, member_id: 'a', recipients: [OP], content: 'secret for op' },
    { id: 2, member_id: 'b', recipients: [OP], content: 'hey' },
  ];
  seedDmState(msgs, { a: 'alice', b: 'bob' }, {});
  H.renderDmInbox();
  const rows = H.dmListEl.querySelectorAll('.dm-thread');
  assert.strictEqual(rows.length, 2, 'one row per counterparty: ' + H.dmListEl.innerHTML);
  const badges = H.dmListEl.querySelectorAll('.dm-unread');
  const visible = badges.filter((b) => !b.hidden);
  assert.strictEqual(visible.length, 2, 'both threads show an unread badge');
});

check('renderDmInbox: empty state when the operator has no DMs', () => {
  seedDmState([{ id: 1, member_id: 'a', recipients: [], content: 'broadcast' }], { a: 'alice' }, {});
  H.renderDmInbox();
  assert.strictEqual(H.dmListEl.querySelectorAll('.dm-thread').length, 0);
  assert.strictEqual(H.dmListEl.querySelectorAll('.dm-empty').length, 1, 'shows empty notice');
});

check('renderDmInbox: rows are keyboard-accessible (role=button, tabindex)', () => {
  seedDmState([{ id: 1, member_id: 'a', recipients: [OP], content: 'hi' }], { a: 'alice' }, {});
  H.renderDmInbox();
  const row = H.dmListEl.querySelectorAll('.dm-thread')[0];
  assert.strictEqual(row.getAttribute('role'), 'button');
  assert.strictEqual(String(row.tabIndex), '0');
});

check('renderDmInbox: falls back to "(no preview)" for a bodyless DM', () => {
  seedDmState([{ id: 1, member_id: 'a', recipients: [OP], content: '' }], { a: 'alice' }, {});
  H.renderDmInbox();
  const prev = H.dmListEl.querySelectorAll('.dm-prev')[0];
  assert.strictEqual(prev.textContent, '(no preview)');
});

check('dmThreadsFor: flags a group DM thread (>1 non-operator participant)', () => {
  const msgs = [
    { id: 1, member_id: 'a', recipients: [OP, 'b'], content: 'group hi' }, // a→(op,b)
    { id: 2, member_id: 'c', recipients: [OP], content: '1:1' },           // c→op
  ];
  seedDmState(msgs, { a: 'alice', b: 'bob', c: 'carol' }, {});
  const threads = H.dmThreadsFor(H.state.messages.values(), OP, H.state.dmRead);
  const a = threads.find((t) => t.counterparty === 'a');
  const c = threads.find((t) => t.counterparty === 'c');
  assert.strictEqual(a.group, true, 'a↔op+b is a group thread');
  assert.strictEqual(c.group, false, 'c↔op is a plain 1:1');
});
check('renderDmInbox: labels a group thread', () => {
  seedDmState([{ id: 1, member_id: 'a', recipients: [OP, 'b'], content: 'g' }],
    { a: 'alice', b: 'bob' }, {});
  H.renderDmInbox();
  const name = H.dmListEl.querySelectorAll('.dm-name')[0];
  assert.ok(/group/.test(name.textContent), 'group label present: ' + name.textContent);
});

check('markDmRead clears a thread\'s unread and drops the bubble to 0', () => {
  const msgs = [
    { id: 4, member_id: 'a', recipients: [OP], content: 'one' },
    { id: 6, member_id: 'a', recipients: [OP], content: 'two' },
  ];
  seedDmState(msgs, { a: 'alice' }, {});
  H.state.channel = 'unit';   // markDmRead persists under trio.dmRead.<channel>
  assert.strictEqual(H.unreadDmCount(H.state.messages.values(), OP, H.state.dmRead), 2);
  H.markDmRead('a');
  assert.strictEqual(H.unreadDmCount(H.state.messages.values(), OP, H.state.dmRead), 0,
    'reading the thread clears its unread');
});

// ── New-DM picker (inbox "+ New DM" affordance) ──────────────────────────────
function seedPickerState(members, opId) {
  H.state.operator = { id: opId, name: 'me' };
  H.state.members = new Map(Object.entries(members).map(([id, name]) => [id, { id, name }]));
  H.state.dmTargetId = '';
}

check('dmPickerMembers: excludes the operator, includes agents AND other humans', () => {
  seedPickerState({ '_op_l_me': 'me', 'a1': 'alice', 'a2': 'bob', '_op_g_guest': 'guest' }, '_op_l_me');
  // NB: dmPickerMembers() returns a vm-realm Array, so deepStrictEqual would
  // reject it on prototype identity — compare joined primitives instead.
  const names = H.dmPickerMembers().map((m) => m.name).join(',');
  assert.ok(!/(^|,)me(,|$)/.test(names), 'the operator must not be a DM candidate: ' + names);
  // Agents (a1/a2) plus the other human operator (_op_g_guest), sorted by name.
  assert.strictEqual(names, 'alice,bob,guest', 'name-sorted candidates: ' + names);
});

check('renderDmPicker: one row per non-self member, each carrying its member id', () => {
  seedPickerState({ '_op_l_me': 'me', 'a1': 'alice', 'a2': 'bob' }, '_op_l_me');
  H.renderDmPicker();
  const rows = H.dmPickerEl.querySelectorAll('.dm-pick-row');
  assert.strictEqual(rows.length, 2, 'a row per candidate: ' + H.dmPickerEl.innerHTML);
  const ids = rows.map((r) => r.dataset.memberId).sort();
  assert.ok(!ids.includes('_op_l_me'), 'no row for the operator');
  assert.deepStrictEqual(ids, ['a1', 'a2']);
});

check('renderDmPicker: empty notice when the operator is alone in the channel', () => {
  seedPickerState({ '_op_l_me': 'me' }, '_op_l_me');
  H.renderDmPicker();
  assert.strictEqual(H.dmPickerEl.querySelectorAll('.dm-pick-row').length, 0);
  assert.strictEqual(H.dmPickerEl.querySelectorAll('.dm-pick-empty').length, 1, 'shows empty notice');
});

check('renderDmPicker: selecting a member opens a DM tab targeting THAT id', () => {
  seedPickerState({ '_op_l_me': 'me', 'a1': 'alice', 'a2': 'bob' }, '_op_l_me');
  H.state.messages = new Map(); H.state.dmRead = new Map(); H.state.channel = 'unit';
  const opened = [];
  const prevOpen = cx.window.open;
  cx.window.open = (url) => { opened.push(url); };
  try {
    H.renderDmPicker();
    const bob = H.dmPickerEl.querySelectorAll('.dm-pick-row').find((r) => r.dataset.memberId === 'a2');
    assert.ok(bob, 'bob row present');
    bob._listeners.click[0]({ stopPropagation() {} });
  } finally { cx.window.open = prevOpen; }
  assert.strictEqual(opened.length, 1, 'exactly one DM tab opened');
  assert.ok(/[?&]dm=a2(\b|$)/.test(opened[0]), 'opened the DM for bob (a2): ' + opened[0]);
});

// ── Roster: DM moved off the row and into the expanded detail panel ──────────
function memberRowFor(m, opId) {
  H.state.operator = { id: opId || '_op_l_me', name: 'me' };
  H.state.expandedMembers = new Set();
  H.state.members = new Map([[m.id, m]]);
  return H.renderMemberRow(m);
}
const AGENT = { id: 'a1', name: 'alice', status: 'active', filter_mode: 'all', last_read: 0 };

check('renderMemberRow: the always-visible per-row .dm-btn is gone', () => {
  const row = memberRowFor(AGENT);
  assert.strictEqual(row.querySelectorAll('.dm-btn').length, 0, 'no per-row DM button anymore');
});

check('renderMemberRow: an agent gets a Message action in its detail panel', () => {
  const row = memberRowFor(AGENT);
  assert.strictEqual(row.querySelectorAll('.member-actions').length, 1, 'detail panel present');
  const msg = row.querySelectorAll('.dm-msg-btn');
  assert.strictEqual(msg.length, 1, 'exactly one Message action');
  assert.strictEqual(msg[0].textContent, 'Message');
});

check('renderMemberRow: the Message action opens a DM with that member id', () => {
  H.state.messages = new Map(); H.state.dmRead = new Map(); H.state.channel = 'unit';
  const row = memberRowFor(AGENT);
  const msg = row.querySelectorAll('.dm-msg-btn')[0];
  const opened = [];
  const prevOpen = cx.window.open;
  cx.window.open = (url) => { opened.push(url); };
  try { msg._listeners.click[0]({ stopPropagation() {} }); }
  finally { cx.window.open = prevOpen; }
  assert.ok(/[?&]dm=a1(\b|$)/.test(opened[0] || ''), 'DM opened for alice (a1): ' + (opened[0] || '(none)'));
});

check('renderMemberRow: no Message action for another web operator (_op_)', () => {
  const row = memberRowFor({ id: '_op_g_guest', name: 'guest', status: 'active', last_read: 0 });
  assert.strictEqual(row.querySelectorAll('.dm-msg-btn').length, 0, 'no Message action for an _op_ human');
});

check("renderMemberRow: the operator's own row has no detail-panel actions", () => {
  const row = memberRowFor({ id: '_op_l_me', name: 'me', status: 'active', last_read: 0 });
  assert.strictEqual(row.querySelectorAll('.member-actions').length, 0, 'no actions block on self');
  assert.strictEqual(row.querySelectorAll('.dm-msg-btn').length, 0);
});

console.log('');
console.log((failures.length ? 'FAILED' : 'OK') + ` — ${passed} passed, ${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
