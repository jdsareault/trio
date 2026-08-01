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
  function operator() { return state.operator || state.meta?.operator || {}; }
  function isOwn(msg) { return msg.member_id === operator().id; }
  function isPrivate(msg) { return !!msg.is_dm || Array.isArray(msg.recipients) && msg.recipients.length > 0; }
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
        const kind = ({'@':'mention','#':'ref','!':'bang'}[match[1]]);
        span.className = 'sigil sigil-' + kind + ' inline-' + kind;
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

  function answerState(msg, questions) {
    let answers = state.answers.get(msg.id);
    if (!answers || answers.length !== questions.length) {
      answers = questions.map(() => ({ picked: new Set(), custom: '' }));
      state.answers.set(msg.id, answers);
    }
    return answers;
  }
  function answerPayload(msg, questions) {
    const raw = answerState(msg, questions);
    const answers = raw.map(answer => ({
      picked: [...answer.picked], custom: answer.custom.trim() ? [answer.custom.trim()] : [],
    }));
    if (answers.some(answer => !answer.picked.length && !answer.custom.length)) throw new Error('Answer every question before sending');
    const multi = questions.length > 1;
    let content = '';
    if (typeof composeAnswer === 'function') {
      content = composeAnswer(questions, answers, multi);
    } else {
      content = multi ? ('Answered ' + questions.length + ' questions') : 'Answered question #' + msg.id;
    }
    return { content, reply_to: msg.id, selection: { answers } };
  }
  async function submitAnswer(msg, questions, button) {
    try {
      button.disabled = true;
      const result = await Trio.api.post(apiUrl('/api/send'), answerPayload(msg, questions));
      if (result?.message) upsert(result.message);
      button.textContent = 'Answer sent';
    } catch (error) {
      button.disabled = false;
      window.alert(error.message || 'Could not send answer');
    }
  }
  function askCard(msg) {
    const choices = msg.choices;
    if (!choices || !Array.isArray(choices.questions || choices.options)) return null;
    const wrap = document.createElement('section'); wrap.className = 'ask-card';
    const questions = choices.questions || [choices];
    const alreadyAnswered = [...state.messages.values()].some(candidate => candidate.reply_to === msg.id && candidate.selection);
    const canAnswer = choices.target === operator().id && !alreadyAnswered && !msg.selection;
    const answers = answerState(msg, questions);
    questions.forEach((q, questionIndex) => {
      const title = document.createElement('p'); title.className = 'ask-question'; title.textContent = q.question || '';
      wrap.append(title);
      const options = document.createElement('div'); options.className = 'ask-options';
      (q.options || []).forEach((option, optionIndex) => {
        const row = document.createElement(canAnswer ? 'button' : 'span'); row.className = 'ask-option'; row.textContent = option;
        if (canAnswer) {
          row.type = 'button'; row.classList.toggle('selected', answers[questionIndex].picked.has(optionIndex));
          row.addEventListener('click', () => {
            const picked = answers[questionIndex].picked;
            if (q.mode === 'one') { picked.clear(); picked.add(optionIndex); } else if (picked.has(optionIndex)) picked.delete(optionIndex); else picked.add(optionIndex);
            [...options.children].forEach((child, index) => child.classList.toggle('selected', picked.has(index)));
          });
        }
        options.append(row);
      });
      wrap.append(options);
      if (canAnswer && q.custom !== false) {
        const custom = document.createElement('input'); custom.className = 'ask-custom'; custom.placeholder = 'Other answer…'; custom.value = answers[questionIndex].custom;
        custom.addEventListener('input', () => { answers[questionIndex].custom = custom.value; }); wrap.append(custom);
      }
    });
    if (canAnswer) { const send = document.createElement('button'); send.type = 'button'; send.className = 'ask-send'; send.textContent = 'Send answer'; send.addEventListener('click', () => submitAnswer(msg, questions, send)); wrap.append(send); }
    else if (choices.target) { const note = document.createElement('small'); note.className = 'ask-note'; note.textContent = 'Awaiting @' + nameFor(choices.target, choices.target); wrap.append(note); }
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

  function apiUrl(path) {
    if (typeof Trio.api.url === 'function') return Trio.api.url(path);
    return state.channel ? path + '?channel=' + encodeURIComponent(state.channel) : path;
  }
  async function retract(msg) {
    const reason = window.prompt('Reason for deleting this message (optional):', '') || '';
    const response = await fetch(apiUrl('/api/delete'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: msg.id, reason }) });
    if (!response.ok) throw new Error('delete failed (' + response.status + ')');
  }
  async function edit(msg, body) {
    const content = window.prompt('Edit message', msg.content || '');
    if (content == null || content === msg.content) return;
    const response = await fetch(apiUrl('/api/edit'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: msg.id, content }) });
    if (!response.ok) throw new Error('edit failed (' + response.status + ')');
    body.textContent = content;
  }

  function cardFor(msg) {
    const privateMessage = isPrivate(msg);
    const card = document.createElement('article'); card.className = 'message' + (isOwn(msg) ? ' own' : '') + (privateMessage ? ' private' : '');
    card.dataset.messageId = msg.id;
    const head = document.createElement('header'); head.className = 'message-head';
    const author = document.createElement('strong'); author.textContent = nameFor(msg.member_id, msg.member_name);
    const stamp = document.createElement('time'); stamp.textContent = time(msg.created_at);
    head.append(author, stamp);
    if (msg.confidence) { const confidence = document.createElement('span'); confidence.className = 'confidence confidence-' + msg.confidence; confidence.textContent = msg.confidence; head.append(confidence); }
    if (privateMessage) { const badge = document.createElement('span'); badge.className = 'private-badge'; badge.textContent = 'private'; head.append(badge); }
    card.append(head);
    const target = renderTargets(msg); if (target) card.append(target);
    const body = document.createElement('div'); body.className = 'message-body'; paintBody(card, body, msg); card.append(body);
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      const attachments = document.createElement('div'); attachments.className = 'message-attachments';
      msg.attachments.forEach(attachment => {
        if (!attachment || !attachment.id) return;
        const link = document.createElement('a'); link.href = apiUrl('/api/attachment/' + attachment.id); link.target = '_blank'; link.rel = 'noopener'; link.className = 'message-attachment';
        if (/^image\//.test(attachment.mime || '')) { const image = document.createElement('img'); image.src = link.href; image.alt = attachment.filename || 'Attached image'; image.loading = 'lazy'; link.append(image); }
        else link.textContent = attachment.filename || ('Attachment #' + attachment.id);
        attachments.append(link);
      });
      if (attachments.children.length) card.append(attachments);
    }
    const ask = askCard(msg); if (ask) card.append(ask);
    if (isOwn(msg) && !msg.retracted_at) {
      const controls = document.createElement('div'); controls.className = 'message-controls';
      for (const [label, fn] of [['edit', () => edit(msg, body)], ['delete', () => retract(msg)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.addEventListener('click', () => fn().catch(error => window.alert(error.message))); controls.append(button);
      }
      card.append(controls);
    }
    return card;
  }

  function ordered() { return [...state.messages.values()].sort((a, b) => Number(a.id) - Number(b.id)); }
  function render() {
    const list = dom(); if (!list) return;
    const stick = nearBottom(list); list.replaceChildren(); state.messageDomById.clear();
    const messages = ordered();
    if (!messages.length) {
      const empty = document.createElement('div'); empty.className = 'conversation-empty';
      const p = document.createElement('p');
      if (state.dmLoading) { p.textContent = 'Loading private conversation…'; }
      else if (state.dmError) { p.textContent = 'Could not load conversation: ' + state.dmError; }
      else if (state.dmKey) { p.textContent = 'No messages yet. This is the start of your private conversation.'; }
      else { p.textContent = 'No messages yet. Say hello to get things moving.'; }
      empty.append(p);
      if (state.dmError && state.dmThread) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Try again';
        retry.addEventListener('click', () => Trio.workspace?.openDm?.(state.dmThread));
        empty.append(retry);
      }
      list.append(empty);
    }
    let unread = messages.findIndex(msg => Number(msg.id) > Number(state.lastSeenId));
    if (state.lastSeenId === 0) unread = -1;
    messages.forEach((msg, index) => {
      if (index === unread) { const divider = document.createElement('div'); divider.className = 'unread-divider'; divider.textContent = 'New since your last visit'; list.append(divider); }
      const card = cardFor(msg); list.append(card); state.messageDomById.set(msg.id, card);
    });
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function upsert(msg) {
    if (!msg || msg.id == null) return;
    if (state.dmKey) {
      const op = state.operator?.id;
      const recips = new Set([...(msg.recipients || []), msg.member_id].filter(Boolean));
      if (!op || !recips.has(op)) return;
      const others = [...recips].filter(id => id !== op);
      const expected = state.dmMemberIds || [];
      if (expected.length && (others.length !== expected.length || others.some(id => !expected.includes(id)))) return;
    }
    const wasNear = nearBottom(dom()); const previous = state.messages.get(msg.id) || {};
    state.messages.set(msg.id, Object.assign({}, previous, msg));
    const existing = state.messageDomById.get(msg.id);
    const list = dom();
    if (!existing) {
      const card = cardFor(state.messages.get(msg.id));
      if (list) { list.append(card); state.messageDomById.set(msg.id, card); }
      else { render(); }
      if (wasNear && list) list.scrollTop = list.scrollHeight;
      pruneMessages();
      return;
    }
    const replacement = cardFor(state.messages.get(msg.id)); existing.replaceWith(replacement); state.messageDomById.set(msg.id, replacement);
    if (wasNear) list.scrollTop = list.scrollHeight;
  }

  function pruneMessages(limit = 500) {
    const entries = [...state.messages.entries()];
    if (entries.length <= limit) return;
    entries.sort((a, b) => b[0] - a[0]).slice(limit).forEach(([id]) => {
      const node = state.messageDomById.get(id);
      if (node) { node.remove(); state.messageDomById.delete(id); }
      state.messages.delete(id);
    });
  }
  function ingest(payload) {
    const messages = Array.isArray(payload) ? payload : (payload.messages || [payload.message || payload]);
    messages.filter(Boolean).forEach(upsert);
  }
  const listeners = {};
  function onMessage(event) { ingest(event.detail); }
  function onRoster(event) { if (Array.isArray(event.detail?.members)) state.members = new Map(event.detail.members.map(m => [m.id, m])); render(); }
  function onBoot(event) { state.operator = event.detail?.operator || state.operator; }
  function init() {
    state.operator = state.operator || state.meta?.operator;
    events.addEventListener('boot', onBoot); listeners.boot = onBoot;
    events.addEventListener('message', onMessage); listeners.message = onMessage;
    events.addEventListener('message_update', onMessage); listeners.message_update = onMessage;
    events.addEventListener('roster', onRoster); listeners.roster = onRoster;
    render();
    const list = dom(); const jump = document.getElementById('jump-latest');
    if (list && jump) {
      const onScroll = () => jump.classList.toggle('hidden', nearBottom(list));
      const onClick = () => { list.scrollTop = list.scrollHeight; };
      list.addEventListener('scroll', onScroll); listeners.listScroll = [list, onScroll];
      jump.addEventListener('click', onClick); listeners.jumpClick = [jump, onClick];
    }
  }
  function unmount() {
    for (const [type, fn] of Object.entries(listeners)) {
      if (Array.isArray(fn) && fn[0]?.removeEventListener) { fn[0].removeEventListener(type === 'listScroll' ? 'scroll' : 'click', fn[1]); }
      else { events?.removeEventListener(type, fn); }
    }
    Object.keys(listeners).forEach(k => delete listeners[k]);
  }
  function mount() { init(); }

  Trio.conversation = { init, mount, unmount, render, ingest, upsert, paintBody, cardFor, answerPayload, isPrivate };
})();
