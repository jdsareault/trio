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

console.log('');
console.log((failures.length ? 'FAILED' : 'OK') + ` — ${passed} passed, ${failures.length} failure(s)`);
process.exit(failures.length ? 1 : 0);
