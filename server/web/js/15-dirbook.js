(() => {
  'use strict';
  const Trio = window.Trio;
  // Saved working directories, kept in their OWN localStorage key rather than
  // trio.preferences.v1. Two reasons: the preference schema's cast() only
  // knows booleans, numbers and enums (an ordered list of strings would mean
  // teaching it a fourth kind), and a directory book is operator data, not a
  // display setting — losing a theme is nothing, losing the list of projects
  // you spawn agents into is annoying.
  const KEY = 'trio.dirbook.v1';
  const MAX_FAVORITES = 50;
  const MAX_LEN = 4096;              // matches the server's _PATH_MAX_LEN

  // An entry is { path, mode, guess }.
  //
  //   mode   'auto' | 'project' | 'container'  — the operator's decision, or
  //          the absence of one. 'auto' means "nobody has said", which is a
  //          different fact from "someone said project", and the two must not
  //          collapse: a guess that overwrote a choice would be a bug the
  //          operator could only fix by noticing it had happened.
  //   guess  the server's classification, cached so the picker can act on it
  //          without a round trip. Refreshed whenever the Directories page
  //          loads; only consulted when mode is 'auto'.
  //
  // The kind decides what picking the entry DOES:
  //   project    fill the field and stop — you are there
  //   container  fill it with a trailing / and keep listing, because the point
  //              of ~/Development is what is inside it, never itself
  //
  // This used to be inferred from a trailing slash, which was wrong twice
  // over: a slash is a typing accident, not a statement about a directory, and
  // the picker appends one to everything it fills in — so saving anything you
  // had browsed to marked it a container, and every entry wore the same label.
  //
  // Paths are stored EXACTLY as typed otherwise, `~` and all. Expanding one
  // here would bake this browser's idea of $HOME into a value only the hub can
  // resolve — the dashboard is routinely opened from a phone over the tailnet.
  const MODES = ['auto', 'project', 'container'];
  function normalize(raw) {
    const path = String(raw ?? '').trim();
    if (!path || path.length > MAX_LEN) return '';
    // Collapse slash runs, then drop a trailing slash: "~/Development/" and
    // "~/Development" are one directory, and storing them as two entries that
    // look identical on screen is how the old scheme let duplicates in.
    const collapsed = path.replace(/\/{2,}/g, '/');
    return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  }
  // What this entry actually is, right now. An unclassified directory reads as
  // a project: that is the commoner case, and being wrong that way costs one
  // keystroke rather than burying the path you asked for under a listing.
  function kindOf(entry) {
    if (!entry) return 'project';
    return entry.mode === 'auto' ? (entry.guess || 'project') : entry.mode;
  }
  function isAbsoluteish(path) { return /^[~/]/.test(path); }

  function readFromStorage() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      const stored = Array.isArray(raw.favorites) ? raw.favorites : [];
      const seen = new Set();
      const favorites = [];
      for (const entry of stored) {
        // Older shapes: v1 stored bare strings, v2 a `browse` boolean. Both
        // encoded the kind as a trailing slash somewhere up the chain, and
        // that slash came from the picker rather than from the operator — so
        // it is not evidence of intent and is NOT read forward as a decision.
        // Everything older arrives as 'auto' and gets classified on its
        // merits, which is also what repairs the entries the old bug mislabelled.
        const isObject = entry && typeof entry === 'object';
        const path = normalize(isObject ? entry.path : entry);
        const mode = isObject && MODES.includes(entry.mode) ? entry.mode : 'auto';
        const guess = isObject && (entry.guess === 'project' || entry.guess === 'container')
          ? entry.guess : null;
        if (!path || !isAbsoluteish(path) || seen.has(path)) continue;
        seen.add(path);
        favorites.push({ path, mode, guess });
        if (favorites.length >= MAX_FAVORITES) break;
      }
      return { favorites };
    } catch { return { favorites: [] }; }
  }
  let cache = null;
  function state() { return (cache ||= readFromStorage()); }
  function write(favorites) {
    cache = { favorites: favorites.slice(0, MAX_FAVORITES) };
    try { localStorage.setItem(KEY, JSON.stringify({ v: 3, favorites: cache.favorites })); } catch { /* private mode / quota */ }
    Trio.events?.dispatchEvent?.(new CustomEvent('dirbook:changed', { detail: { favorites: cache.favorites } }));
    return cache.favorites;
  }

  function list() { return state().favorites.map(entry => ({ ...entry })); }
  function paths() { return state().favorites.map(entry => entry.path); }
  function find(rawPath) {
    const path = normalize(rawPath);
    return state().favorites.find(entry => entry.path === path) || null;
  }
  function has(rawPath) { return !!find(rawPath); }
  function add(rawPath, options = {}) {
    const path = normalize(rawPath);
    if (!path || !isAbsoluteish(path)) return { ok: false, error: 'Give an absolute path or one starting with ~.' };
    const favorites = state().favorites.slice();
    if (favorites.some(entry => entry.path === path)) return { ok: false, error: 'Already saved.' };
    if (favorites.length >= MAX_FAVORITES) return { ok: false, error: `At most ${MAX_FAVORITES} saved directories.` };
    favorites.push({ path, mode: MODES.includes(options.mode) ? options.mode : 'auto', guess: null });
    write(favorites);
    return { ok: true, path };
  }
  function remove(rawPath) {
    const path = normalize(rawPath);
    const favorites = state().favorites.filter(entry => entry.path !== path);
    if (favorites.length === state().favorites.length) return false;
    write(favorites);
    return true;
  }
  function setMode(rawPath, mode) {
    if (!MODES.includes(mode)) return false;
    const path = normalize(rawPath);
    if (!state().favorites.some(entry => entry.path === path)) return false;
    write(state().favorites.map(entry => entry.path === path ? { ...entry, mode } : entry));
    return true;
  }
  // Fold a fresh batch of server classifications into the cache. Only `guess`
  // moves; an operator's own choice is never touched by a guess.
  function applyGuesses(byPath) {
    let changed = false;
    const favorites = state().favorites.map(entry => {
      const guess = byPath?.[entry.path];
      const next = guess === 'project' || guess === 'container' ? guess : null;
      if (next === entry.guess) return entry;
      changed = true;
      return { ...entry, guess: next };
    });
    if (changed) write(favorites);
    return changed;
  }
  function move(rawPath, delta) {
    const path = normalize(rawPath);
    const favorites = state().favorites.slice();
    const from = favorites.findIndex(entry => entry.path === path);
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= favorites.length) return false;
    favorites.splice(to, 0, favorites.splice(from, 1)[0]);
    write(favorites);
    return true;
  }

  // ── server-side child-directory completion ───────────────────────────────
  // Only the hub can answer "what is inside ~/Development" — the browser has
  // no filesystem. /api/path/complete is gated to the same trusted tiers as
  // /api/path/validate, so a guest simply gets no suggestions (a 403 here is
  // an expected outcome, not an error worth toasting).
  let completionsDenied = false;
  async function complete(prefix, options = {}) {
    if (completionsDenied) return [];
    // Sent as typed, NOT normalized: the trailing slash is the difference
    // between "list what is inside ~/Development" and "find things named
    // Development", and normalize() strips it.
    const value = String(prefix ?? '').trim();
    if (!value || !isAbsoluteish(value) || value.length > MAX_LEN) return [];
    try {
      const data = await Trio.api.post('/api/path/complete', { prefix: value }, false, options);
      return Array.isArray(data?.dirs) ? data.dirs : [];
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // 403 means this viewer is not a trusted operator and never will be for
      // the life of the page; stop asking rather than firing a request per
      // keystroke that can only fail.
      if (err?.status === 403) completionsDenied = true;
      return [];
    }
  }

  // Existence + classification for saved paths, in one round trip. The kind is
  // the server's GUESS: only the hub can see the disk, and only it can tell a
  // repository from a folder of repositories.
  async function inspect(pathList, options = {}) {
    if (!Array.isArray(pathList) || !pathList.length) return {};
    try {
      const data = await Trio.api.post('/api/path/inspect', { paths: pathList }, false, options);
      return data?.info && typeof data.info === 'object' ? data.info : {};
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      return {};                       // a guest gets no badges; not an error
    }
  }

  // Favorites relevant to what has been typed, offered above the live
  // filesystem results.
  //
  // Matching is SUBSTRING, not prefix. You save a directory to stop typing its
  // path, so the thing you reach for is its NAME — "roam" should find both
  // ~/Development/roam-gen2 and ~/Development/roam-app/mobile_app. Prefix-only
  // matching meant the saved list went blank the moment you typed anything
  // that was not the start of a path, which read as the feature being missing
  // rather than as it being picky.
  //
  // Ranked so the more literal reading still wins: paths that START with the
  // query, then a saved directory the query has descended INTO, then anything
  // that merely contains it. Array.sort is stable, so saved order breaks ties.
  function matchingFavorites(query) {
    const typed = String(query ?? '').trim().toLowerCase();
    const q = normalize(query).toLowerCase();
    const all = state().favorites;
    if (!q) return all.map(entry => ({ path: entry.path, name: entry.path, kind: 'saved', browse: kindOf(entry) === 'container' }));
    const scored = [];
    for (const entry of all) {
      const lower = entry.path.toLowerCase();
      let rank = -1;
      if (lower.startsWith(q)) rank = 0;
      else if (typed.startsWith(lower + '/')) rank = 1;
      else if (lower.includes(q)) rank = 2;
      if (rank >= 0) scored.push({ path: entry.path, name: entry.path, kind: 'saved', browse: kindOf(entry) === 'container', rank });
    }
    return scored.sort((a, b) => a.rank - b.rank)
      .map(m => ({ path: m.path, name: m.name, kind: m.kind, browse: m.browse }));
  }
  Trio.dirbook = { KEY, MAX_FAVORITES, MODES, list, paths, find, has, add, remove, setMode, applyGuesses, move, kindOf, complete, inspect, normalize, matchingFavorites };
})();

