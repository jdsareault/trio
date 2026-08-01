(() => {
  'use strict';
  const Trio = window.Trio;

  const FILE_PATH_RUN_RE = /[A-Za-z0-9_.~/-]+(?::\d+(?::\d+)?)?/g;
  const FILE_PATH_MAX_LEN = 4096;
  // Per-path validation cache (path token → exists bool). Shared across every
  // message so re-renders and repeated paths never re-hit the endpoint.
  const filePathCache = new Map();

  function detectFilePathCandidates(text) {
    const out = [];
    if (!text) return out;
    FILE_PATH_RUN_RE.lastIndex = 0;
    let m;
    while ((m = FILE_PATH_RUN_RE.exec(text)) !== null) {
      let tok = m[0];
      const start = m.index;
      if (tok.indexOf('/') === -1) continue;               // not path-like (no separator)
      // Require a real FILENAME SEGMENT, not just separators: a candidate must
      // carry at least one name character ([A-Za-z0-9_]). This rejects a BARE
      // '/' (and pure-punctuation runs like '//', './', '-/-') that a slash used
      // as prose punctuation produces — "reload / incognito", "high / low",
      // "#" / "!". Those would otherwise validate against on-disk roots ('/'
      // exists!) and wrongly pick up a folder link. Slash-joined WORDS ('and/or',
      // 'high/medium/low') still pass here but are gated by real existence, so
      // they only link if they genuinely resolve. (Server rejects roots too —
      // defense in depth.)
      if (!/[A-Za-z0-9_]/.test(tok)) continue;
      // Drop a single trailing sentence period ("…/c.py." → "…/c.py"); never a
      // ".." tail. Trailing trim only, so the start offset stays valid.
      tok = tok.replace(/([^.\/])\.$/, '$1');
      if (!tok || tok.length > FILE_PATH_MAX_LEN) continue;
      out.push({ start, end: start + tok.length, token: tok });
    }
    return out;
  }

  // Wrap candidate tokens the caller marks valid (isValid(token) === true) in a
  // .file-link. Skips code/pre/existing links, the @/#/! sigil spans, and
  // already-linkified paths, so we never double-wrap or touch literal code.
  // onClick (optional) is attached to each created link.
  function linkifyValidatedPaths(root, isValid, onClick) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(
        'code, pre, a, .inline-mention, .inline-ref, .inline-bang, .file-link')) continue;
      if (detectFilePathCandidates(node.nodeValue || '').some(c => isValid(c.token)))
        nodes.push(node);
    }
    for (const node of nodes) {
      const text = node.nodeValue || '';
      const cands = detectFilePathCandidates(text).filter(c => isValid(c.token));
      if (!cands.length) continue;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const c of cands) {
        if (c.start < cursor) continue;   // defensive: skip any overlap
        frag.appendChild(document.createTextNode(text.slice(cursor, c.start)));
        const link = document.createElement('a');
        link.className = 'file-link';
        link.textContent = c.token;
        link.dataset.path = c.token;
        link.setAttribute('role', 'button');
        link.setAttribute('tabindex', '0');
        link.title = 'Reveal in Finder';
        if (typeof onClick === 'function') {
          link.addEventListener('click', (e) => { e.preventDefault(); onClick(c.token, link); });
          link.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(c.token, link); }
          });
        }
        frag.appendChild(link);
        cursor = c.end;
      }
      frag.appendChild(document.createTextNode(text.slice(cursor)));
      node.replaceWith(frag);
    }
  }

  // Brief inline state on a file link after a reveal attempt (no navigation,
  // no modal). Success/failure both auto-revert; failures surface the reason
  // in the tooltip.
  function flashFileLink(link, ok, msg) {
    if (!link || !link.classList) return;
    const cls = ok ? 'file-link-ok' : 'file-link-err';
    link.classList.add(cls);
    if (msg) link.title = msg;
    setTimeout(() => {
      link.classList.remove(cls);
      link.title = 'Reveal in Finder';
    }, 1500);
  }

  async function revealPath(path, link) {
    if (typeof fetch !== 'function') return;
    try {
      const r = await fetch('/api/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data && data.ok) flashFileLink(link, true);
      else flashFileLink(link, false, (data && data.error) || ('reveal failed (' + r.status + ')'));
    } catch (e) {
      flashFileLink(link, false, 'reveal failed: ' + e.message);
    }
  }

  // Detect candidate paths in a rendered message body, validate the uncached
  // ones against the server (batched into one request per message), then
  // linkify only those confirmed to exist. Fire-and-forget from paintBody.
  // Relative candidates are resolved by the server against ITS cwd (best
  // effort); if they don't resolve there, they simply stay unlinked.
  async function decorateFilePaths(root) {
    if (!root || typeof fetch !== 'function') return;
    const tokens = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(
        'code, pre, a, .inline-mention, .inline-ref, .inline-bang, .file-link')) continue;
      for (const c of detectFilePathCandidates(node.nodeValue || '')) tokens.add(c.token);
    }
    if (!tokens.size) return;
    const need = [...tokens].filter(t => !filePathCache.has(t));
    // Validate in chunks (server caps at 200/req); cache each verdict so this
    // path is never re-validated on a later render.
    for (let i = 0; i < need.length; i += 200) {
      const chunk = need.slice(i, i + 200);
      try {
        const r = await fetch('/api/path/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: chunk }),
        });
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          const ex = (data && data.exists) || {};
          for (const t of chunk) filePathCache.set(t, ex[t] === true);
        }
      } catch (e) { /* leave uncached — just won't linkify this pass */ }
    }
    linkifyValidatedPaths(root, (t) => filePathCache.get(t) === true, revealPath);
  }

  Trio.fileLinks = { detectFilePathCandidates, linkifyValidatedPaths, decorateFilePaths, revealPath };
})();
