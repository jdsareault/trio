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
        // Older shapes: v1 stored bare strings, v2 a `browse` boolean.
        //
        // v1's kind was a trailing slash the picker appended, so it is not
        // evidence of intent. v2's `browse` is genuinely ambiguous: it could
        // be an operator clicking the Browse-inside toggle, or the v1 slash
        // carried forward by that release's own migration — the two are not
        // distinguishable after the fact. Rather than pretend either way, both
        // arrive as 'auto' and are re-judged on their merits. That is the
        // failure that costs least: a wrong 'container' buries the path the
        // operator asked for, while a wrong 'project' costs one click. It is
        // also what repairs the entries the v1 scheme mislabelled.
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
  // Returns false when the change did not reach disk (private mode, quota).
  // Callers surface that: silently keeping it in memory means the star fills
  // in, the toast says Saved, the page lists it — and it is gone on reload
  // with nothing having said so.
  let persisted = true;
  function write(favorites) {
    cache = { favorites: favorites.slice(0, MAX_FAVORITES) };
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: 3, favorites: cache.favorites }));
      persisted = true;
    } catch { persisted = false; }
    Trio.events?.dispatchEvent?.(new CustomEvent('dirbook:changed', { detail: { favorites: cache.favorites } }));
    return persisted;
  }
  function lastWritePersisted() { return persisted; }
  // Another tab writing the book makes this tab's memoized snapshot stale, and
  // the next write here would replace their whole list with ours.
  window.addEventListener?.('storage', event => {
    if (event.key !== KEY) return;
    cache = null;
    Trio.events?.dispatchEvent?.(new CustomEvent('dirbook:changed', { detail: { favorites: list() } }));
  });

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
      // Absence is "not asked about", not "no longer classified". The server
      // caps a batch (INSPECT_CAP) independently of how many entries may be
      // saved (MAX_FAVORITES); those two live in different files in different
      // languages, so treating a missing answer as a cleared guess makes the
      // picker quietly stop descending the moment the caps cross.
      if (!byPath || !Object.prototype.hasOwnProperty.call(byPath, entry.path)) return entry;
      const guess = byPath[entry.path];
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
    if (to === from || to < 0 || to >= favorites.length) return false;
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
    // An empty query means "show me everything". A query normalize() REJECTED
    // (over MAX_LEN) also arrives empty, and must not be read the same way —
    // pasting five thousand characters used to list the entire saved book.
    if (!q) return typed ? [] : all.map(entry => ({ path: entry.path, name: entry.path, source: 'saved', browse: kindOf(entry) === 'container' }));
    const scored = [];
    for (const entry of all) {
      const lower = entry.path.toLowerCase();
      let rank = -1;
      if (lower.startsWith(q)) rank = 0;
      else if (typed.startsWith(lower + '/')) rank = 1;
      else if (lower.includes(q)) rank = 2;
      if (rank >= 0) scored.push({ path: entry.path, name: entry.path, source: 'saved', browse: kindOf(entry) === 'container', rank });
    }
    return scored.sort((a, b) => a.rank - b.rank)
      .map(m => ({ path: m.path, name: m.name, source: m.source, browse: m.browse }));
  }
  Trio.dirbook = { KEY, MAX_FAVORITES, MODES, list, paths, find, has, add, remove, setMode, applyGuesses, move, kindOf,
                   complete, inspect, normalize, matchingFavorites, lastWritePersisted };
})();
