// The saved-directory client, EXERCISED rather than grepped.
//
// This file exists because the first version of these tests asserted that
// certain strings appeared in server/web/js/15-dirbook.js — including one that
// asserted a comment existed. Those assertions could not fail for any reason
// except a reformat, and could not pass for any reason related to behaviour:
// inverting a comparison left every one of them green. The DOM harness runs
// the actual shipped bundle, so the store can just be called.
//
// Usage: node tests/test-dirbook.js
'use strict';

const assert = require('assert');
const { load } = require('./dom-harness');

const failures = []; let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS: ' + name); }
  catch (e) { failures.push(name); console.log('FAIL: ' + name + ' — ' + e.message); }
}

// The store memoizes on first read, so each scenario needs a fresh context.
// Note: values the harness returns come from a vm sandbox, so their Array and
// Object prototypes are NOT this realm's. assert.deepStrictEqual compares
// prototypes and rejects them; compare contents (join/length) instead.
function withStore(stored, fn) {
  const cx = load();
  if (stored !== undefined) {
    cx.window.localStorage.setItem('trio.dirbook.v1', typeof stored === 'string' ? stored : JSON.stringify(stored));
  }
  return fn(cx.hooks.Trio.dirbook, cx);
}

// ── normalize ───────────────────────────────────────────────────────────────
check('a trailing slash is not part of the identity of a directory', () => {
  withStore(undefined, book => {
    assert.strictEqual(book.normalize('~/Development/'), '~/Development');
    assert.strictEqual(book.normalize('~/Development'), '~/Development');
    assert.strictEqual(book.normalize('~/a//b///c/'), '~/a/b/c');
    assert.strictEqual(book.normalize('  ~/x  '), '~/x');
  });
});

check('root survives normalization as itself', () => {
  withStore(undefined, book => {
    assert.strictEqual(book.normalize('/'), '/');
    assert.strictEqual(book.normalize('//'), '/');
  });
});

check('an over-long path is rejected rather than truncated', () => {
  withStore(undefined, book => assert.strictEqual(book.normalize('~/' + 'a'.repeat(5000)), ''));
});

// ── storage shapes ──────────────────────────────────────────────────────────
check('v1 bare strings load, and their trailing slash is not read as a decision', () => {
  withStore({ v: 1, favorites: ['~/Development/', '~/Development/trio'] }, book => {
    const list = book.list();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list.map(e => e.mode).join(','), 'auto,auto');
  });
});

check('v2 {path, browse} entries load and are also re-judged', () => {
  withStore({ v: 2, favorites: [{ path: '~/a', browse: true }] }, book => {
    assert.strictEqual(book.list()[0].mode, 'auto');
  });
});

check('paths differing only by a trailing slash collapse to one entry', () => {
  withStore({ v: 1, favorites: ['~/Development/', '~/Development'] }, book => {
    assert.strictEqual(book.list().length, 1);
  });
});

check('corrupt storage yields an empty book rather than throwing', () => {
  withStore('{not json', book => assert.strictEqual(book.list().length, 0));
  withStore({ favorites: 'nope' }, book => assert.strictEqual(book.list().length, 0));
  withStore({ favorites: [null, 7, {}, { path: 5 }, { path: 'relative' }] },
    book => assert.strictEqual(book.list().length, 0));
});

check('a bogus mode or guess is discarded, not stored', () => {
  withStore({ v: 3, favorites: [{ path: '~/a', mode: 'sideways', guess: 'banana' }] }, book => {
    assert.strictEqual(book.list()[0].mode, 'auto');
    assert.strictEqual(book.list()[0].guess, null);
  });
});

check('the saved cap is enforced on read and on add', () => {
  const many = Array.from({ length: 60 }, (_, i) => `~/d${i}`);
  withStore({ v: 3, favorites: many.map(path => ({ path, mode: 'auto' })) }, book => {
    assert.strictEqual(book.list().length, book.MAX_FAVORITES);
    assert.strictEqual(book.add('~/one-more').ok, false);
  });
});

// ── add / remove / move / setMode ───────────────────────────────────────────
check('a relative path cannot be saved', () => {
  withStore(undefined, book => assert.strictEqual(book.add('Development').ok, false));
});

check('a duplicate is refused across trailing-slash spellings', () => {
  withStore(undefined, book => {
    assert.strictEqual(book.add('~/a').ok, true);
    assert.strictEqual(book.add('~/a/').ok, false);
  });
});

check('move reports honestly when nothing moved', () => {
  withStore(undefined, book => {
    book.add('~/a'); book.add('~/b');
    assert.strictEqual(book.move('~/a', 0), false, 'a zero delta is not a reorder');
    assert.strictEqual(book.move('~/a', -1), false, 'already first');
    assert.strictEqual(book.move('~/b', 1), false, 'already last');
    assert.strictEqual(book.move('~/nope', 1), false, 'not in the book');
    assert.strictEqual(book.move('~/a', 1), true);
    assert.strictEqual(book.list().map(e => e.path).join(','), '~/b,~/a');
  });
});

