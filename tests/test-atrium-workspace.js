const fs = require('fs');
const vm = require('vm');

function baseContext(search = '', pathname = '/') {
  const context = {
    window: {},
    location: { search, pathname, href: 'http://localhost' + pathname + search },
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
loadModule('06-ui.js', base);
loadModule('20-workspace.js', base);
loadModule('40-preferences.js', base);

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('PASS: ' + name); }
  else { console.log('FAIL: ' + name); failures++; }
}

const nav = base.Trio.workspace.groupNavigation([{ code: 'a' }, { code: 'b', archived: true }], { your_dms: [{ key: 'x' }] });
check('navigation grouping', nav.active.length === 1 && nav.archived.length === 1 && nav.yours.length === 1);
check('attention count', base.Trio.workspace.attentionCount({ approvals: [{}, {}] }) === 2);

const s = base.Trio.workspace.selectors;
check('selector attention', s.attention({ approvals: [{}, {}], questions: [{}, {}] }) === 4);
check('selector pending questions', s.pendingQuestions({ questions: [{}, {}] }) === 2);
check('selector unread mentions', s.unreadMentions({ mentions: [{}, {}, {}] }) === 3);
check('selector blocked tasks', s.blockedTasks({ tasks: [{ status: 'open' }, { status: 'blocked' }, { status: 'done' }] }) === 1);
check('selector pending approvals', s.pendingApprovals({ approvals: [{ status: 'open' }, { status: 'resolved' }] }) === 1);
check('selector open tasks', s.openTasks({ tasks: [{ status: 'open' }, { status: 'blocked' }, { status: 'done' }] }) === 2);
check('selector blocked agents', s.blockedAgents({ agents: [{ status: 'error' }, { status: 'working' }] }) === 1);
check('selector unread dms', s.unreadDms({ dms: { your_dms: [{ unread: 3 }, { unread: 0 }, {} ] } }) === 3);
check('selector recent channels', s.recentChannels({ channels: [{ code: 'x' }, { code: 'y', archived: true }, { code: 'z' }] }).length === 2);

// Live-activity indicators (face-pile + channel-drawer): channelStatus must
// prefer the agent-roster {live, busy, state} shape when present so those two
// views agree with the Agent roster page, and toolSuffix must only surface
// the last-tool hint while genuinely mid-turn (not on a stale finished turn).
const cs = base.Trio.workspace.channelStatus;
check('channelStatus: roster-shaped busy agent is working', cs({ live: true, busy: true, state: 'active' }) === 'working');
check('channelStatus: roster-shaped idle agent is idle', cs({ live: true, busy: false, state: 'active' }) === 'idle');
check('channelStatus: roster-shaped dead agent falls back to offline', cs({ live: false, state: 'stopped' }) === 'offline');
check('channelStatus: heartbeat-shaped member reports its own status', cs({ status: 'working' }) === 'working');
check('channelStatus: unrecognized status falls back to offline', cs({ status: 'bogus' }) === 'offline');

const ts = base.Trio.workspace.toolSuffix;
check('toolSuffix: shows the live tool while working', ts({ last_tool_name: 'Bash', last_tool_target: 'npm test' }, 'working') === ' — using Bash: npm test');
check('toolSuffix: omits target when absent', ts({ last_tool_name: 'Read' }, 'working') === ' — using Read');
check('toolSuffix: hidden once the turn has ended (stale trivia)', ts({ last_tool_name: 'Bash' }, 'idle') === '');
check('toolSuffix: hidden when no tool activity recorded', ts({}, 'working') === '');

base.Trio.preferences.selectTheme('light-mist');
check('theme choices include five light and five dark presets', base.Trio.preferences.lightThemes.length === 5 && base.Trio.preferences.darkThemes.length === 5);
check('selecting a light preset saves it as the light default', base.Trio.preferences.read().lightTheme === 'light-mist' && base.Trio.preferences.read().theme === 'light-mist');
base.Trio.preferences.selectTheme('dark-midnight');
check('selecting a dark preset saves it as the dark default', base.Trio.preferences.read().darkTheme === 'dark-midnight' && base.Trio.preferences.read().theme === 'dark-midnight');
base.Trio.preferences.toggle();
check('theme toggle returns to the saved light preset', base.Trio.preferences.read().theme === 'light-mist');

base.Trio.state.dms = { targets: [{ id: 'z', name: 'Zed' }, { id: 'a', name: 'Ada' }] };
check('direct-message targets are sorted by display name', base.Trio.workspace.dmTargets().map(target => target.id).join(',') === 'a,z');

const routerContext = baseContext('', '/tasks');
loadModule('01-store.js', routerContext);
loadModule('03-router.js', routerContext);
check('page path parses as tasks route', routerContext.Trio.router.parse('', '/tasks').name === 'tasks');
check('page route serializes to tasks path', routerContext.Trio.router.serialize({ name: 'tasks', params: {} }) === '/tasks');
check('inbox path maps to attention route', routerContext.Trio.router.parse('', '/inbox').name === 'attention');
check('agent path maps to roster route', routerContext.Trio.router.parse('', '/agents').name === 'roster');
check('settings path maps to preferences route', routerContext.Trio.router.parse('', '/settings').name === 'prefs');
check('conversation query takes precedence over page path', routerContext.Trio.router.parse('?channel=general', '/tasks').name === 'channel');

// Agent-audit clicks are read-only, but they are not archived threads. The
// client must preserve that distinction in the history request.
base.document.querySelector = () => null;
const auditElements = new Map(['h-channel', 'h-meta', 'private-banner'].map(id => [id, {
  classList: { toggle() {} },
  set textContent(value) { this._textContent = value; },
  get textContent() { return this._textContent || ''; },
} ]));
base.document.getElementById = id => auditElements.get(id) || null;
base.Trio.startEvents = () => {};
base.Trio.conversation = { render() {}, upsert() {} };
base.Trio.loader = { cancel() {}, load(_name, fn) { return fn({}); } };
let auditRoute = null;
const auditRequests = [];
base.Trio.router = { navigate(name, params) { auditRoute = { name, params }; } };
base.Trio.api.get = path => { auditRequests.push(path); return Promise.resolve({ messages: [] }); };
base.Trio.workspace.openDm({ key: 'ag_a,ag_b', member_ids: ['ag_a', 'ag_b'], name: 'A ↔ B' }, false, true);
check('agent audit requests active history', auditRequests[0] === '/api/dms?with=ag_a%2Cag_b');
check('agent audit uses audit route', auditRoute?.name === 'audit' && !auditRoute.params.archived);

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
