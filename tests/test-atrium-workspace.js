const fs = require('fs');
const vm = require('vm');

function baseContext(search = '') {
  const context = {
    window: {},
    location: { search, href: 'http://localhost/?' + search },
    URLSearchParams,
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { classList: { toggle() {} } },
      documentElement: { dataset: {} },
    },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.resolve({ ok: false, status: 404 }),
    EventTarget: class { addEventListener() {} dispatchEvent() {} },
    CustomEvent: class {},
    console,
    setInterval() {},
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

function loadModule(name, context) {
  vm.runInContext(fs.readFileSync('server/web/js/' + name, 'utf8'), context);
}

// Base workspace tests run with the default empty search.
const base = baseContext();
loadModule('01-store.js', base);
loadModule('02-api.js', base);
loadModule('05-loader.js', base);
loadModule('04-events.js', base);
loadModule('00-core.js', base);
loadModule('20-workspace.js', base);
loadModule('40-preferences.js', base);

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('PASS: ' + name); }
  else { console.log('FAIL: ' + name); failures++; }
}

const nav = base.Trio.workspace.groupNavigation([{ code: 'a' }, { code: 'b', archived: true }], { your_dms: [{ key: 'x' }] });
check('navigation grouping', nav.active.length === 1 && nav.archived.length === 1 && nav.yours.length === 1);
check('attention count', base.Trio.workspace.attentionCount({ approvals: [{}], tasks: [{ status: 'open' }, { status: 'done' }] }) === 2);

// URL routing contract tests.
function routeFor(search) {
  const cx = baseContext(search);
  loadModule('01-store.js', cx);
  loadModule('02-api.js', cx);
  loadModule('04-events.js', cx);
  loadModule('00-core.js', cx);
  return cx.Trio.state.conversation;
}

const cases = [
  ['empty query', '', { kind: 'unknown', key: '' }],
  ['channel only', '?channel=general', { kind: 'channel', key: 'general' }],
  ['dm only', '?dm=ag_123', { kind: 'dm', key: 'ag_123' }],
  ['dm with comma-joined keys', '?dm=ag_123,ag_456', { kind: 'dm', key: 'ag_123,ag_456' }],
  ['dm with encoded comma', '?dm=ag_123%2Cag_456', { kind: 'dm', key: 'ag_123,ag_456' }],
  ['dm and channel', '?channel=general&dm=ag_123', { kind: 'dm', key: 'ag_123' }],
  ['empty dm value', '?dm=', { kind: 'unknown', key: '' }],
  ['dm with forbidden characters', '?dm=ag_123!bad', { kind: 'unknown', key: '' }],
  ['dm with slash', '?dm=ag/123', { kind: 'unknown', key: '' }],
];
for (const [name, search, expected] of cases) {
  const actual = routeFor(search);
  check(name, actual.kind === expected.kind && actual.key === expected.key);
}

console.log((failures ? 'FAILED' : 'OK') + ' — ' + failures + ' failure(s)');
process.exit(failures ? 1 : 0);