check('setMode refuses a mode that is not one of the three', () => {
  withStore(undefined, book => {
    book.add('~/a');
    assert.strictEqual(book.setMode('~/a', 'sideways'), false);
    assert.strictEqual(book.setMode('~/nope', 'project'), false);
    assert.strictEqual(book.setMode('~/a', 'container'), true);
    assert.strictEqual(book.list()[0].mode, 'container');
  });
});

// ── the invariant the whole model exists to protect ─────────────────────────
check('a guess never overwrites an operator decision', () => {
  withStore(undefined, book => {
    book.add('~/a');
    book.setMode('~/a', 'project');
    book.applyGuesses({ '~/a': 'container' });
    const entry = book.find('~/a');
    assert.strictEqual(entry.mode, 'project', 'mode is untouched');
    assert.strictEqual(book.kindOf(entry), 'project', 'and the decision is what counts');
    book.applyGuesses({ '~/a': 'project' });
    book.applyGuesses({ '~/a': 'container' });
    assert.strictEqual(book.kindOf(book.find('~/a')), 'project', 'repeatedly');
  });
});

check('a guess does decide an entry nobody has classified', () => {
  withStore(undefined, book => {
    book.add('~/a');
    assert.strictEqual(book.kindOf(book.find('~/a')), 'project', 'project is the safe default');
    book.applyGuesses({ '~/a': 'container' });
    assert.strictEqual(book.kindOf(book.find('~/a')), 'container');
  });
});

check('a path absent from a batch keeps its guess', () => {
  withStore(undefined, book => {
    book.add('~/a');
    book.applyGuesses({ '~/a': 'container' });
    book.applyGuesses({ '~/b': 'project' });     // a batch that did not include ~/a
    assert.strictEqual(book.kindOf(book.find('~/a')), 'container',
      'absence is "not asked about", not "no longer a container"');
  });
});

check('a bogus guess clears rather than corrupts', () => {
  withStore(undefined, book => {
    book.add('~/a');
    book.applyGuesses({ '~/a': 'banana' });
    assert.strictEqual(book.find('~/a').guess, null);
  });
});

// ── matching ────────────────────────────────────────────────────────────────
function matcher(fn) {
  return withStore({ v: 3, favorites: [
    { path: '~/Development/roam-gen2', mode: 'auto' },
    { path: '~/Development/trio', mode: 'auto' },
    { path: '~/Development/roam-app/mobile_app', mode: 'auto' },
    { path: '~/Development', mode: 'container' },
  ] }, fn);
}

check('a bare name matches saved paths anywhere inside them', () => {
  matcher(book => {
    const hits = book.matchingFavorites('roam').map(m => m.path);
    assert.strictEqual(hits.join(' | '),
      '~/Development/roam-gen2 | ~/Development/roam-app/mobile_app');
  });
});

check('matching ignores case', () => {
  matcher(book => assert.strictEqual(book.matchingFavorites('ROAM').length, 2));
});

check('a prefix match outranks a substring match', () => {
  matcher(book => {
    const hits = book.matchingFavorites('~/Development/r').map(m => m.path);
    assert.strictEqual(hits[0], '~/Development/roam-gen2');
  });
});

check('a saved directory the query has descended into still matches', () => {
  matcher(book => {
    assert.ok(book.matchingFavorites('~/Development/tr').some(m => m.path === '~/Development'));
  });
});

check('regex metacharacters are matched literally, not compiled', () => {
  matcher(book => {
    assert.doesNotThrow(() => book.matchingFavorites('(*['));
    assert.strictEqual(book.matchingFavorites('(*[').length, 0);
  });
});

check('an empty field offers everything; a rejected one offers nothing', () => {
  matcher(book => {
    assert.strictEqual(book.matchingFavorites('').length, 4);
    assert.strictEqual(book.matchingFavorites('~/' + 'a'.repeat(5000)).length, 0,
      'an over-long paste must not read as an empty field');
  });
});

check('the effective kind rides along for the picker to act on', () => {
  matcher(book => {
    const dev = book.matchingFavorites('').find(m => m.path === '~/Development');
    assert.strictEqual(dev.browse, true, 'a container descends when picked');
    const trio = book.matchingFavorites('').find(m => m.path === '~/Development/trio');
    assert.strictEqual(trio.browse, false, 'a project lands');
  });
});

console.log();
if (failures.length) {
  console.log(`${failures.length} FAILED: ` + failures.join('; '));
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
