// Per-agent tool activity panel.
//
// Opened by clicking an agent's avatar in the channel details drawer. Answers
// two questions the drawer's one-line "using Bash: git" chip cannot: WHAT has
// this agent been running, and HOW FAST.
//
// Lives in its own module rather than inside 20-workspace.js because the only
// thing the drawer needs to know about it is "open this member" — one
// delegated click. Everything else (fetching, paging, the live tick) is here.
//
// ── On "the tool call written out fully" ──────────────────────────────────
// It is not stored, so it cannot be shown. nth_activity_hook.py records a
// deliberately privacy-trimmed SUMMARY and never raw `tool_input`: Bash keeps
// the program name only (never args, flags, or leading env assignments, which
// is where live credentials sit), file tools keep a basename, Glob/Grep keep a
// capped pattern, and WebFetch/WebSearch keep nothing but the tool name. See
// that module's privacy contract for the reasoning.
//
// This panel therefore renders what was captured and SAYS SO in a footnote. A
// row reading `Bash · gh` must not be mistaken for the whole command line —
// silently presenting a summary as if it were the full call would make the
// panel actively misleading about the one thing it exists to show.
(() => {
  'use strict';
  const Trio = window.Trio;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const PAGE = 50;            // the server clamps `limit` here anyway
  const TICK_MS = 4000;       // live refresh cadence while the panel is open
  const MODAL_ID = 'trio-control-modal';

  // Panel-local state. Only ever one panel open (it's a <dialog>), so this is a
  // singleton rather than a per-instance object.
  let open = null;    // { memberId, name, events, nextBefore, exhausted, tick }

  // ── time ──────────────────────────────────────────────────────────────────
  // "3m ago" is the wrong unit here. The whole point of the timestamp column is
  // pace, and an agent's tool calls land seconds apart — a minute-granularity
  // relative time collapses a burst of twenty calls into twenty identical
  // "just now"s. So: absolute wall-clock to the second, plus the gap since the
  // previous call, which is the number that actually reads as speed.
  function parseAt(iso) {
    if (!iso) return NaN;
    // The hook writes UTC via datetime.now(timezone.utc).isoformat(), which is
    // offset-aware. Older rows may lack the offset; treat those as UTC too
    // rather than letting the browser read them as local and skew every delta.
    const raw = String(iso);
    const stamped = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw + 'Z';
    const t = new Date(stamped).getTime();
    return Number.isNaN(t) ? NaN : t;
  }
  function clockOf(iso) {
    const t = parseAt(iso);
    if (Number.isNaN(t)) return '';
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function dayOf(iso) {
    const t = parseAt(iso);
    if (Number.isNaN(t)) return '';
    const d = new Date(t), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return 'Today';
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // Gap since the previous call, as a duration. Sub-second gaps are real
  // (Claude Code dispatches tools in parallel, so a batch shares a timestamp)
  // and are worth showing as such rather than rounding to a misleading "0s".
  function gapLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return '+' + ms + 'ms';
    // One decimal under 10s, where tenths still read as pace; none above.
    // The trailing '.0' on a whole number is dropped -- it carries no
    // information and makes a column of gaps noisier to scan.
    if (ms < 60000) {
      const secs = (ms / 1000).toFixed(ms < 10000 ? 1 : 0).replace(/\.0$/, '');
      return '+' + secs + 's';
    }
    const m = Math.floor(ms / 60000);
    if (m < 60) return '+' + m + 'm' + (Math.round((ms % 60000) / 1000) || '') + (ms % 60000 >= 1000 ? 's' : '');
    const h = Math.floor(m / 60);
    return h < 24 ? '+' + h + 'h' + (m % 60 || '') + (m % 60 ? 'm' : '') : '+' + Math.floor(h / 24) + 'd';
  }

  // ── rendering ─────────────────────────────────────────────────────────────
  // `Bash · gh`, `Read · nth_web.py`, `WebFetch`. The target is omitted rather
  // than shown empty when the hook stored nothing for it.
  function callText(ev) {
    const name = ev.tool_name || 'tool';
    return ev.target ? `${name} · ${ev.target}` : name;
  }
  function rowHtml(ev, prevOlder) {
    // Events arrive newest-first, so the gap for row i is measured against
    // i+1 — the call that came BEFORE it.
    const gap = prevOlder ? gapLabel(parseAt(ev.created_at) - parseAt(prevOlder.created_at)) : '';
    const title = `${dayOf(ev.created_at)} ${clockOf(ev.created_at)}`;
    return `<div class="act-row"><span class="act-time" title="${esc(title)}">${esc(clockOf(ev.created_at) || '—')}</span>`
      + `<span class="act-call">${esc(callText(ev))}</span>`
      + `<span class="act-gap">${esc(gap)}</span></div>`;
  }
  function listHtml(events) {
    if (!events.length) {
      return '<div class="act-empty">No recorded tool calls.<br><small>The activity hook records these; an install without it, or an agent that has not run a tool since connecting, shows nothing here.</small></div>';
    }
    let out = '', lastDay = null;
    events.forEach((ev, i) => {
      const day = dayOf(ev.created_at);
      if (day && day !== lastDay) { out += `<div class="act-day">${esc(day)}</div>`; lastDay = day; }
      out += rowHtml(ev, events[i + 1]);
    });
    return out;
  }
  function bodyHtml(st) {
    const more = st.exhausted || !st.nextBefore ? ''
      : '<button type="button" class="btn ghost act-more" id="act-more">Load older</button>';
    return `<div class="act-panel">`
      + `<div class="act-meta"><span id="act-count">${esc(String(st.events.length))} call${st.events.length === 1 ? '' : 's'}</span>`
      + `<span class="act-live" id="act-live">live</span></div>`
      + `<div class="act-list" id="act-list">${listHtml(st.events)}</div>${more}`
      // Not a disclaimer for its own sake: without it a reader takes `Bash · gh`
      // for the whole command. Say what the row is.
      + `<p class="act-note">Arguments are not recorded. The hook stores a privacy-trimmed summary — a program name for Bash, a filename for file tools — never the full input.</p>`
      + `</div>`;
  }

  // ── data ──────────────────────────────────────────────────────────────────
  function fetchPage(memberId, before) {
    const qs = `/api/tools?kind=all&limit=${PAGE}&member=${encodeURIComponent(memberId)}`
      + (before ? `&before=${encodeURIComponent(before)}` : '');
    return Trio.api.get(qs).then(d => ({
      events: Array.isArray(d?.events) ? d.events : (Array.isArray(d?.subagents) ? d.subagents : []),
      nextBefore: d?.next_before || 0,
    }));
  }
  function repaint() {
    if (!open) return;
    const list = document.getElementById('act-list');
    if (list) list.innerHTML = listHtml(open.events);
    const count = document.getElementById('act-count');
    if (count) count.textContent = `${open.events.length} call${open.events.length === 1 ? '' : 's'}`;
    const more = document.getElementById('act-more');
    // The button is only ever removed, never re-added: paging goes one way, so
    // once the ring is exhausted there is nothing to restore it for.
    if (more && (open.exhausted || !open.nextBefore)) more.remove();
  }
  function loadOlder() {
    if (!open || open.loading || open.exhausted || !open.nextBefore) return;
    open.loading = true;
    const memberId = open.memberId, cursor = open.nextBefore;
    fetchPage(memberId, cursor)
      .then(({ events, nextBefore }) => {
        // Guard against the panel being closed or re-pointed mid-flight.
        if (!open || open.memberId !== memberId) return;
        if (!events.length) { open.exhausted = true; }
        else {
          const seen = new Set(open.events.map(e => e.id));
          open.events.push(...events.filter(e => !seen.has(e.id)));
          open.nextBefore = nextBefore;
          if (!nextBefore) open.exhausted = true;
        }
        repaint();
      })
      .catch(() => { if (open && open.memberId === memberId) { open.exhausted = true; repaint(); } })
      .finally(() => { if (open && open.memberId === memberId) open.loading = false; });
  }
  // Poll the newest page and splice in anything we have not seen. Cheap: the
  // ring is capped per fingerprint and this is one indexed query.
  function pollNew() {
    if (!open || open.loading) return;
    const memberId = open.memberId;
    fetchPage(memberId, 0)
      .then(({ events }) => {
        if (!open || open.memberId !== memberId || !events.length) return;
        const seen = new Set(open.events.map(e => e.id));
        const fresh = events.filter(e => !seen.has(e.id));
        if (!fresh.length) return;
        // Newest-first on both sides, so fresh rows go on the front.
        open.events = fresh.concat(open.events);
        repaint();
      })
      .catch(() => {});   // a transient failure is not worth tearing the panel down
  }

  // ── open / close ──────────────────────────────────────────────────────────
  function stopTick() {
    if (open?.tick) { clearInterval(open.tick); open.tick = null; }
  }
  function openFor(member) {
    const memberId = typeof member === 'object' ? member?.id : member;
    if (!memberId) return;
    const name = (typeof member === 'object' ? member?.name : '') || memberId;
    stopTick();
    open = { memberId, name, events: [], nextBefore: 0, exhausted: false, loading: false, tick: null };
    Trio.ui.modal(`${name} · tool activity`, bodyHtml(open), null, { submit: false, cancelLabel: 'Close' });
    const node = document.getElementById(MODAL_ID);
    // The dialog is reused across every modal in the app, so the panel must
    // release its interval when this particular one closes — otherwise it keeps
    // polling behind whatever dialog opens next.
    node?.addEventListener('close', () => { stopTick(); open = null; }, { once: true });
    node?.querySelector('#act-more')?.addEventListener('click', loadOlder);
    // Delegated: repaint() replaces the list, and #act-more is removed on
    // exhaustion, so a direct listener alone would not survive a reflow.
    node?.querySelector('.act-panel')?.addEventListener('click', e => {
      if (e.target.closest('#act-more')) loadOlder();
    });

    open.loading = true;
    fetchPage(memberId, 0)
      .then(({ events, nextBefore }) => {
        if (!open || open.memberId !== memberId) return;
        open.events = events;
        open.nextBefore = nextBefore;
        if (!nextBefore) open.exhausted = true;
        repaint();
      })
      .catch(() => {
        if (!open || open.memberId !== memberId) return;
        open.exhausted = true;
        const list = document.getElementById('act-list');
        // A fetch failure is not "this agent ran nothing". Say which happened.
        if (list) list.innerHTML = '<div class="act-empty">Tool activity is unavailable right now.</div>';
      })
      .finally(() => { if (open && open.memberId === memberId) open.loading = false; });

    open.tick = setInterval(pollNew, TICK_MS);
  }

  Trio.activity = { open: openFor, callText, gapLabel, clockOf, listHtml, parseAt };
})();
