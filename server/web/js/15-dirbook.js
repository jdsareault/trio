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

  // A path is stored EXACTLY as typed, `~` and all. Expanding it here would
  // bake this browser's idea of $HOME into a value the hub is the only one
  // qualified to resolve — and the dashboard is routinely opened from a phone
  // over the tailnet, where the local $HOME is meaningless.
  function normalize(raw) {
    const path = String(raw ?? '').trim();
    if (!path || path.length > MAX_LEN) return '';
    // Collapse runs of slashes but keep a single meaningful trailing one: a
    // trailing slash is how a CONTAINER ("~/Development/") is distinguished
    // from a project ("~/Development/trio") in the picker.
    return path.replace(/\/{2,}/g, '/');
  }
  function isContainer(path) { return /\/$/.test(path); }
  function isAbsoluteish(path) { return /^[~/]/.test(path); }

  function readFromStorage() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      const list = Array.isArray(raw.favorites) ? raw.favorites : [];
      const seen = new Set();
      const favorites = [];
      for (const entry of list) {
        const path = normalize(entry);
        if (!path || !isAbsoluteish(path) || seen.has(path)) continue;
        seen.add(path);
        favorites.push(path);
        if (favorites.length >= MAX_FAVORITES) break;
      }
      return { favorites };
    } catch { return { favorites: [] }; }
  }
  let cache = null;
  function state() { return (cache ||= readFromStorage()); }
  function write(favorites) {
    cache = { favorites: favorites.slice(0, MAX_FAVORITES) };
    try { localStorage.setItem(KEY, JSON.stringify({ v: 1, favorites: cache.favorites })); } catch { /* private mode / quota */ }
    Trio.events?.dispatchEvent?.(new CustomEvent('dirbook:changed', { detail: { favorites: cache.favorites } }));
    return cache.favorites;
  }

  function list() { return state().favorites.slice(); }
  function has(path) { return state().favorites.includes(normalize(path)); }
  function add(rawPath) {
    const path = normalize(rawPath);
    if (!path || !isAbsoluteish(path)) return { ok: false, error: 'Give an absolute path or one starting with ~.' };
    const favorites = state().favorites.slice();
    if (favorites.includes(path)) return { ok: false, error: 'Already saved.' };
    if (favorites.length >= MAX_FAVORITES) return { ok: false, error: `At most ${MAX_FAVORITES} saved directories.` };
    favorites.push(path);
    write(favorites);
    return { ok: true, path };
  }
  function remove(rawPath) {
    const path = normalize(rawPath);
    const favorites = state().favorites.filter(p => p !== path);
    if (favorites.length === state().favorites.length) return false;
    write(favorites);
    return true;
  }
  function move(rawPath, delta) {
    const path = normalize(rawPath);
    const favorites = state().favorites.slice();
    const from = favorites.indexOf(path);
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= favorites.length) return false;
    favorites.splice(to, 0, favorites.splice(from, 1)[0]);
    write(favorites);
    return true;
  }

  // ── server-side child-directory completion ───────────────────────────────
  // Only the hub can answer "what is inside ~/Development/" — the browser has
  // no filesystem. /api/path/complete is gated to the same trusted tiers as
  // /api/path/validate, so a guest simply gets no suggestions (a 403 here is
  // an expected outcome, not an error worth toasting).
  let completionsDenied = false;
  async function complete(prefix, options = {}) {
    if (completionsDenied) return [];
    const value = normalize(prefix);
    if (!value || !isAbsoluteish(value)) return [];
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

  // Favorites that match what has been typed so far, offered above the live
  // filesystem results. A container favorite matches its own descendants too,
  // so typing "~/Development/tr" still surfaces the saved "~/Development/".
  function matchingFavorites(query) {
    const q = normalize(query).toLowerCase();
    return state().favorites
      .filter(path => !q || path.toLowerCase().startsWith(q) || (isContainer(path) && q.startsWith(path.toLowerCase())))
      .map(path => ({ path, name: path, kind: 'saved' }));
  }
  Trio.dirbook = { KEY, MAX_FAVORITES, list, has, add, remove, move, complete, normalize, isContainer, matchingFavorites };
})();

