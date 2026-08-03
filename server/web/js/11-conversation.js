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
  state.scrollPositions = state.scrollPositions || {};
  state.lastSeenId = state.lastSeenId || 0;
  state.jumpUnread = state.jumpUnread || 0;
  state.activeMessageActions = state.activeMessageActions || null;

  function member(id) { return state.members.get(id) || {}; }
  function nameFor(id, fallback) { return member(id).name || fallback || id || 'unknown'; }
  // Shared with 20-workspace.js via Trio.avatarTone (00-core.js) — a bare
  // per-label hash used to duplicate this logic in both files with no
  // collision avoidance, so two members could land on the identical tone.
  const avatarTone = Trio.avatarTone;
  function avatarUrlFor(id) {
    const fromMember = member(id).avatar_url;
    if (fromMember) return fromMember;
    const agents = Trio.store?.get('agents.list') || state.agents || [];
    return agents.find(agent => agent.id === id)?.avatar_url || '';
  }
  function operator() { return state.operator || state.meta?.operator || {}; }
  function isOwn(msg) { return msg.member_id === operator().id; }
  function isPrivate(msg) { return !!msg.is_dm || Array.isArray(msg.recipients) && msg.recipients.length > 0; }
  function viewModel(msg) {
    const op = operator().id;
    const memberObj = member(msg.member_id);
    return {
      id: msg.id,
      member_id: msg.member_id,
      author: nameFor(msg.member_id, msg.member_name),
      isOwn: msg.member_id === op,
      role: msg.member_id === op ? '' : (memberObj.kind || 'agent'),
      isPrivate: isPrivate(msg),
      isSystem: M.isSystemContent(msg.content || ''),
      channel: msg.channel || state.channel || '',
      isTask: !!msg.task_id,
      isQuestion: !!msg.choices,
      isEdited: !!msg.edited_at,
      isRetracted: !!msg.retracted_at,
      retractionReason: msg.retraction_reason || '',
      content: msg.retracted_at ? '' : (msg.content || ''),
      createdAt: msg.created_at,
      date: date(msg.created_at),
      timestamp: time(msg.created_at),
      editedAt: msg.edited_at,
      editedTime: msg.edited_at ? time(msg.edited_at) : '',
      confidence: msg.confidence,
      recipients: msg.recipients || [],
      mentions: msg.mentions || [],
      refs: msg.refs || [],
      bangs: msg.bangs || [],
      attachments: msg.attachments || [],
      choices: msg.choices,
      selection: msg.selection,
      replyTo: msg.reply_to,
      taskId: msg.task_id,
      avatarUrl: avatarUrlFor(msg.member_id),
    };
  }
  function time(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (_) { return ''; }
  }
  function date(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); }
    catch (_) { return ''; }
  }
  function nearBottom(el) { return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80; }
  function convId() { return state.dmKey ? 'dm:' + state.dmKey : (state.channel || 'home'); }
  function markRead() { const list = ordered(); const last = list[list.length - 1]; if (last && Number(last.id) > Number(state.lastSeenId)) state.lastSeenId = last.id; flushRead(); }
  let flushRefreshTimer = null;
  function flushRead() {
    if (state.readOnly) return;
    const op = state.operator?.id;
    if (!op) return;
    state.readFlushByConv = state.readFlushByConv || {};
    const key = convId();
    const lastFlushed = Number(state.readFlushByConv[key]) || 0;
    const ids = [];
    for (const msg of ordered()) {
      if (Number(msg.id) <= lastFlushed) continue;
      if (msg.member_id !== op) ids.push(msg.id);
    }
    if (!ids.length) return;
    state.readFlushByConv[key] = Math.max(...ids);
    Trio.api.post('/api/messages/mark-read', { ids }).then(() => {
      if (Trio.workspace?.refresh) {
        clearTimeout(flushRefreshTimer);
        flushRefreshTimer = setTimeout(() => Trio.workspace.refresh(), 1500);
      }
    }).catch(err => console.warn('flush read failed', err));
  }

  function decorateSigils(root, vm) {
    const ids = new Set([...(vm.mentions || []), ...(vm.refs || []), ...(vm.bangs || [])]);
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

  function paintBody(card, body, msgOrVm) {
    const vm = (msgOrVm && typeof msgOrVm.isRetracted === 'boolean') ? msgOrVm : viewModel(msgOrVm);
    card.classList.toggle('retracted', vm.isRetracted);
    body.replaceChildren();
    if (vm.isRetracted) {
      body.className = 'message-body plain';
      body.textContent = '[deleted' + (vm.retractionReason ? ' — ' + vm.retractionReason : '') + ']';
      return;
    }
    if (vm.isSystem) {
      body.className = 'message-body plain system';
      body.textContent = M.systemMessageText(vm.content, vm.channel);
    } else {
      body.className = 'message-body bubble';
      body.innerHTML = M.renderMarkdown(vm.content);
      decorateSigils(body, vm);
      Trio.fileLinks?.decorateFilePaths?.(body);
    }
    if (vm.isEdited) {
      const edited = document.createElement('span');
      edited.className = 'edited-mark'; edited.textContent = ' (edited)';
      edited.title = 'edited ' + vm.editedTime; body.append(edited);
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
      Trio.ui.toast(error.message || 'Could not send answer');
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
      const fieldset = document.createElement('fieldset'); fieldset.className = 'ask-question-set'; fieldset.disabled = !canAnswer;
      const legend = document.createElement('legend'); legend.className = 'ask-question'; legend.textContent = q.question || '';
      fieldset.append(legend);
      const type = q.mode === 'one' ? 'radio' : 'checkbox';
      const name = 'ask-' + msg.id + '-' + questionIndex;
      const picked = answers[questionIndex].picked;
      (q.options || []).forEach((option, optionIndex) => {
        const id = name + '-' + optionIndex;
        const row = document.createElement('label'); row.className = 'ask-option' + (picked.has(optionIndex) ? ' selected' : ''); row.htmlFor = id;
        const input = document.createElement('input'); input.type = type; input.name = name; input.id = id; input.value = optionIndex;
        input.checked = picked.has(optionIndex);
        input.addEventListener('change', () => {
          if (q.mode === 'one') { picked.clear(); picked.add(optionIndex); }
          else if (input.checked) { picked.add(optionIndex); } else { picked.delete(optionIndex); }
          fieldset.querySelectorAll('.ask-option').forEach((label, idx) => label.classList.toggle('selected', picked.has(idx)));
        });
        const span = document.createElement('span'); span.textContent = option;
        row.append(input, span); fieldset.append(row);
      });
      if (q.custom !== false) {
        const custom = document.createElement('input'); custom.className = 'ask-custom'; custom.placeholder = 'Other answer…'; custom.disabled = !canAnswer; custom.value = answers[questionIndex].custom;
        custom.addEventListener('input', () => { answers[questionIndex].custom = custom.value; }); fieldset.append(custom);
      }
      wrap.append(fieldset);
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
  function retract(msg) {
    const html = '<label class="field">Reason for deleting this message (optional) <textarea name="reason" rows="2"></textarea></label>';
    Trio.ui.modal('Delete message', html, async node => {
      const reason = node.querySelector('[name="reason"]').value || '';
      try {
        const response = await fetch(apiUrl('/api/delete'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: msg.id, reason }) });
        if (!response.ok) throw new Error('delete failed (' + response.status + ')');
      } catch (error) { Trio.ui.toast(error.message); }
    });
  }
  function edit(msg, body) {
    const html = '<label class="field">Edit message <textarea name="content" rows="4">' + M.escapeHtml(msg.content || '') + '</textarea></label>';
    Trio.ui.modal('Edit message', html, async node => {
      const content = node.querySelector('[name="content"]').value;
      if (content == null || content === msg.content) return;
      try {
        const response = await fetch(apiUrl('/api/edit'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: msg.id, content }) });
        if (!response.ok) throw new Error('edit failed (' + response.status + ')');
        body.textContent = content;
      } catch (error) { Trio.ui.toast(error.message); }
    });
  }

  function closeMessageActions() {
    const menu = state.activeMessageActions;
    if (!menu) return;
    menu.classList.add('hidden');
    state.activeMessageActions = null;
  }
  function interactiveMessageTarget(target) {
    return !!target?.closest?.('a,button,input,textarea,select,fieldset');
  }
  function showMessageActions(card, content, msg, body) {
    if (!isOwn(msg) || msg.retracted_at || state.readOnly) return;
    const existing = content.querySelector('.message-actions-menu');
    if (existing && state.activeMessageActions === existing && !existing.classList.contains('hidden')) {
      closeMessageActions();
      return;
    }
    closeMessageActions();
    let menu = existing;
    if (!menu) {
      menu = document.createElement('div'); menu.className = 'message-actions-menu hidden';
      for (const [label, fn] of [['Edit', () => edit(msg, body)], ['Delete', () => retract(msg)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.addEventListener('click', () => { closeMessageActions(); fn(); });
        menu.append(button);
      }
      content.append(menu);
    }
    menu.classList.remove('hidden');
    state.activeMessageActions = menu;
  }
  function bindMessageActions(card, content, msg, body) {
    let pressTimer = null;
    const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    const startPress = event => {
      if (event.isPrimary === false || (event.button != null && event.button !== 0) || interactiveMessageTarget(event.target)) return;
      clearPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        showMessageActions(card, content, msg, body);
      }, 500);
    };
    card.addEventListener('pointerdown', startPress);
    card.addEventListener('pointerup', clearPress);
    card.addEventListener('pointercancel', clearPress);
    card.addEventListener('pointerleave', clearPress);
    card.addEventListener('contextmenu', event => {
      if (interactiveMessageTarget(event.target)) return;
      event.preventDefault(); clearPress();
      showMessageActions(card, content, msg, body);
    });
  }

  function showLightbox(url, alt) {
    let dialog = document.getElementById('trio-lightbox');
    if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'trio-lightbox'; dialog.className = 'lightbox'; document.body.append(dialog); }
    Trio.ui.configureDialog(dialog);
    dialog.innerHTML = `<form method="dialog"><button type="submit" formnovalidate class="modal-close" aria-label="Close">×</button><img src="${M.escapeHtml(url)}" alt="${M.escapeHtml(alt || '')}" loading="lazy"></form>`;
    dialog.showModal();
  }
  function cardFor(msg) {
    const vm = viewModel(msg);
    const card = document.createElement('article'); card.className = 'message msg' + (vm.isSystem ? ' system-message' : '') + (!vm.isSystem && vm.isOwn ? ' own me' : '') + (!vm.isSystem && vm.isPrivate ? ' private' : '');
    card.dataset.messageId = vm.id;
    if (vm.isSystem) {
      const content = document.createElement('div'); content.className = 'message-content msg-body';
      const body = document.createElement('div'); paintBody(card, body, vm); content.append(body);
      card.append(content);
      return card;
    }
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar av av-32 tone-' + avatarTone(vm.author);
    avatar.setAttribute('aria-hidden', 'true');
    if (vm.avatarUrl) {
      const image = document.createElement('img');
      image.className = 'avatar-svg-image'; image.src = vm.avatarUrl; image.alt = '';
      avatar.append(image);
    } else avatar.textContent = (vm.author || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
    const content = document.createElement('div'); content.className = 'message-content msg-body';
    const head = document.createElement('header'); head.className = 'message-head';
    const author = document.createElement('strong'); author.textContent = vm.author;
    const stamp = document.createElement('time');
    const idPart = document.createElement('span'); idPart.className = 'message-id'; idPart.textContent = '#' + vm.id + ' · ';
    stamp.append(idPart, document.createTextNode(vm.timestamp));
    head.append(author);
    if (vm.role) {
      const role = document.createElement('span'); role.className = 'message-role role-' + vm.role; role.textContent = vm.role;
      head.append(role);
    }
    head.append(stamp);
    if (vm.confidence) { const confidence = document.createElement('span'); confidence.className = 'confidence confidence-' + vm.confidence; confidence.textContent = vm.confidence; head.append(confidence); }
    if (vm.isPrivate) { const badge = document.createElement('span'); badge.className = 'private-badge'; badge.textContent = 'private'; head.append(badge); }
    if (vm.isTask) { const task = document.createElement('span'); task.className = 'task-chip'; task.textContent = 'task #' + vm.taskId; head.append(task); }
    if (vm.isQuestion) card.classList.add('question');
    content.append(head);
    if (vm.replyTo) {
      const reply = document.createElement('a'); reply.className = 'reply-context'; reply.href = '#m' + vm.replyTo; reply.textContent = 'replying to #' + vm.replyTo;
      reply.addEventListener('click', (e) => { e.preventDefault(); const target = document.querySelector(`[data-message-id="${vm.replyTo}"]`); if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.focus(); } });
      content.append(reply);
    }
    const target = renderTargets(vm); if (target) content.append(target);
    const body = document.createElement('div'); body.className = 'message-body bubble'; paintBody(card, body, vm); content.append(body);
    if (vm.attachments.length) {
      const attachments = document.createElement('div'); attachments.className = 'message-attachments';
      vm.attachments.forEach(attachment => {
        if (!attachment || !attachment.id) return;
        const link = document.createElement('a'); link.href = apiUrl('/api/attachment/' + attachment.id); link.target = '_blank'; link.rel = 'noopener'; link.className = 'message-attachment';
        if (/^image\//.test(attachment.mime || '')) {
          const image = document.createElement('img'); image.src = link.href; image.alt = attachment.filename || 'Attached image'; image.loading = 'lazy';
          image.addEventListener('click', (e) => { e.preventDefault(); showLightbox(link.href, image.alt); });
          image.addEventListener('error', () => { image.classList.add('error'); });
          link.append(image);
        }
        else link.textContent = attachment.filename || ('Attachment #' + attachment.id);
        attachments.append(link);
      });
      if (attachments.children.length) content.append(attachments);
    }
    const ask = askCard(msg); if (ask) content.append(ask);
    if (isOwn(msg) && !msg.retracted_at && !state.readOnly) bindMessageActions(card, content, msg, body);
    card.append(avatar, content);
    return card;
  }

  function ordered() { return [...state.messages.values()].sort((a, b) => Number(a.id) - Number(b.id)); }
  function messageHistoryDays() {
    const prefs = Trio.preferences?.read?.() || Trio.state.preferences || {};
    const n = Number(prefs.messageHistoryDays);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function olderExpanded() { state.olderExpanded = state.olderExpanded || {}; return !!state.olderExpanded[convId()]; }
  function isHiddenOld(msg) {
    const days = messageHistoryDays();
    if (days <= 0) return false;
    if (olderExpanded()) return false;
    const t = new Date(msg.created_at).getTime();
    if (isNaN(t)) return false;
    return t < Date.now() - days * 86400000;
  }
  function olderToggle(oldCount, expanded) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'older-toggle';
    if (expanded) {
      btn.textContent = 'Hide older messages';
      btn.addEventListener('click', () => { state.olderExpanded[convId()] = false; render(); });
    } else {
      btn.textContent = 'Show ' + oldCount + ' older message' + (oldCount === 1 ? '' : 's');
      btn.addEventListener('click', () => { state.olderExpanded[convId()] = true; render(); });
    }
    return btn;
  }
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
      const saved = state.scrollPositions[convId()];
      if (stick) { list.scrollTop = list.scrollHeight; markRead(); }
      else if (saved != null) { list.scrollTop = saved; }
      return;
    }
    // Age-based collapse: hide messages older than the configured threshold
    // (default 3 days) unless the user has expanded this conversation.
    const days = messageHistoryDays();
    const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
    const expanded = olderExpanded();
    let splitIndex = 0;
    if (cutoff > 0) {
      splitIndex = messages.length;
      for (let i = 0; i < messages.length; i++) {
        const t = new Date(messages[i].created_at).getTime();
        if (isNaN(t) || t >= cutoff) { splitIndex = i; break; }
      }
    }
    const oldCount = splitIndex;
    const hideOld = cutoff > 0 && oldCount > 0 && !expanded;
    const rendered = hideOld ? messages.slice(splitIndex) : messages;
    if (hideOld) list.append(olderToggle(oldCount, false));
    else if (cutoff > 0 && oldCount > 0 && expanded) list.append(olderToggle(oldCount, true));
    // Unread divider index, mapped into the rendered slice.
    let unread = messages.findIndex(msg => Number(msg.id) > Number(state.lastSeenId));
    if (state.lastSeenId === 0) unread = -1;
    let unreadRel = -1;
    if (unread >= 0) {
      if (hideOld) unreadRel = unread <= splitIndex ? 0 : unread - splitIndex;
      else unreadRel = unread;
    }
    let lastDate = '';
    rendered.forEach((msg, index) => {
      const d = date(msg.created_at);
      if (d && d !== lastDate) { lastDate = d; const day = document.createElement('div'); day.className = 'day-separator'; day.textContent = d; list.append(day); }
      if (index === unreadRel) { const divider = document.createElement('div'); divider.className = 'unread-divider'; divider.textContent = 'New since your last visit'; list.append(divider); }
      const card = cardFor(msg); list.append(card); state.messageDomById.set(msg.id, card);
    });
    const saved = state.scrollPositions[convId()];
    if (stick) { list.scrollTop = list.scrollHeight; markRead(); }
    else if (saved != null) { list.scrollTop = saved; }
  }

  function upsert(msg) {
    if (!msg || msg.id == null) return;
    if (state.dmKey) {
      const recips = new Set([...(msg.recipients || []), msg.member_id].filter(Boolean));
      const expected = state.dmMemberIds || [];
      if (state.dmAudit) {
        if (expected.length && (recips.size !== expected.length || [...recips].some(id => !expected.includes(id)))) return;
      } else {
        const op = state.operator?.id;
        if (!op || !recips.has(op)) return;
        const others = [...recips].filter(id => id !== op);
        if (expected.length && (others.length !== expected.length || others.some(id => !expected.includes(id)))) return;
      }
    }
    const wasNear = nearBottom(dom()); const previous = state.messages.get(msg.id) || {};
    state.messages.set(msg.id, Object.assign({}, previous, msg));
    const existing = state.messageDomById.get(msg.id);
    const list = dom();
    if (!existing) {
      if (list) {
        if (isHiddenOld(state.messages.get(msg.id))) {
          // Keep it in state but don't paint a card while older messages
          // are collapsed for this conversation.
        } else {
          const card = cardFor(state.messages.get(msg.id));
          // Defense in depth against an EventHub prime/live race delivering a
          // newer id ahead of older history: insert in id order instead of
          // blindly appending, so a late-arriving older message still lands
          // before the newer cards already painted.
          const nextSibling = [...list.children].find(el => el.dataset?.messageId && Number(el.dataset.messageId) > Number(msg.id));
          if (nextSibling) list.insertBefore(card, nextSibling); else list.append(card);
          state.messageDomById.set(msg.id, card);
        }
      }
      else { render(); }
      if (wasNear && list) { list.scrollTop = list.scrollHeight; markRead(); }
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
  function onPrefsChanged() { render(); }
  function init() {
    state.operator = state.operator || state.meta?.operator;
    events.addEventListener('boot', onBoot); listeners.boot = onBoot;
    events.addEventListener('message', onMessage); listeners.message = onMessage;
    events.addEventListener('message_update', onMessage); listeners.message_update = onMessage;
    events.addEventListener('roster', onRoster); listeners.roster = onRoster;
    events.addEventListener('preferences:changed', onPrefsChanged); listeners['preferences:changed'] = onPrefsChanged;
    render();
    const list = dom(); const jump = document.getElementById('jump-latest');
    if (list && jump) {
      const onScroll = () => { jump.classList.toggle('hidden', nearBottom(list)); state.scrollPositions[convId()] = list.scrollTop; if (nearBottom(list)) markRead(); };
      const onClick = () => { list.scrollTop = list.scrollHeight; markRead(); };
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

  Trio.conversation = { init, mount, unmount, render, ingest, upsert, paintBody, cardFor, viewModel, answerPayload, isPrivate };
})();
