'use strict';

// Headless coverage for the Tidy up panel (js/46-data.js → the stale-archive
// preview). The properties under test are the ones that make a bulk sweep
// safe to click:
//
//   * Preview NAMES every candidate before anything happens;
//   * unchecking a row keeps it — and the real run sends an ALLOWLIST of the
//     approved ids, not a list of exclusions, so a row that went stale between
//     the two requests can never be swept unseen;
//   * running agents appear as an explicit "left alone" note, not as a gap;
//   * the outcome toast reports a PARTIAL sweep honestly.
const assert = require('assert');
const { load } = require('./dom-harness');
const cx = load();
const Trio = cx.hooks.Trio;
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS: ' + name); }
  catch (e) { failures++; console.log('FAIL: ' + name + ' — ' + e.message); }
}

const STORAGE = {
  ok: true, db_bytes: 1024, db_reclaimable_bytes: 0,
  attachments: { count: 0, bytes: 0 }, by_channel: [],
};

const PREVIEW = {
  ok: true, dry_run: true, older_than_days: 14,
  channels: [
    { code: 'oldroom', last_at: null, never_active: false, idle_days: 41.2 },
    { code: 'emptyroom', last_at: null, never_active: true, idle_days: 88 },
  ],
  agents: [
    { id: 'ag_dead', name: 'Vesper', never_active: false, idle_days: 30.4 },
  ],
  skipped: { channels: [], agents: [
    { id: 'ag_live', name: 'Atlas', idle_days: 99, reason: 'running' },
  ] },
  excluded: { channels: [], agents: [] },
  counts: { channels: 2, agents: 1, skipped_agents: 1 },
};

function clickOf(node) {
  assert.ok(node && node._listeners && node._listeners.click,
            'node has a click listener');
  return node._listeners.click[0];
}

