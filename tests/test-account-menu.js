// Regression coverage for the inline account menu (openAccountMenu /
// closeAccountMenu in 20-workspace.js), run against the ACTUAL shipped bundle
// via the Node DOM harness. Guards the LOTC findings from the inline-menu
// rework:
//   • Toggle reads the SYNCHRONOUS aria-expanded, not the deferred `.open`
//     class — a re-click inside the double-rAF window must CLOSE, not re-open
//     (Sauron).
//   • In the collapsed 56px rail the menu can't render — clicking the avatar
//     expands the sidebar instead of lighting up a dead toggle (Frodo).
//   • Items are a plain disclosure (data-view + no role=menuitem) (Gollum/Frodo).
//
// The state that matters is all set SYNCHRONOUSLY (aria-expanded, inert,
// innerHTML); only the `.open` class + focus move happen in the rAF, which we
// deliberately don't assert on. Usage: node tests/test-account-menu.js
'use strict';

const assert = require('assert');
const { load } = require('./dom-harness');

const failures = []; let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failures.push(name); console.log('FAIL: ' + name + ' — ' + e.message); }
}

const cx = load();
const doc = cx.document;
const Trio = cx.hooks.Trio;
const ws = Trio.workspace;

function resetDom() {
  doc.getElementById('app').classList.remove('sidebar-collapsed');
  doc.getElementById('account').classList.remove('open');
  doc.getElementById('account-trigger').setAttribute('aria-expanded', 'false');
  const items = doc.getElementById('account-items');
  items.innerHTML = '';
  items.setAttribute('inert', '');
  items.setAttribute('aria-hidden', 'true');
}

check('open sets aria-expanded and reveals the items', () => {
  resetDom();
  ws.openAccountMenu();
  const trigger = doc.getElementById('account-trigger');
  const items = doc.getElementById('account-items');
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(items.hasAttribute('inert'), false, 'items become interactive');
  assert.strictEqual(items.getAttribute('aria-hidden'), 'false');
  // Two entries are gated on their owning module having loaded — Data
  // (Trio.data) and Directories (Trio.dirbook). Both are present in the
  // harness, so count what is actually gated rather than a bare number that
  // has to be edited every time the menu grows.
  const gated = [Trio.data && Trio.data.renderPage, Trio.dirbook && Trio.dirbook.renderPage];
  const expected = 2 + gated.filter(Boolean).length;
  const entries = [...items.querySelectorAll('.account-item')];
  assert.strictEqual(entries.length, expected);
  // Order is the thing a person actually sees, and it is what a careless
  // insertion breaks. Settings first, then Directories, then Archive.
  assert.deepStrictEqual(
    entries.map(el => el.getAttribute('data-view')).filter(v => ['prefs', 'dirs', 'archive'].includes(v)),
    ['prefs', 'dirs', 'archive']);
});

check('re-click closes via synchronous aria-expanded, not the deferred .open (Sauron)', () => {
  resetDom();
  ws.openAccountMenu();   // open — .open is only added ~2 rAFs later
  ws.openAccountMenu();   // immediate re-click must CLOSE, not re-open
  const trigger = doc.getElementById('account-trigger');
  const items = doc.getElementById('account-items');
  assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false', 'a re-click closes');
  assert.strictEqual(items.hasAttribute('inert'), true, 'closed items are inert again');
});

check('collapsed rail expands the sidebar instead of a dead toggle (Frodo)', () => {
  resetDom();
  doc.getElementById('app').classList.add('sidebar-collapsed');
  let toggled = 0;
  const savedSidebar = Trio.sidebar;
  Trio.sidebar = { toggle: () => { toggled++; } };
  try {
    ws.openAccountMenu();
  } finally { Trio.sidebar = savedSidebar; }
  assert.strictEqual(toggled, 1, 'sidebar expand (toggle) was called');
  assert.strictEqual(doc.getElementById('account-trigger').getAttribute('aria-expanded'), 'false',
    'the menu did NOT open in collapsed mode');
});

check('items are a plain disclosure — data-view, no role=menuitem (Gollum/Frodo)', () => {
  resetDom();
  ws.openAccountMenu();
  const first = doc.getElementById('account-items').querySelector('.account-item');
  assert.ok(first, 'an item rendered');
  assert.ok(first.getAttribute('data-view'), 'uses data-view');
  assert.strictEqual(first.getAttribute('role'), null, 'no role=menuitem on a disclosure');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error('FAILURES: ' + failures.join(', ')); process.exit(1); }
