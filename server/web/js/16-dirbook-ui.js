// The saved-directory UI: the picker that wraps any working-directory input,
// and the Directories page. Reads Trio.dirbook (js/15-dirbook.js) at
// definition time, so it must load after it — that edge is why this is a
// separate numbered file rather than a second IIFE inside 15, which is what it
// was. Every other module in this directory is exactly one IIFE, and a
// dependency hidden INSIDE a file is one tests/test-web-bundle.py cannot see.
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
      // Bump the generation FIRST. abort() only helps a request still in
      // flight — one that has already resolved resumes into render() with a
      // seq that still matches, and hasFocus is still true (Escape does not
      // blur), so the dropdown the operator just dismissed comes back.
      ++requestSeq;
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
        const label = item.source === 'saved' ? item.path : item.name;
        const sub = item.source === 'saved' ? (item.browse ? 'container' : 'project') : (item.parent || '');
        return `<button type="button" class="dirbook-opt${i === index ? ' hi' : ''}" data-index="${i}" role="option" aria-selected="${i === index}">`
          + `<span class="dirbook-icon">${item.source === 'saved' ? '★' : '›'}</span>`
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
    function moveHighlight(delta) {
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
      const descend = item.source !== 'saved' || item.browse;
      // Root is already its own separator: path + '/' would make '//', which
      // is a different string from the '/' actually stored, so the field and
      // the book would disagree about the same directory.
      input.value = descend ? (path.endsWith('/') ? path : path + '/') : path;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      hasFocus = true;
      input.focus();
      if (descend) refresh();
      else close();
    }
    async function refresh() {
      // Ask with the RAW value, trailing slash and all. That slash is the
      // whole question: "~/Projects/" means list what is INSIDE it, while
      // "~/Projects" means find things NAMED that. normalize() strips it —
      // so normalizing here and then asking the server is exactly why picking
      // a container stopped listing anything. Normalize only where paths are
      // COMPARED, never where the question is asked.
      const raw = String(input.value ?? '').trim();
      const normalized = book.normalize(raw);
      syncStar();
      if (!focused()) { close(); return; }
      const seq = ++requestSeq;
      const saved = book.matchingFavorites(raw)
        .filter(fav => fav.path !== normalized);   // don't offer what is already there
      // A bare name like "roam" is not a path, so there is nothing for the
      // server to complete — but the saved list can still answer it, and that
      // is the whole point of saving one. Show those and skip the request.
      if (!raw || !/^[~/]/.test(raw)) {
        items = saved.slice(0, 8); index = items.length ? 0 : -1; render(); return;
      }
      // Show saved matches immediately; the network result folds in when it
      // arrives, so the list never blanks out mid-type.
      items = saved.slice(0, 4); index = items.length ? 0 : -1; render();
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      let dirs = [];
      try { dirs = await book.complete(raw, { signal: controller.signal }); }
      catch { return; }                            // aborted by a newer keystroke
      if (seq !== requestSeq) return;              // a newer request won
      // Dedupe the live results against the favorites actually SHOWN, not
      // against every favorite that matched. Using all of them meant a
      // favorite ranked fifth or later was stripped out of the live list
      // while never appearing in the saved block either — present on disk,
      // saved by the operator, and visible in neither half.
      const shown = saved.slice(0, 4);
      const savedPaths = new Set(shown.map(fav => fav.path));
      const fresh = dirs.filter(dir => !savedPaths.has(book.normalize(dir.path)));
      items = shown.concat(fresh.slice(0, 8));
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
    // "Step into what is in the field" — the gesture you want after landing on
    // a directory and deciding you meant something inside it. Typing / already
    // does this (it is the same question, and refresh() now asks it correctly);
    // ArrowRight at the end of the value is the same move without reaching for
    // punctuation. Enter is deliberately NOT bound to it: these fields sit in
    // forms whose Enter means Save or Create, and quietly stealing that to
    // walk a directory would be a worse surprise than an extra keystroke.
    function stepInto() {
      const value = String(input.value ?? '').trim();
      if (!value || !/^[~/]/.test(value) || value.endsWith('/')) return false;
      input.value = value + '/';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      hasFocus = true;
      refresh();
      return true;
    }
    const onKeyDown = event => {
      const atEnd = input.selectionStart === input.value.length
        && input.selectionEnd === input.value.length;
      if (event.key === 'ArrowRight' && atEnd && stepInto()) { event.preventDefault(); return; }
      if (pop.hidden) {
        if (event.key === 'ArrowDown') { event.preventDefault(); refresh(); }
        return;
      }
      if (event.key === 'ArrowDown') { event.preventDefault(); moveHighlight(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveHighlight(-1); }
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
        Trio.ui?.toast?.(book.lastWritePersisted()
          ? `Saved ${path}`
          : `Saved ${path} for this tab only — this browser refused to store it.`);
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

    // Full teardown, or none: leaving the wrapper and star in place meant a
    // re-attach nested a second .dirbook-field around the same input, with an
    // orphaned star from the first. No caller detaches today (both modals let
    // their nodes die), which is exactly why this has to be right before one
    // does.
    return function detach() {
      close();
      input.removeEventListener('input', onInput);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('keydown', onKeyDown);
      star.removeEventListener('click', onStar);
      Trio.events?.removeEventListener?.('dirbook:changed', onBookChanged);
      delete input.dataset.dirbook;
      wrap.parentNode?.insertBefore(input, wrap);
      wrap.remove();
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
      + '<kbd>Enter</kbd> to pick. To go deeper into whatever is in the field, type <code>/</code> '
      + 'or press <kbd>&rarr;</kbd>. Each saved directory is a <strong>project</strong> '
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
      if (!book.lastWritePersisted()) {
        Trio.ui?.toast?.('Saved for this tab only — this browser refused to store it.');
      }
      input.value = '';
      draw();
      refreshInfo();
    });
    draw();
    // Another tab (or the star on any working-directory field) can change the
    // book while this page is open.
    Trio.events?.addEventListener?.('dirbook:changed', draw);
    panel.append(head, form, hint, section);
    // No star here: this field has a Save button, and two controls for one job
    // is one too many.
    attachPathInput(input, { star: false });
    refreshInfo();
    return panel;
  }

  Object.assign(Trio.dirbook, { attachPathInput, renderPage });
})();
