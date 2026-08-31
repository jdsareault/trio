'use strict';

// Headless coverage for the Tidy up panel (js/46-data.js → the stale-archive
// preview). The properties under test are the ones that make a bulk sweep safe
// to click:
//
//   * channels and agents are SEPARATE controls with independent ages, and
//     each scopes its request to its own kind;
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

const CHANNEL_PREVIEW = {
  ok: true, dry_run: true, agents_unavailable: false,
  channels: [
    { code: 'oldroom', never_active: false, idle_days: 41.2 },
    { code: 'emptyroom', never_active: true, idle_days: 88 },
  ],
  agents: [], skipped: { channels: [], agents: [] },
  counts: { channels: 2, agents: 0 },
};

const AGENT_PREVIEW = {
  ok: true, dry_run: true, agents_unavailable: false,
  channels: [],
  agents: [{ id: 'ag_dead', name: 'Vesper', never_active: false, idle_days: 30.4 }],
  skipped: { channels: [],
             agents: [{ id: 'ag_live', name: 'Atlas', reason: 'running' }] },
  counts: { channels: 0, agents: 1 },
};

// Arrays that cross out of the bundle's vm realm have a different
// Array.prototype, so deepStrictEqual on them fails on the realm alone. Spread
// them into this realm before comparing.
function clickOf(node) {
  assert.ok(node && node._listeners && node._listeners.click,
            'node has a click listener');
  return node._listeners.click[0];
}

// Each sweep is a .tidy-sweep block: its own row, its own days input, its own
// Preview button and its own results host. Addressing them by kind is what
// keeps this test honest about the two being independent.
function sweep(panel, kind) {
  const blocks = panel.querySelectorAll('.tidy-sweep')
    .filter(b => b.querySelectorAll(`.tidy-row-${kind}`).length === 1);
  assert.strictEqual(blocks.length, 1, `one ${kind} sweep`);
  return blocks[0];
}
const daysInputOf = block => block.querySelectorAll('input')
  .filter(i => i.type === 'number')[0];
const previewOf = block => clickOf(block.querySelectorAll('button')
  .filter(b => b.textContent === 'Preview')[0]);