(async () => {
  Trio.api.get = async () => STORAGE;
  const posts = [];
  Trio.api.post = async (path, body) => {
    posts.push({ path, body });
    return body && body.dry_run === false
      ? { ok: true,
          channels: (body.only_channels || []).map(c => ({ code: c, archived: true })),
          agents: (body.only_agents || []).map(a => ({ id: a, name: a, archived: true })) }
      : PREVIEW;
  };
  const toasts = [];
  Trio.ui.toast = m => toasts.push(m);
  let confirmed = null;
  Trio.ui.confirmAction = (message, description, action) => {
    confirmed = { message, description, action };
  };

  const panel = cx.document.createElement('section');
  await Trio.data.renderPage(panel);

  const tidy = panel.querySelectorAll('.data-prune-row')
    .filter(r => r.className.includes('tidy-row'))[0];
  check('the Tidy up control renders with a days input and a Preview button', () => {
    assert.ok(tidy, 'tidy row present');
    assert.ok(tidy.querySelectorAll('input').length === 1, 'days input');
    const btn = tidy.querySelectorAll('button')[0];
    assert.strictEqual(btn.textContent, 'Preview');
  });

  // ── preview ───────────────────────────────────────────────────────────────
  const previewBtn = tidy.querySelectorAll('button')[0];
  await clickOf(previewBtn)({});

  check('Preview posts a workspace-global scan with NO dry_run override, so '
        + 'the server default (a dry run) applies', () => {
    const p = posts[0];
    assert.strictEqual(p.path, '/api/archives/stale');
    assert.strictEqual(p.body.older_than_days, 14);
    assert.ok(!('dry_run' in p.body), 'no dry_run key sent');
  });

  const items = panel.querySelectorAll('.tidy-item');
  check('every candidate is listed by name before anything is archived', () => {
    assert.strictEqual(items.length, 3);
    const names = panel.querySelectorAll('.tidy-name').map(n => n.textContent);
    assert.deepStrictEqual(names, ['oldroom', 'emptyroom', 'Vesper']);
  });
  check('each row shows its idle age', () => {
    const subs = panel.querySelectorAll('.tidy-sub').map(n => n.textContent);
    assert.deepStrictEqual(subs, ['idle 41 days', 'idle 88 days', 'idle 30 days']);
  });
  check('a channel with no messages is badged rather than looking like any '
        + 'other quiet room', () => {
    const badges = panel.querySelectorAll('.data-badge').map(b => b.textContent);
    assert.deepStrictEqual(badges, ['no messages']);
  });
  check('every row starts checked', () => {
    const boxes = panel.querySelectorAll('.tidy-check');
    assert.ok(boxes.length === 3 && boxes.every(b => b.checked));
  });
  check('running agents are named as left alone, not silently absent', () => {
    const note = panel.querySelector('.tidy-skipped');
    assert.ok(note, 'skipped note present');
    assert.ok(note.textContent.includes('Atlas'), 'names the running agent');
    assert.ok(note.textContent.includes('1 running agent'));
  });
  check('the footer counts the selection', () => {
    assert.strictEqual(panel.querySelector('.tidy-count').textContent,
                       '3 items selected');
  });
  check('the preview archived nothing — only the dry run has been posted', () => {
    assert.strictEqual(posts.length, 1);
  });

  // ── unchecking a row keeps it ─────────────────────────────────────────────
  const boxes = panel.querySelectorAll('.tidy-check');
  const dropped = boxes.filter(b => b.dataset.id === 'emptyroom')[0];
  dropped.checked = false;
  dropped._listeners.change[0]({});
  check('unchecking a row updates the count', () => {
    assert.strictEqual(panel.querySelector('.tidy-count').textContent,
                       '2 items selected');
  });

  const go = panel.querySelectorAll('.tidy-go')[0];
  await clickOf(go)({});
  check('archiving asks for confirmation first, naming both kinds', () => {
    assert.ok(confirmed, 'confirm was requested');
    assert.strictEqual(confirmed.message, 'Archive 1 channel and 1 agent?');
  });
  check('the confirmation says archiving is reversible', () => {
    assert.ok(/Nothing is deleted/.test(confirmed.description));
  });
  await confirmed.action();

  check('the real run sends an ALLOWLIST of exactly the approved ids', () => {
    const p = posts[posts.length - 1];
    assert.strictEqual(p.body.dry_run, false);
    assert.deepStrictEqual(p.body.only_channels, ['oldroom']);
    assert.deepStrictEqual(p.body.only_agents, ['ag_dead']);
  });
  check('the unchecked row is not in the allowlist, so it cannot be archived', () => {
    const p = posts[posts.length - 1];
    assert.ok(!p.body.only_channels.includes('emptyroom'));
  });
  check('the outcome names what actually landed', () => {
    assert.strictEqual(toasts[toasts.length - 1],
                       'Archived 1 channel and 1 agent.');
  });

  // ── partial failure is reported, not rounded up to success ────────────────
  check('a half-applied sweep names the rows that did not archive', () => {
    const msg = Trio.data.tidyOutcome({
      channels: [{ code: 'a', archived: true }, { code: 'b', archived: false }],
      agents: [{ id: 'ag_1', name: 'Rex', archived: false }],
    });
    assert.strictEqual(msg, 'Archived 1 channel — could not archive b, Rex.');
  });
  check('a sweep where nothing landed does not say "Archived"', () => {
    const msg = Trio.data.tidyOutcome({
      channels: [{ code: 'a', archived: false }], agents: [],
    });
    assert.ok(msg.startsWith('Archived nothing'));
  });

  // ── an unparseable age is admitted, not printed as zero ───────────────────
  // A successful sweep re-renders the whole Data page, so the button captured
  // before it is detached. Re-acquire, exactly as a real click would.
  const previewBtn2 = clickOf(panel.querySelectorAll('.data-prune-row')
    .filter(r => r.className.includes('tidy-row'))[0]
    .querySelectorAll('button')[0]);

  Trio.api.post = async () => ({
    ok: true, dry_run: true,
    channels: [{ code: 'weird', idle_days: null, never_active: false }],
    agents: [], skipped: { agents: [] }, counts: {},
  });
  await previewBtn2({});
  check('a row with an unknown age says so rather than claiming 0 days', () => {
    const subs = panel.querySelectorAll('.tidy-sub').map(n => n.textContent);
    assert.deepStrictEqual(subs, ['age unknown']);
  });

  // ── nothing stale ─────────────────────────────────────────────────────────
  Trio.api.post = async () => ({
    ok: true, dry_run: true, channels: [], agents: [],
    skipped: { agents: [] }, counts: { channels: 0, agents: 0 },
  });
  await previewBtn2({});
  check('an empty sweep says so in place, with no archive button to press', () => {
    assert.ok(panel.querySelector('.tidy-empty'), 'empty message');
    assert.strictEqual(panel.querySelectorAll('.tidy-foot').length, 0);
  });

  console.log();
  if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
  console.log('0 failure(s)');
})().catch(e => { console.log('FAIL: harness — ' + e.stack); process.exit(1); });