(() => {
  'use strict';
  const Trio = window.Trio;
  const book = Trio.dirbook;
  const { list, add, remove, move, isContainer } = book;
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

    const star = document.createElement('button');
    star.type = 'button';                 // never submit the surrounding form
    star.className = 'dirbook-star';
    wrap.append(star);

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
      const path = book.normalize(input.value);
      const saved = !!path && book.has(path);
      star.innerHTML = saved ? STAR_FILLED : STAR_OUTLINE;
      star.classList.toggle('on', saved);
      star.disabled = !path;
      star.title = !path ? 'Type a path to save it'
        : saved ? 'Remove from saved directories' : 'Save this directory';
      star.setAttribute('aria-label', star.title);
    }
    function focused() { return document.activeElement === input; }
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
        const sub = item.kind === 'saved' ? 'saved' : (item.parent || '');
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
      // Always land on a trailing slash and re-query. That is shell-completion
      // behaviour, and it is what makes a saved CONTAINER ("~/Development/")
      // useful: pick it, and its children are immediately on offer. The
      // trailing slash is inert on the server (Path.resolve strips it).
      const path = book.normalize(item.path);
      input.value = path.replace(/\/*$/, '/');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      refresh();
    }
    async function refresh() {
      const typed = book.normalize(input.value);
      syncStar();
      if (!focused()) { close(); return; }
      const seq = ++requestSeq;
      const saved = book.matchingFavorites(typed)
        .filter(fav => fav.path !== typed);        // don't offer what is already there
      if (!typed) { items = saved.slice(0, 8); index = items.length ? 0 : -1; render(); return; }
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
      const savedPaths = new Set(saved.map(fav => fav.path.replace(/\/*$/, '/')));
      const fresh = dirs.filter(dir => !savedPaths.has(String(dir.path || '').replace(/\/*$/, '/')));
      items = saved.slice(0, 4).concat(fresh.slice(0, 8));
      index = items.length ? 0 : -1;
      render();
    }
    function scheduleRefresh() { clearTimeout(debounce); debounce = setTimeout(refresh, COMPLETE_DEBOUNCE_MS); }

    const onInput = () => { syncStar(); scheduleRefresh(); };
    const onFocus = () => { refresh(); };
    // Clicking anywhere else dismisses it. close() also kills the pending
    // debounce and the in-flight completion, so nothing arrives later and
    // puts the list back on screen.
    const onBlur = () => { close(); };
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
    if (options.openOnAttach) refresh();

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
  // A page rather than a row in Settings: this is a working list the operator
  // curates and browses, not a switch they flip once. Having its own surface
  // buys room for the things a settings row cannot show — what each entry is
  // for, and whether it still exists on disk.
  function renderPage(panel) {
    panel.replaceChildren();
    const hero = document.createElement('div');
    hero.className = 'view-hero';
    hero.innerHTML = '<h2>Directories</h2><p>The working directories you spawn agents into. '
      + 'Saved here, they are offered wherever a working directory is asked for.</p>';

    const addGroup = document.createElement('section');
    addGroup.className = 'pref-group dirbook-group';
    addGroup.innerHTML = '<h3>Add a directory</h3>'
      + '<p class="pref-note">Type a path to browse it — subdirectories appear as you go, '
      + '<kbd>&uarr;</kbd><kbd>&darr;</kbd> to move, <kbd>Enter</kbd> to step in. '
      + 'End a path with <code>/</code> to save a <strong>container</strong>: picking it later '
      + 'offers everything inside, so <code>~/Development/</code> covers every project at once.</p>';
    const form = document.createElement('form');
    form.className = 'dirbook-add';
    form.innerHTML = '<input name="path" placeholder="~/Development/ or ~/Development/trio" aria-label="Directory to save">'
      + '<button type="submit" class="btn">Save</button>';
    const input = form.querySelector('input');
    addGroup.append(form);

    const listGroup = document.createElement('section');
    listGroup.className = 'pref-group dirbook-group';
    listGroup.innerHTML = '<h3>Saved</h3>';
    const listEl = document.createElement('ul');
    listEl.className = 'dirbook-list';
    listGroup.append(listEl);

    // Paths rot: a project gets renamed or moved and the saved entry silently
    // stops working, which you would otherwise only discover when an agent
    // fails to start. /api/path/validate already answers this, so the page
    // says so up front. A guest gets a 403 and simply no badges.
    let missing = new Set();
    async function checkExistence() {
      const paths = list();
      if (!paths.length) return;
      try {
        const data = await Trio.api.post('/api/path/validate', { paths }, false);
        missing = new Set(paths.filter(path => data?.exists?.[path] === false));
      } catch { missing = new Set(); }
      draw();
    }
    function draw() {
      const favorites = list();
      if (!favorites.length) {
        listEl.innerHTML = '<li class="dirbook-empty">Nothing saved yet. Add one above, '
          + 'or use the &#9733; beside any working-directory field.</li>';
        return;
      }
      listEl.innerHTML = favorites.map((path, i) => {
        const container = isContainer(path);
        const gone = missing.has(path);
        return `<li class="dirbook-row${gone ? ' gone' : ''}" data-path="${esc(path)}">`
          + `<span class="dirbook-icon">${container ? '\u{1F4C2}' : '\u{1F4C1}'}</span>`
          + `<span class="dirbook-name">${esc(path)}</span>`
          + `<span class="dirbook-tag">${container ? 'container' : 'project'}</span>`
          + (gone ? '<span class="dirbook-tag warn" title="No directory at this path right now">missing</span>' : '')
          + `<span class="dirbook-actions">`
          + `<button type="button" class="dirbook-act" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(path)} up">&uarr;</button>`
          + `<button type="button" class="dirbook-act" data-act="down" ${i === favorites.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(path)} down">&darr;</button>`
          + `<button type="button" class="dirbook-act danger" data-act="remove" aria-label="Remove ${esc(path)}">&#10005;</button>`
          + `</span></li>`;
      }).join('');
    }
    listEl.addEventListener('click', event => {
      const button = event.target.closest('.dirbook-act');
      if (!button) return;
      const path = button.closest('.dirbook-row')?.dataset.path;
      if (!path) return;
      if (button.dataset.act === 'remove') remove(path);
      else move(path, button.dataset.act === 'up' ? -1 : 1);
      draw();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const result = add(input.value);
      if (!result.ok) { Trio.ui?.toast?.(result.error); return; }
      input.value = '';
      draw();
      checkExistence();
    });
    draw();
    panel.append(hero, addGroup, listGroup);
    attachPathInput(input);
    checkExistence();
    return panel;
  }

  Object.assign(Trio.dirbook, { attachPathInput, renderPage });
})();