(async () => {
  Trio.api.get = async () => STORAGE;
  const posts = [];
  let nextPreview = CHANNEL_PREVIEW;
  Trio.api.post = async (path, body) => {
    posts.push({ path, body });
    if (body && body.dry_run === false) {
      return { ok: true,
               channels: (body.only_channels || []).map(c => ({ code: c, archived: true })),
               agents: (body.only_agents || []).map(a => ({ id: a, name: a, archived: true })) };
    }
    return nextPreview;
  };
  const toasts = [];
  Trio.ui.toast = m => toasts.push(m);
  let confirmed = null;
  Trio.ui.confirmAction = (message, description, action) => {
    confirmed = { message, description, action };
  };

  const panel = cx.document.createElement('section');
  await Trio.data.renderPage(panel);

  check('channels and agents get SEPARATE controls', () => {
    assert.strictEqual(panel.querySelectorAll('.tidy-sweep').length, 2);
    assert.ok(sweep(panel, 'channel'));
    assert.ok(sweep(panel, 'agent'));
  });
  check('each control carries its own age input, defaulting tighter for '
        + 'agents than for channels', () => {
    assert.strictEqual(daysInputOf(sweep(panel, 'channel')).value, '7');
    assert.strictEqual(daysInputOf(sweep(panel, 'agent')).value, '14');
  });
  check('the agent control says up front that running agents are exempt', () => {
    const desc = sweep(panel, 'agent').querySelector('.dp-desc').textContent;
    assert.ok(/never archived/.test(desc));
  });

  // ── channel sweep ─────────────────────────────────────────────────────────
  const chBlock = sweep(panel, 'channel');
  await previewOf(chBlock)({});

  check('Preview scopes the scan to ONE kind and sends no dry_run override, '
        + 'so the server default (a dry run) applies', () => {
    const p = posts[0];
    assert.strictEqual(p.path, '/api/archives/stale');
    assert.strictEqual([...p.body.kinds].join(), 'channel');
    assert.strictEqual(p.body.older_than_days, 7);
    assert.ok(!('dry_run' in p.body), 'no dry_run key sent');
  });
  check('every candidate is listed by name before anything is archived', () => {
    const names = chBlock.querySelectorAll('.tidy-name').map(n => n.textContent);
    assert.deepStrictEqual(names, ['oldroom', 'emptyroom']);
  });
  check('each row shows its idle age', () => {
    const subs = chBlock.querySelectorAll('.tidy-sub').map(n => n.textContent);
    assert.deepStrictEqual(subs, ['idle 41 days', 'idle 88 days']);
  });
  check('a channel with no messages is badged rather than looking like any '
        + 'other quiet room', () => {
    const badges = chBlock.querySelectorAll('.data-badge').map(b => b.textContent);
    assert.deepStrictEqual(badges, ['no messages']);
  });
  check('every row starts checked, and the footer counts them', () => {
    const boxes = chBlock.querySelectorAll('.tidy-check');
    assert.ok(boxes.length === 2 && boxes.every(b => b.checked));
    assert.strictEqual(chBlock.querySelector('.tidy-count').textContent,
                       '2 channels selected');
  });
  check('the other control is untouched by its neighbour preview', () => {
    assert.strictEqual(sweep(panel, 'agent').querySelectorAll('.tidy-item').length, 0);
  });
  check('the preview archived nothing — only the dry run has been posted', () => {
    assert.strictEqual(posts.length, 1);
  });

  const dropped = chBlock.querySelectorAll('.tidy-check')
    .filter(b => b.dataset.id === 'emptyroom')[0];
  dropped.checked = false;
  dropped._listeners.change[0]({});
  check('unchecking a row updates the count', () => {
    assert.strictEqual(chBlock.querySelector('.tidy-count').textContent,
                       '1 channel selected');
  });

  await clickOf(chBlock.querySelectorAll('.tidy-go')[0])({});
  check('archiving asks for confirmation first, counting only the kind in '
        + 'hand', () => {
    assert.ok(confirmed, 'confirm was requested');
    assert.strictEqual(confirmed.message, 'Archive 1 channel?');
    assert.ok(/sidebar/.test(confirmed.description));
    assert.ok(/Nothing is deleted/.test(confirmed.description));
  });
  await confirmed.action();

  check('the real run sends an ALLOWLIST of exactly the approved ids, scoped '
        + 'to this kind', () => {
    const p = posts[posts.length - 1];
    assert.strictEqual(p.body.dry_run, false);
    assert.strictEqual([...p.body.kinds].join(), 'channel');
    assert.deepStrictEqual([...p.body.only_channels], ['oldroom']);
    assert.ok(!('only_agents' in p.body));
  });
  check('the unchecked row is not in the allowlist, so it cannot be archived', () => {
    assert.ok(!posts[posts.length - 1].body.only_channels.includes('emptyroom'));
  });
  check('the outcome names what actually landed', () => {
    assert.strictEqual(toasts[toasts.length - 1], 'Archived 1 channel.');
  });

  // ── agent sweep ───────────────────────────────────────────────────────────
  // A successful sweep re-renders the whole Data page, so every node captured
  // before it is detached. Re-acquire, exactly as a real click would.
  nextPreview = AGENT_PREVIEW;
  await previewOf(sweep(panel, 'agent'))({});
  const agBlock = sweep(panel, 'agent');

  check('the agent control scans agents at ITS own age, not the channel one', () => {
    const p = posts[posts.length - 1];
    assert.strictEqual([...p.body.kinds].join(), 'agent');
    assert.strictEqual(p.body.older_than_days, 14);
  });
  check('an agent is listed by display name, not by id', () => {
    const names = agBlock.querySelectorAll('.tidy-name').map(n => n.textContent);
    assert.deepStrictEqual(names, ['Vesper']);
  });
  check('running agents are named as left alone, not silently absent', () => {
    const note = agBlock.querySelector('.tidy-skipped');
    assert.ok(note, 'skipped note present');
    assert.ok(note.textContent.includes('Atlas'), 'names the running agent');
    assert.ok(note.textContent.includes('1 running agent'));
  });

  await clickOf(agBlock.querySelectorAll('.tidy-go')[0])({});
  check('the agent confirm speaks about the roster, not the sidebar', () => {
    assert.strictEqual(confirmed.message, 'Archive 1 agent?');
    assert.ok(/roster/.test(confirmed.description));
  });
  await confirmed.action();
  check('the agent run sends only_agents', () => {
    const p = posts[posts.length - 1];
    assert.deepStrictEqual([...p.body.only_agents], ['ag_dead']);
    assert.ok(!('only_channels' in p.body));
  });
  check('the outcome names the agent kind', () => {
    assert.strictEqual(toasts[toasts.length - 1], 'Archived 1 agent.');
  });

  // ── partial failure is reported, not rounded up to success ────────────────
  check('a half-applied sweep names the rows that did not archive', () => {
    assert.strictEqual(Trio.data.tidyOutcome({
      channels: [{ code: 'a', archived: true }, { code: 'b', archived: false }],
      agents: [{ id: 'ag_1', name: 'Rex', archived: false }],
    }), 'Archived 1 channel — could not archive b, Rex.');
  });
  check('a sweep where nothing landed does not say "Archived"', () => {
    assert.ok(Trio.data.tidyOutcome({
      channels: [{ code: 'a', archived: false }], agents: [],
    }).startsWith('Archived nothing'));
  });

  // ── an unparseable age is admitted, not printed as zero ───────────────────
  nextPreview = {
    ok: true, dry_run: true,
    channels: [{ code: 'weird', idle_days: null, never_active: false }],
    agents: [], skipped: {}, counts: {},
  };
  await previewOf(sweep(panel, 'channel'))({});
  check('a row with an unknown age says so rather than claiming 0 days', () => {
    const subs = sweep(panel, 'channel').querySelectorAll('.tidy-sub')
      .map(n => n.textContent);
    assert.deepStrictEqual(subs, ['age unknown']);
  });

  // ── agent control off ─────────────────────────────────────────────────────
  nextPreview = {
    ok: true, dry_run: true, agents_unavailable: true,
    channels: [], agents: [], skipped: {}, counts: { channels: 0, agents: 0 },
  };
  await previewOf(sweep(panel, 'agent'))({});
  check('a server without agent control explains the empty agent list rather '
        + 'than looking broken', () => {
    const block = sweep(panel, 'agent');
    assert.ok(block.querySelector('.tidy-empty'), 'empty message');
    const note = block.querySelector('.tidy-skipped');
    assert.ok(note && /without agent control/.test(note.textContent));
  });

  // ── nothing stale ─────────────────────────────────────────────────────────
  nextPreview = { ok: true, dry_run: true, channels: [], agents: [],
                  skipped: {}, counts: { channels: 0, agents: 0 } };
  await previewOf(sweep(panel, 'channel'))({});
  check('an empty sweep says so in place, with no archive button to press', () => {
    const block = sweep(panel, 'channel');
    assert.ok(block.querySelector('.tidy-empty'), 'empty message');
    assert.strictEqual(block.querySelectorAll('.tidy-foot').length, 0);
  });

  console.log();
  if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
  console.log('0 failure(s)');
})().catch(e => { console.log('FAIL: harness — ' + e.stack); process.exit(1); });
