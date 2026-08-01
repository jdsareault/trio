(() => {
  'use strict';
  const Trio = window.Trio;
  if (!Trio || !Trio.markdown) throw new Error('Conversation requires Trio core and markdown');
  const { state, events } = Trio;
  const M = Trio.markdown;
  const dom = () => document.getElementById('messages');

  state.messages = state.messages instanceof Map ? state.messages : new Map();
  state.members = state.members instanceof Map ? state.members : new Map();
  state.messageDomById = state.messageDomById instanceof Map ? state.messageDomById : new Map();
  state.answers = state.answers instanceof Map ? state.answers : new Map();
  state.lastSeenId = state.lastSeenId || 0;
  state.jumpUnread = state.jumpUnread || 0;

  function member(id) { return state.members.get(id) || {}; }
  function nameFor(id, fallback) { return member(id).name || fallback || id || 'unknown'; }
  function isOwn(msg) { return !!state.operator && msg.member_id === state.operator.id; }
  function time(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (_) { return ''; }
  }
  function nearBottom(el) { return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80; }

  function decorateSigils(root, msg) {
    const ids = new Set([...(msg.mentions || []), ...(msg.refs || []), ...(msg.bangs || [])]);
    if (!ids.size || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.parentElement.closest('code,pre,a,.sigil')) nodes.push(n);
    }
    for (const node of nodes) {
      const text = node.nodeValue || '';
      const re = /([@#!])([^\s.,;:!?()[\]{}]+)/g;
      let match, cursor = 0, changed = false;
      const frag = document.createDocumentFragment();
      while ((match = re.exec(text))) {
        const lookup = [...ids].find(id => nameFor(id, id) === match[2] || id === match[2]);
        if (!lookup) continue;
        changed = true;
        frag.append(document.createTextNode(text.slice(cursor, match.index)));
        const span = document.createElement('span');
        span.className = 'sigil sigil-' + ({'@':'mention','#':'ref','!':'bang'}[match[1]]);
        span.dataset.memberId = lookup;
        span.textContent = match[1] + nameFor(lookup, match[2]);
        frag.append(span);
        cursor = match.index + match[0].length;
      }
      if (changed) { frag.append(document.createTextNode(text.slice(cursor))); node.replaceWith(frag); }
    }
  }

  function paintBody(card, body, msg) {
    card.classList.toggle('retracted', !!msg.retracted_at);
    body.replaceChildren();
    if (msg.retracted_at) {
      body.className = 'message-body plain';
      body.textContent = '[deleted' + (msg.retraction_reason ? ' — ' + msg.retraction_reason : '') + ']';
      return;
    }
    if (M.isSystemContent(msg.content || '')) {
      body.className = 'message-body plain system';
      body.textContent = M.humanizeIdSigils(msg.content || '');
    } else {
      body.className = 'message-body';
      body.innerHTML = M.renderMarkdown(msg.content || '');
      decorateSigils(body, msg);
    }
    if (msg.edited_at) {
      const edited = document.createElement('span');
      edited.className = 'edited-mark'; edited.textContent = ' (edited)';
      edited.title = 'edited ' + time(msg.edited_at); body.append(edited);
    }
  }

  function askCard(msg) {
    const choices = msg.choices;
    if (!choices || !Array.isArray(choices.questions || choices.options)) return null;
    const wrap = document.createElement('section'); wrap.className = 'ask-card';
    const questions = choices.questions || [choices];
    for (const q of questions) {
      const title = document.createElement('p'); title.className = 'ask-question'; title.textContent = q.question || '';
      wrap.append(title);
      const options = document.createElement('div'); options.className = 'ask-options';
      for (const option of q.options || []) { const row = document.createElement('span'); row.className = 'ask-option'; row.textContent = option; options.append(row); }
      wrap.append(options);
    }
    return wrap;
  }

  function renderTargets(msg) {
    const targets = [['!', msg.bangs, 'bang'], ['@', msg.mentions, 'to'], ['#', msg.refs, 'about']]
      .filter(([, ids]) => ids && ids.length);
    if (!targets.length) return null;
    const bar = document.createElement('div'); bar.className = 'message-targets';
    for (const [sigil, ids, label] of targets) {
      const group = document.createElement('span'); group.className = 'target-group';
      group.append(document.createTextNode(label + ' '));
      ids.forEach(id => { const chip = document.createElement('span'); chip.className = 'target-chip'; chip.textContent = sigil + nameFor(id, id); group.append(chip); });
      bar.append(group);
    }
    return bar;
  }

  function cardFor(msg) {
    const card = document.createElement('article'); card.className = 'message' + (isOwn(msg) ? ' own' : '') + (msg.is_dm ? ' private' : '');
    card.dataset.messageId = msg.id;
    const head = document.createElement('header'); head.className = 'message-head';
    const author = document.createElement('strong'); author.textContent = nameFor(msg.member_id, msg.member_name);
    const stamp = document.createElement('time'); stamp.textContent = time(msg.created_at);
    head.append(author, stamp);
    if (msg.confidence) { const confidence = document.createElement('span'); confidence.className = 'confidence confidence-' + msg.confidence; confidence.textContent = msg.confidence; head.append(confidence); }
    if (msg.is_dm) { const badge = document.createElement('span'); badge.className = 'private-badge'; badge.textContent = 'private'; head.append(badge); }
    card.append(head);
    const target = renderTargets(msg); if (target) card.append(target);
    const body = document.createElement('div'); body.className = 'message-body'; paintBody(card, body, msg); card.append(body);
    const ask = askCard(msg); if (ask) card.append(ask);
    return card;
  }

  function ordered() { return [...state.messages.values()].sort((a, b) => Number(a.id) - Number(b.id)); }
  function render() {
    const list = dom(); if (!list) return;
    const stick = nearBottom(list); list.replaceChildren(); state.messageDomById.clear();
    const messages = ordered();
    if (!messages.length) { const empty = document.createElement('p'); empty.className = 'conversation-empty'; empty.textContent = 'No messages yet. Say hello to get things moving.'; list.append(empty); }
    for (const msg of messages) { const card = cardFor(msg); list.append(card); state.messageDomById.set(msg.id, card); }
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function upsert(msg) {
    if (!msg || msg.id == null) return;
    const wasNear = nearBottom(dom()); const previous = state.messages.get(msg.id) || {};
    state.messages.set(msg.id, Object.assign({}, previous, msg));
    const existing = state.messageDomById.get(msg.id);
    if (!existing) { render(); return; }
    const replacement = cardFor(state.messages.get(msg.id)); existing.replaceWith(replacement); state.messageDomById.set(msg.id, replacement);
    if (wasNear) dom().scrollTop = dom().scrollHeight;
  }

  function ingest(payload) {
    const messages = Array.isArray(payload) ? payload : (payload.messages || [payload.message || payload]);
    messages.filter(Boolean).forEach(upsert);
  }
  function init() {
    events.addEventListener('messages', event => ingest(event.detail));
    events.addEventListener('message', event => ingest(event.detail));
    events.addEventListener('message_update', event => ingest(event.detail));
    render();
  }

  Trio.conversation = { init, render, ingest, upsert, paintBody, cardFor };
})();
