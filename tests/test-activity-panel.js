'use strict';
// Coverage for the per-agent tool activity panel (js/21-activity.js) and the
// drawer avatar that opens it (detailMember in js/20-workspace.js).
//
// The panel's fetching/paging needs a live DOM and a server; its formatting
// does not. The formatters are where the bugs that matter live — a mis-parsed
// timestamp silently skews every duration the panel exists to show — so they
// are exported and tested here as pure functions, same sandbox pattern as
// test-drawer-subagents.js.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const WEB_JS = n => path.resolve(__dirname, '..', 'server', 'web', 'js', n);

function baseContext() {
  const context = {
    window: {}, location: { search: '', pathname: '/', href: 'http://localhost/' },
    URLSearchParams,
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], createElement: () => ({ classList: { add() {}, remove() {} }, style: {}, append() {}, setAttribute() {} }),
      body: { classList: { toggle() {} }, append() {} }, documentElement: { dataset: {} },
    },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.resolve({ ok: false, status: 404 }),
    EventTarget: class { addEventListener() {} dispatchEvent() {} }, CustomEvent: class {},
    console, setInterval() {}, clearInterval() {}, Date,
  };
  context.window = context; context.globalThis = context;
  vm.createContext(context); return context;
}
const cx = baseContext();
['01-store.js', '02-api.js', '05-loader.js', '04-events.js', '06-core.js', '09-ui.js',
 '20-workspace.js', '21-activity.js']
  .forEach(m => vm.runInContext(fs.readFileSync(WEB_JS(m), 'utf8'), cx));

let failures = 0;
function check(name, cond) { console.log((cond ? 'PASS: ' : 'FAIL: ') + name); if (!cond) failures++; }
const { Trio } = cx;
const { callText, gapLabel, clockOf, listHtml, parseAt } = Trio.activity;
const { detailMember } = Trio.workspace;

// --- the avatar is the trigger --------------------------------------------
const agentRow = detailMember({ id: 'ag_1', name: 'Frost', status: 'working' });
check('an agent avatar is wrapped in a button that names the member',
  agentRow.includes('data-activity-for="ag_1"') && agentRow.includes('member-activity-btn'));
check('the trigger is labelled for screen readers',
  agentRow.includes('aria-label="Tool activity for Frost"'));
// Nothing writes tool_events for a human, so a button there opens an empty
// panel and promises activity that will never appear.
const humanRow = detailMember({ id: 'h_1', name: 'JD', kind: 'human' });
check('a human member gets a plain avatar, not a trigger',
  !humanRow.includes('data-activity-for') && !humanRow.includes('member-activity-btn'));
check('the trigger escapes a hostile display name',
  detailMember({ id: 'ag_2', name: '"><img src=x onerror=alert(1)>' })
    .includes('&quot;&gt;&lt;img'));

// --- what a row says the call was -----------------------------------------
check('a call with a target reads name · target',
  callText({ tool_name: 'Bash', target: 'git' }) === 'Bash · git');
// WebFetch/WebSearch store no target by design. An empty separator dangling
// off the tool name would read as a truncated value rather than an absent one.
check('a call with no target is just the tool name',
  callText({ tool_name: 'WebFetch', target: '' }) === 'WebFetch'
  && callText({ tool_name: 'WebFetch' }) === 'WebFetch');
check('a row with neither degrades to a placeholder, never "undefined"',
  callText({}) === 'tool');

// --- timestamps: the reason the panel exists ------------------------------
// The hook writes offset-aware UTC. A row without an offset must still be read
// as UTC — letting the browser take it as local time skews every gap in the
// panel by the machine's timezone, which is invisible and wrong rather than
// obviously broken.
check('a naive timestamp is read as UTC, not local time',
  parseAt('2026-08-27T10:00:00') === parseAt('2026-08-27T10:00:00Z'));
check('an offset timestamp is honoured',
  parseAt('2026-08-27T10:00:00+00:00') === parseAt('2026-08-27T10:00:00Z'));
check('a malformed timestamp is NaN, so callers can fall back',
  Number.isNaN(parseAt('not-a-date')) && Number.isNaN(parseAt('')) && Number.isNaN(parseAt(null)));
check('clockOf renders zero-padded wall-clock seconds',
  /^\d{2}:\d{2}:\d{2}$/.test(clockOf('2026-08-27T10:00:00Z')));
check('clockOf on a bad timestamp is empty, never "NaN:NaN:NaN"',
  clockOf('nonsense') === '' && clockOf(null) === '');

// --- gaps: pace, at the resolution tool calls actually land ---------------
// Claude Code dispatches tools in parallel, so a batch shares a timestamp and
// sub-second gaps are the common case, not an edge one. Rounding those to "0s"
// would erase exactly the burst behaviour the column is read for.
check('a sub-second gap keeps millisecond resolution', gapLabel(340) === '+340ms');
check('a zero gap is shown as such, not blank', gapLabel(0) === '+0ms');
check('seconds get one decimal under 10s', gapLabel(1200) === '+1.2s');
check('seconds drop the decimal above 10s', gapLabel(46000) === '+46s');
check('a minute gap reads in minutes and seconds',
  gapLabel(60000) === '+1m' && gapLabel(90000) === '+1m30s');
check('an hour gap reads in hours', gapLabel(3600000) === '+1h');
// Clock skew between writers can produce a negative delta. Rendering "+-4s"
// would be noise; the row is still worth showing without a gap.
check('a negative or unknown gap renders nothing, not garbage',
  gapLabel(-4000) === '' && gapLabel(NaN) === '' && gapLabel(undefined) === '');

// --- the list -------------------------------------------------------------
const iso = ms => new Date(ms).toISOString();
const t0 = Date.parse('2026-08-27T10:00:00Z');
// Newest-first, exactly as the endpoint returns them.
const events = [
  { id: 3, tool_name: 'Bash', target: 'git', created_at: iso(t0 + 5000) },
  { id: 2, tool_name: 'Read', target: 'nth_web.py', created_at: iso(t0 + 1000) },
  { id: 1, tool_name: 'Task', target: 'sauron: audit', created_at: iso(t0) },
];
const html = listHtml(events);
check('every call is rendered', ['git', 'nth_web.py', 'sauron: audit'].every(t => html.includes(t)));
// The gap belongs to the row above the call it is measured from: rows descend
// in time, so row i's gap is against row i+1.
check('gaps are measured against the previous (older) call',
  html.includes('+4s') && html.includes('+1s'));
check('the oldest row has no gap to measure',
  (html.match(/act-gap">\+/g) || []).length === 2);
check('rows carry a day heading', html.includes('act-day'));
check('an empty ring says so, and says why nothing is there',
  listHtml([]).includes('No recorded tool calls') && listHtml([]).includes('activity hook'));
// The target is hook-captured text (a filename, a grep pattern, an
// agent-authored Task description) — all attacker-influencable.
check('a hostile target is escaped',
  listHtml([{ id: 1, tool_name: 'Grep', target: '<img src=x onerror=alert(1)>', created_at: iso(t0) }])
    .includes('&lt;img src=x') === true);
check('a row with a broken timestamp still renders, with a dash for the time',
  listHtml([{ id: 1, tool_name: 'Bash', target: 'git', created_at: 'nonsense' }]).includes('—'));

console.log();
console.log((failures ? 'FAILED' : 'OK') + ` — ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