(() => {
  'use strict';
  const Trio = window.Trio;
  const book = Trio.dirbook;
  const { list, paths, add, remove, setMode, move, kindOf } = book;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const COMPLETE_DEBOUNCE_MS = 120;

  const STAR_FILLED = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6.1L12 16.8 6.7 19.7l1.1-6.1L3.4 9.4l6-.8Z"/></svg>';
  const STAR_OUTLINE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="m12 3.9 2.3 4.9 5.3.7-3.9 3.7 1 5.4L12 16l-4.7 2.6 1-5.4L4.4 9.5l5.3-.7Z"/></svg>';

  // Turn a plain <input> into a directory picker. The input keeps its name and
  // stays inside its <form>, so every existing FormData read of it is
  // unaffected — this only wraps it and hangs a dropdown off the wrapper.
  function attachPathInput(input, options = {}) {
    if (!input || input.dataset.dirbook === 'on') return () => {};
    input.dataset.dirbook = 'on';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');

    const wrap = document.createElement('div');
    wrap.className = 'dirbook-field';
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input);

    // The star is the only way to save a path from a field that has no Save
    // button of its own. Where one exists (the Directories page) it is a
    // second control for the same job, so callers can turn it off.
    const wantStar = options.star !== false;
    const star = document.createElement('button');
    star.type = 'button';                 // never submit the surrounding form
    star.className = 'dirbook-star';
    if (wantStar) { wrap.append(star); } else { wrap.classList.add('no-star'); }

    const pop = document.createElement('div');
    pop.className = 'dirbook-pop';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;
    wrap.append(pop);

    let items = [];
    let index = -1;
    let debounce = null;
    let inflight = null;
    let requestSeq = 0;

    function syncStar() {
      if (!wantStar) return;
      const path = book.normalize(input.value);
      const saved = !!path && book.has(path);
      star.innerHTML = saved ? STAR_FILLED : STAR_OUTLINE;
      star.classList.toggle('on', saved);
      star.disabled = !path;
      star.title = !path ? 'Type a path to save it'
        : saved ? 'Remove from saved directories' : 'Save this directory';
      star.setAttribute('aria-label', star.title);
    }
    // Track focus ourselves rather than reading document.activeElement. The
    // guard below decides whether the dropdown may draw at all, so it must be
    // something this module sets and can reason about — activeElement is a
    // global the page can move out from under us (and which some DOM
    // implementations never populate at all).
    let hasFocus = false;
    function focused() { return hasFocus; }
    function close() {
      clearTimeout(debounce); inflight?.abort();
      pop.hidden = true; pop.replaceChildren();
      items = []; index = -1;
      input.setAttribute('aria-expanded', 'false');
    }
    // Move the highlight without rebuilding the list. Rebuilding under the
    // pointer is what lets a stale :hover and the keyboard selection both look
    // active at once; there is exactly one highlight and this is what moves it.
    function highlight(next) {
      index = next;
      pop.querySelectorAll('.dirbook-opt').forEach((button, i) => {
        button.classList.toggle('hi', i === index);
        button.setAttribute('aria-selected', String(i === index));
      });
    }
    function render() {
      // Never reopen behind the operator's back. A debounced keystroke or a
      // slow completion can land AFTER a click-away, and reopening then is
      // what made this feel impossible to dismiss with anything but Escape.
      if (!items.length || !focused()) { close(); return; }
      pop.innerHTML = items.map((item, i) => {
        const label = item.kind === 'saved' ? item.path : item.name;
        const sub = item.kind === 'saved' ? (item.browse ? 'saved · browse' : 'saved') : (item.parent || '');
        return `<button type="button" class="dirbook-opt${i === index ? ' hi' : ''}" data-index="${i}" role="option" aria-selected="${i === index}">`
          + `<span class="dirbook-icon">${item.kind === 'saved' ? '★' : '›'}</span>`
          + `<span class="dirbook-name">${esc(label)}</span>`
          + `<span class="dirbook-sub">${esc(sub)}</span></button>`;
      }).join('');
      // mousedown, not click: the input's blur would tear the popup down
      // before a click ever landed.
      pop.querySelectorAll('.dirbook-opt').forEach(button => {
        const i = Number(button.dataset.index);
        button.addEventListener('mousedown', event => { event.preventDefault(); choose(i); });
        // Pointing at a row MOVES the one highlight rather than adding a
        // second one, so arrowing away from a hovered row leaves nothing
        // behind. The CSS deliberately has no :hover rule for this reason.
        // mousemove, not mouseenter: the list rebuilds under a stationary
        // pointer, and mouseenter would re-fire and yank the selection back.
        button.addEventListener('mousemove', () => { if (index !== i) highlight(i); });
      });
      pop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function move(delta) {
      if (!items.length) return;
      highlight((index + delta + items.length) % items.length);
    }
    function choose(i) {
      const item = items[i];
      if (!item) return;
      const path = book.normalize(item.path);
      // Whether picking this DESCENDS into it or LANDS on it:
      //   • a live filesystem suggestion always descends — you are browsing,
      //     and the next thing you want is what is inside
      //   • a saved entry does what it was saved to do. A container is only
      //     ever useful for its contents; a project is the destination, so
      //     landing on it and closing is the whole point of having saved it.
      const descend = item.kind !== 'saved' || item.browse;
      input.value = descend ? path + '/' : path;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      hasFocus = true;
      input.focus();
      if (descend) refresh();
      else close();
    }
    async function refresh() {
      const typed = book.normalize(input.value);
      syncStar();
      if (!focused()) { close(); return; }
      const seq = ++requestSeq;
      const normalized = book.normalize(typed);
      const saved = book.matchingFavorites(typed)
        .filter(fav => fav.path !== normalized);   // don't offer what is already there
      // A bare name like "roam" is not a path, so there is nothing for the
      // server to complete — but the saved list can still answer it, and that
      // is the whole point of saving one. Show those and skip the request.
      if (!typed || !/^[~/]/.test(typed)) {
        items = saved.slice(0, 8); index = items.length ? 0 : -1; render(); return;
      }
      // Show saved matches immediately; the network result folds in when it
      // arrives, so the list never blanks out mid-type.
      items = saved.slice(0, 4); index = items.length ? 0 : -1; render();
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      let dirs = [];
      try { dirs = await book.complete(typed, { signal: controller.signal }); }
      catch { return; }                            // aborted by a newer keystroke
      if (seq !== requestSeq) return;              // a newer request won
      const savedPaths = new Set(saved.map(fav => fav.path));
      const fresh = dirs.filter(dir => !savedPaths.has(book.normalize(dir.path)));
      items = saved.slice(0, 4).concat(fresh.slice(0, 8));
      index = items.length ? 0 : -1;
      render();
    }
    function scheduleRefresh() { clearTimeout(debounce); debounce = setTimeout(refresh, COMPLETE_DEBOUNCE_MS); }

    const onInput = () => { syncStar(); scheduleRefresh(); };
    const onFocus = () => { hasFocus = true; refresh(); };
    // Clicking anywhere else dismisses it. close() also kills the pending
    // debounce and the in-flight completion, so nothing arrives later and
    // puts the list back on screen.
    const onBlur = () => { hasFocus = false; close(); };
    const onKeyDown = event => {
      if (pop.hidden) {
        if (event.key === 'ArrowDown') { event.preventDefault(); refresh(); }
        return;
      }
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      // Enter accepts a highlighted suggestion rather than submitting the form
      // — a half-typed path submitted by reflex is the failure this is meant
      // to prevent. With nothing highlighted, Enter falls through to the form.
      else if ((event.key === 'Enter' || event.key === 'Tab') && index >= 0) { event.preventDefault(); choose(index); }
    };
    const onStar = () => {
      const path = book.normalize(input.value);
      if (!path) return;
      if (book.has(path)) { book.remove(path); Trio.ui?.toast?.(`Removed ${path}`); }
      else {
        const result = book.add(path);
        if (!result.ok) { Trio.ui?.toast?.(result.error); return; }
        Trio.ui?.toast?.(`Saved ${path}`);
      }
      syncStar();
    };
    const onBookChanged = () => syncStar();

    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);
    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKeyDown);
    star.addEventListener('click', onStar);
    Trio.events?.addEventListener?.('dirbook:changed', onBookChanged);
    syncStar();
    if (options.openOnAttach) { hasFocus = true; refresh(); }

    return function detach() {
      clearTimeout(debounce); inflight?.abort(); close();
      input.removeEventListener('input', onInput);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('keydown', onKeyDown);
      Trio.events?.removeEventListener?.('dirbook:changed', onBookChanged);
      delete input.dataset.dirbook;
    };
  }

  // ── the Directories page ─────────────────────────────────────────────────
  // Built in the same idiom as Archive and Data — page-head, a full-width
  // control, then flat sectioned rows. The first cut used the Preferences
  // card language (.pref-group, centred at 720px inside a 1040px column),
  // which put the heading and the cards on two different left edges and made
  // the page read as bolted on. This is a LIST page, so it looks like the
  // other list pages.
  function renderPage(panel) {
    panel.replaceChildren();
    const head = document.createElement('div');
    head.className = 'page-head';
    head.innerHTML = '<h2>Directories</h2>'
      + '<p class="page-sub">The working directories you spawn agents into. '
      + 'Saved here, they are offered wherever a working directory is asked for.</p>';

    const form = document.createElement('form');
    form.className = 'dirbook-add';
    form.innerHTML = '<input name="path" class="page-search" autocomplete="off" '
      + 'placeholder="Type a path to browse, or a name to find one you saved" '
      + 'aria-label="Directory to save">'
      + '<button type="submit" class="dp-btn">Save</button>';
    const input = form.querySelector('input');

    const hint = document.createElement('p');
    hint.className = 'dirbook-hint';
    hint.innerHTML = 'Subdirectories appear as you type — <kbd>&uarr;</kbd><kbd>&darr;</kbd> to move, '
      + '<kbd>Enter</kbd> to step in. Each saved directory is a <strong>project</strong> '
      + '(picking it fills the field and stops) or a <strong>container</strong> '
      + '(picking it lists what is inside, which is what you want for <code>~/Development</code>). '
      + 'That is detected from what is on disk — click the label to overrule it.';

    const section = document.createElement('section');
    section.className = 'dirbook-section';
    section.innerHTML = '<h3>Saved</h3>';
    const listEl = document.createElement('ul');
    listEl.className = 'dirbook-list';
    section.append(listEl);

    // Paths rot: a project gets renamed or moved and the saved entry silently
    // stops working, which you would otherwise only discover when an agent
    // fails to start. /api/path/validate already answers this, so the page
    // says so up front. A guest gets a 403 and simply no badges.
    let missing = new Set();
    let why = {};
    // One round trip answers both questions the page asks about a saved path:
    // is it still there, and what does it look like. The kind only ever fills
    // in for entries the operator has not classified themselves.
    async function refreshInfo() {
      const saved = paths();
      if (!saved.length) return;
      const info = await book.inspect(saved);
      if (!Object.keys(info).length) return;      // guest, or request failed
      missing = new Set(saved.filter(path => info[path] && info[path].exists === false));
      why = {};
      const guesses = {};
      for (const [path, entry] of Object.entries(info)) {
        guesses[path] = entry?.kind || null;
        if (entry?.why) why[path] = entry.why;
      }
      book.applyGuesses(guesses);
      draw();
    }
    function draw() {
      const favorites = list();
      if (!favorites.length) {
        listEl.innerHTML = '<li class="dirbook-empty">Nothing saved yet. Add one above, '
          + 'or use the &#9733; beside any working-directory field.</li>';
        return;
      }
      listEl.innerHTML = favorites.map((entry, i) => {
        const { path, mode } = entry;
        const kind = kindOf(entry);
        const gone = missing.has(path);
        const auto = mode === 'auto';
        // The tag is the control. It states what the entry IS, says whether
        // that was detected or chosen, and cycles auto → project → container
        // on click — so an operator who disagrees with the guess fixes it
        // where they read it, and can hand the decision back.
        const next = auto ? 'project' : mode === 'project' ? 'container' : 'auto';
        const detected = auto
          ? (why[path] ? `Detected: ${kind} — ${why[path]}.` : `Detected: ${kind}.`)
          : `Set to ${kind}.`;
        const title = `${detected} Click to ${next === 'auto' ? 'go back to detecting it' : 'set ' + next}.`;
        return `<li class="dirbook-row${gone ? ' gone' : ''}" data-path="${esc(path)}">`
          + `<span class="dirbook-label">`
          + `<span class="dirbook-name">${esc(path)}</span>`
          + (gone ? '<span class="dirbook-tag warn" title="No directory at this path right now">missing</span>' : '')
          + `</span>`
          + `<span class="dirbook-actions">`
          + `<button type="button" class="dirbook-kind ${esc(kind)}${auto ? ' auto' : ''}" data-act="mode" `
          + `title="${esc(title)}" aria-label="${esc(path)}: ${esc(title)}">${esc(kind)}</button>`
          + `<button type="button" class="dirbook-act" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(path)} up">&uarr;</button>`
          + `<button type="button" class="dirbook-act" data-act="down" ${i === favorites.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(path)} down">&darr;</button>`
          + `<button type="button" class="dirbook-act danger" data-act="remove" aria-label="Remove ${esc(path)}">&#10005;</button>`
          + `</span></li>`;
      }).join('');
    }
    listEl.addEventListener('click', event => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const row = button.closest('.dirbook-row');
      const path = row?.dataset.path;
      if (!path) return;
      const act = button.dataset.act;
      if (act === 'remove') remove(path);
      else if (act === 'mode') {
        const mode = book.find(path)?.mode || 'auto';
        setMode(path, mode === 'auto' ? 'project' : mode === 'project' ? 'container' : 'auto');
      }
      else move(path, act === 'up' ? -1 : 1);
      draw();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const result = add(input.value);
      if (!result.ok) { Trio.ui?.toast?.(result.error); return; }
      input.value = '';
      draw();
      refreshInfo();
    });
    draw();
    panel.append(head, form, hint, section);
    // No star here: this field has a Save button, and two controls for one job
    // is one too many.
    attachPathInput(input, { star: false });
    refreshInfo();
    return panel;
  }

  Object.assign(Trio.dirbook, { attachPathInput, renderPage });
})();
