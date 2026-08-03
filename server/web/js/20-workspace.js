(() => {
  'use strict';
  const Trio = window.Trio;
  const state = Trio.state;
  const api = Trio.api;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const listOf = value => Array.isArray(value) ? value : [];
  const pendingDecisions = new Set();
  const $ = id => document.getElementById(id);
  // Monotonic navigation generation. Bumped in loadConversation so in-flight
  // DM loaders can detect that the user navigated away before their response
  // resolved, and bail before inserting private history into the wrong view.
  let navGen = 0;

  function groupNavigation(channels = [], dms = {}) {
    return {
      active: channels.filter(c => !c.archived),
      archived: channels.filter(c => c.archived),
      yours: dms.your_dms || [],
      agentAudit: dms.agent_dms || [],
    };
  }
  const selectors = {
    pendingApprovals(src = state) { return listOf(src.approvals).filter(a => a.status !== 'resolved' && a.status !== 'accepted').length; },
    openTasks(src = state) { return listOf(src.tasks).filter(t => t.status === 'open' || t.status === 'blocked').length; },
    blockedTasks(src = state) { return listOf(src.tasks).filter(t => t.status === 'blocked').length; },
    blockedAgents(src = state) { return listOf(src.agents).filter(a => a.status === 'blocked' || a.status === 'error' || a.status === 'errored').length; },
    activeAgents(src = state) { return listOf(src.agents).filter(a => ['working','active','idle'].includes(a.status)).length; },
    unreadDms(src = state) { return (src.dms?.your_dms || []).reduce((s, d) => s + (Number(d.unread) || 0), 0); },
    unreadMentions(src = state) { return listOf(src.mentions).filter(m => !m.read).length; },
    pendingQuestions(src = state) { return listOf(src.questions).length; },
    recentChannels(src = state) { return (src.channels || []).filter(c => !c.archived).slice(0, 5); },
    taskItems(src = state) {
      return listOf(src.tasks).map(t => ({
        id: t.id || t.task_id,
        status: t.status || 'open',
        title: t.description || t.message || t.title || 'Task',
        owner: t.claimed_by || '',
        blockers: Array.isArray(t.blocked_by) ? t.blocked_by : [],
        channel: t.channel,
        updatedAt: t.updated_at,
      }));
    },
    attention(src = state) { return selectors.pendingApprovals(src) + selectors.pendingQuestions(src); },
    attentionItems(src = state) {
      const items = [];
      for (const a of listOf(src.approvals)) {
        if (a.status === 'resolved' || a.status === 'accepted') continue;
        items.push({ id: a.id, kind: 'approval', severity: 'high', title: a.title || a.agent_name || 'Approval requested', source: a.agent_name || a.member_id, timestamp: a.created_at, status: a.status, body: a.reason || a.command || '', actions: ['accept','acceptForSession','decline', ...(a.can_cancel ? ['cancel'] : [])] });
      }
      for (const q of listOf(src.questions)) {
        items.push({ id: 'question-' + q.id, kind: 'question', severity: 'medium', title: q.question || 'Question', source: q.member_name || q.member_id, timestamp: q.created_at, status: 'pending', body: q.content || '', channel: q.channel, actions: [] });
      }
      return items.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    },
  };
  function attentionCount(meta = state.meta || {}) { return selectors.pendingApprovals({ approvals: meta.approvals }); }
  function openChannel(code, extra = '') {
    const readOnly = extra === 'archived';
    if (Trio.router?.navigate) Trio.router.navigate('channel', { code, archived: readOnly });
    loadConversation(code, '#' + code, readOnly ? 'Archived channel — read only' : 'Live agent workspace', readOnly, false);
  }
  function loadConversation(channel, title, subtitle, readOnly = false, isDm = false, isAudit = false) {
    if (Trio.store) Trio.store.set('session.channel', channel);
    // Invalidate any in-flight DM loaders and cancel their fetches. Without
    // this, a late DM response resolved after navigating to a channel (or
    // another DM) would insert private history into the now-current view,
    // because the completion handler no longer sees a dmKey to filter against.
    navGen++;
    if (!isDm) Trio.loader?.cancelAll?.('dm:');
    state.view = 'conversation';
    showConversationPage();
    state.readOnly = !!readOnly;
    state.dmAudit = !!isAudit;
    state.dmKey = isDm ? (state.dmKey || '') : '';
    state.dmLoading = false;
    state.dmError = '';
    if (!isDm) state.dmThread = null;
    state.channel = channel;
    renderRail();
    document.getElementById('h-channel').textContent = title;
    document.getElementById('h-meta').textContent = subtitle;
    renderFacePile();
    const detailsBtn = $('details-btn');
    const moreBtn = $('channel-more-btn');
    const searchBtn = $('search-btn');
    const conn = $('h-conn');
    if (detailsBtn) detailsBtn.classList.remove('hidden');
    if (moreBtn) moreBtn.classList.remove('hidden');
    if (searchBtn) searchBtn.classList.remove('hidden');
    if (conn) conn.classList.remove('hidden');
    const banner = document.getElementById('private-banner');
    if (banner) { banner.classList.toggle('hidden', !isDm); banner.classList.toggle('audit', !!isAudit); banner.textContent = isDm ? (isAudit ? 'Agent-to-agent audit — read only' : readOnly ? 'Archived private conversation — read only' : 'Private conversation') : ''; }
    state.messages = new Map(); state.messageDomById = new Map(); state.answers = new Map();
    Trio.conversation?.render?.();
    Trio.composer?.syncReadOnly?.();
    Trio.startEvents?.(state.channel);
  }
  function openDm(dm, readOnly = false, audit = false) {
    const auditReadOnly = !!audit;
    state.dmMemberIds = (dm.member_ids || []).slice();
    state.dmTargetId = state.dmMemberIds[0] || '';
    state.dmName = dm.name || dm.key;
    state.dmKey = dm.key;
    state.dmThread = dm;
    loadConversation(dm.channel || state.channel, 'DM ' + state.dmName, auditReadOnly ? 'Agent-to-agent audit' : readOnly ? 'Archived private conversation' : 'Private conversation', readOnly || auditReadOnly, true, auditReadOnly);
    if (Trio.router?.navigate) Trio.router.navigate(auditReadOnly ? 'audit' : 'dm', { key: dm.key, ...(readOnly && !auditReadOnly ? { archived: true } : {}) });
    Trio.loader?.cancel?.('dm:' + dm.key);
    state.dmLoading = true; state.dmError = ''; Trio.conversation?.render?.();
    // Capture the navigation generation and dm key after loadConversation so
    // the completion handler can reject a stale response (user navigated to a
    // channel or a different DM before this resolved).
    const gen = navGen;
    const dmKey = dm.key;
    const loader = Trio.loader?.load ? Trio.loader : { load: (name, fn) => { const c = { abort() {} }; return fn(c); } };
    loader.load('dm:' + dm.key, signal => api.get('/api/dms?with=' + encodeURIComponent(dm.key) + (readOnly && !auditReadOnly ? '&archived=1' : ''), false, { signal })).then(data => {
      if (gen !== navGen || state.dmKey !== dmKey) return;
      state.dmLoading = false; state.dmError = '';
      if (data && Array.isArray(data.messages)) { data.messages.forEach(Trio.conversation.upsert); }
      if (data && data.ok === false) { state.dmError = data.error || 'Could not load DM'; }
      Trio.conversation?.render?.();
    }).catch(error => {
      if (gen !== navGen) return;
      if (error?.name === 'AbortError' || (typeof error === 'string' && error.includes('aborted'))) return;
      state.dmLoading = false; state.dmError = error.message || 'Could not load DM'; Trio.conversation?.render?.();
    });
  }
  function openDmByKey(key, audit = false) {
    if (!key) return;
    const gen = navGen;
    api.get('/api/dms?with=' + encodeURIComponent(key)).then(data => {
      if (gen !== navGen) return null;
      const auditThread = (data.agent_dms || []).find(d => d.key === key);
      if (audit && auditThread) return openDm(auditThread, false, true);
      const yours = (data.your_dms || []).find(d => d.key === key);
      if (yours) return openDm(yours, false, false);
      if (auditThread) return openDm(auditThread, false, true);
      return api.get('/api/dms?archived=1&with=' + encodeURIComponent(key));
    }).then(data => {
      if (gen !== navGen) return;
      if (data) { const dm = (data.your_dms || []).find(d => d.key === key); if (dm) openDm(dm, true); }
    }).catch(error => {
      if (gen !== navGen) return;
      Trio.ui.toast(error.message || 'Could not load DM');
    });
  }
  const toast = m => Trio.ui.toast(m);
  const modal = (t, b, s) => Trio.ui.modal(t, b, s);
  async function archive(kind, key, archived) {
    try { await api.post('/api/archives', {kind, key, archived}); await refresh(); Trio.ui.toast(archived ? 'Archived' : 'Restored'); }
    catch (error) { Trio.ui.toast(error.message || 'Could not update archive'); }
  }
  async function resolveApproval(id, decision) {
    if (!id || pendingDecisions.has(id + ':' + decision)) return;
    pendingDecisions.add(id + ':' + decision);
    try {
      const url = decision === 'cancel' ? '/api/approvals/' + encodeURIComponent(id) + '/cancel' : '/api/approvals/' + encodeURIComponent(id) + '/resolve';
      await api.post(url, { decision });
      const list = listOf(state.approvals);
      const a = list.find(x => x.id === id);
      if (a) {
        a.status = (decision === 'accept' || decision === 'acceptForSession') ? 'accepted' : 'resolved';
        a.resolved_decision = decision;
      }
      showView('attention');
      await Trio.workspace?.refresh?.();
    } catch (error) { Trio.ui.toast(error.message || 'Could not resolve approval'); }
    finally { pendingDecisions.delete(id + ':' + decision); }
  }
  function navIcon(name) {
    const icons = {
      home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9"/>',
      attention: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 13 7 5h10l2 8v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1Z"/>',
      tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
      messages: '<path d="M22 7L12 13 2 7"/><path d="M2 7v10h20V7z"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      roster: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-4.9"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
  }
  function initials(label) { return String(label || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(); }
  function agentRecord(idOrName) {
    const agents = Trio.store?.get('agents.list') || state.agents || [];
    return agents.find(agent => agent.id === idOrName || agent.name === idOrName) || null;
  }
  function avatar(label, tone = 'eucalyptus', status = '', avatarUrl = '') {
    const content = avatarUrl
      ? `<img src="${esc(avatarUrl)}" alt="" class="avatar-svg-image">`
      : esc(initials(label));
    return `<span class="av av-28 tone-${tone} ${avatarUrl ? 'avatar-svg' : ''} ${status ? 'st-' + status : ''}">${content}${status ? '<span class="st-ring"></span>' : ''}</span>`;
  }
  function avatarFor(memberOrName, status = '') {
    const member = typeof memberOrName === 'object' ? memberOrName : null;
    const label = member?.name || member?.id || memberOrName || '?';
    const agent = agentRecord(member?.id || label);
    return avatar(label, avatarTone(label), status, member?.avatar_url || agent?.avatar_url || '');
  }
  // Shared with 11-conversation.js via Trio.avatarTone (00-core.js) — see its
  // comment there for why this needed to stop being a bare per-label hash.
  const avatarTone = Trio.avatarTone;
  function renderFacePile() {
    const pile = $('face-pile'); if (!pile) return;
    if (!state.channel) { pile.classList.add('hidden'); return; }
    pile.classList.remove('hidden');
    pile.replaceChildren();
    const allMembers = [...(state.members?.values?.() || [])];
    // For a DM, show only conversation participants — not the whole inbox
    // channel roster (which lists every agent ever created).
    const members = state.dmKey && Array.isArray(state.dmMemberIds) && state.dmMemberIds.length
      ? allMembers.filter(m => state.dmMemberIds.includes(m.id))
      : allMembers;
    const operator = state.operator || state.meta?.operator;
    if (operator?.id && !members.some(member => member.id === operator.id)) members.push(operator);
    // Merge the supervisor's {live,busy,state} over the roster member — the same
    // source the channel drawer uses — so the face-pile dot agrees with the
    // drawer/roster instead of reading only the heartbeat-based roster status.
    const agentsById = new Map((state.agents || []).map(a => [a.id, a]));
    const withAgent = member => { const agent = agentsById.get(member.id); return agent ? { ...member, ...agent } : member; };
    const visible = members.slice(0, 4);
    visible.forEach(member => {
      const merged = withAgent(member);
      const node = document.createElement('span');
      // The human operator viewing this dashboard is inherently present —
      // their bare {id,name,source} shape carries no status/live/state for
      // channelStatus to read, which previously fell through to 'offline'.
      const status = (operator?.id && member.id === operator.id) ? 'active' : channelStatus(merged);
      node.innerHTML = avatarFor(merged, status);
      const face = node.firstElementChild;
      const label = member.name || member.id || 'Channel member';
      face.setAttribute('aria-label', label + (status === 'working' ? ' — actively working' : ''));
      face.title = label + toolSuffix(merged, status);
      pile.append(face);
    });
    if (members.length > visible.length) {
      const more = document.createElement('span');
      more.className = 'more'; more.textContent = '+' + (members.length - visible.length);
      more.setAttribute('aria-label', `${members.length - visible.length} more channel members`);
      pile.append(more);
    }
    pile.classList.toggle('hidden', !members.length);
  }
  function navigateView(view) {
    const route = { home: 'home', attention: 'attention', messages: 'messages', tasks: 'tasks', roster: 'roster', prefs: 'prefs' }[view] || 'home';
    if (Trio.router?.navigate) Trio.router.navigate(route);
    else showView(view);
  }
  function navItem(label, icon, onClick, badge = '', active = false) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'nav-item'; button.classList.toggle('active', active);
    button.setAttribute('data-tip', label);
    button.innerHTML = `<span class="nav-hash">${icon === 'hash' ? '#' : navIcon(icon)}</span><span class="nav-label">${esc(label)}</span>${badge ? `<span class="nav-meta"><span class="badge">${esc(badge)}</span></span>` : ''}`;
    button.addEventListener('click', onClick); return button;
  }
  function section(title, items, add, onAdd = createChannel, addLabel = 'Create channel') {
    const wrap = document.createElement('section'); wrap.className = 'nav-section';
    const head = document.createElement('div'); head.className = 'nav-head'; head.innerHTML = `<h3>${esc(title)}</h3>`;
    if (add) { const button = document.createElement('button'); button.type = 'button'; button.className = 'add-btn'; button.setAttribute('aria-label', addLabel); button.title = addLabel; button.innerHTML = navIcon('plus'); button.addEventListener('click', onAdd); head.append(button); }
    wrap.append(head); items.forEach(item => wrap.append(item)); return wrap;
  }
  function itemWithAdd(item, onAdd, addLabel) {
    const row = document.createElement('div'); row.className = 'nav-item-row';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'add-btn'; button.setAttribute('aria-label', addLabel); button.title = addLabel; button.innerHTML = navIcon('plus'); button.addEventListener('click', onAdd);
    row.append(item, button); return row;
  }
  function dmItem(dm, audit = false) {
    const label = dm.name || dm.key || 'Conversation';
    const people = label.split(/\s*[↔·,]\s*/).filter(Boolean);
    const visual = audit && people.length > 1 ? `<span class="dm-pair">${avatarFor(people[0])}${avatarFor(people[1])}</span>` : avatarFor(people[0] || label, dm.unread ? 'online' : 'idle');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'dm-item'; button.classList.toggle('active', state.view === 'conversation' && state.dmKey === dm.key);
    button.setAttribute('data-tip', label);
    button.innerHTML = `${visual}<span class="dm-copy"><span class="dm-name">${esc(label)}</span></span>${dm.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}`;
    button.addEventListener('click', () => openDm(dm, false, audit)); return button;
  }
  function renderRail() {
    const rail = $('workspace-rail'); if (!rail) return;
    const nav = groupNavigation(state.channels || [], state.dms || {});
    rail.textContent = '';
    const workspaceItems = [
      navItem('Home', 'home', () => navigateView('home'), '', state.view === 'home'),
      navItem('Attention', 'attention', () => navigateView('attention'), String(selectors.attention() || ''), state.view === 'attention'),
      navItem('Messages', 'messages', () => navigateView('messages'), String(selectors.unreadDms() + selectors.unreadMentions() || ''), state.view === 'messages'),
      itemWithAdd(navItem('Agent roster', 'roster', () => navigateView('roster'), '', state.view === 'roster'), () => Trio.agents?.create?.(), 'Create agent'),
      navItem('Tasks', 'tasks', () => navigateView('tasks'), '', state.view === 'tasks'),
      navItem('Preferences', 'settings', () => navigateView('prefs'), '', state.view === 'prefs'),
    ];
    const channelItems = nav.active.map(c => navItem(c.code, 'hash', () => openChannel(c.code), c.unread || '', state.view === 'conversation' && !state.dmKey && state.channel === c.code));
    if (!channelItems.length && state.workspaceLoading) { const loading = document.createElement('div'); loading.className = 'nav-loading'; loading.textContent = 'Loading channels…'; channelItems.push(loading); }
    rail.append(section('Workspace', workspaceItems));
    rail.append(section('Channels', channelItems, true));
    rail.append(section('Direct Messages', nav.yours.map(d => dmItem(d)), true, openDmDialog, 'Start direct message'));
    rail.append(section('Agent-to-Agent', nav.agentAudit.map(d => dmItem(d, true))));
    const operator = state.operator || state.meta?.operator || {}; const opName = operator.name || 'Workspace'; const opAvatar = $('operator-avatar'); const opLabel = $('operator-name'); const opRole = $('operator-role');
    if (opAvatar) { opAvatar.textContent = initials(opName); opAvatar.className = 'operator-avatar tone-' + avatarTone(opName); }
    if (opLabel) opLabel.textContent = opName; if (opRole) opRole.textContent = operator.name ? 'Workspace owner' : 'Live agent coordination';
  }
  function updateTopbar(title, subtitle) {
    const h = $('h-channel'); const m = $('h-meta');
    if (h) h.textContent = title || 'Atrium';
    if (m) m.textContent = subtitle || '';
  }
  function showConversationPage() {
    const shell = document.querySelector('.conversation-shell');
    shell?.classList.remove('workspace-page');
    document.querySelectorAll('[data-trio-view]').forEach(panel => { panel.hidden = true; });
  }
  function viewHeader(title, subtitle) {
    const header = document.createElement('div'); header.className = 'view-hero';
    header.innerHTML = `<h2>${esc(title)}</h2><p>${esc(subtitle)}</p>`;
    return header;
  }
  async function markMessagesRead(ids, read = true) {
    if (!ids || !ids.length) return;
    try {
      await api.post('/api/messages/mark-read', { ids, read });
    } catch (error) { console.warn('mark read failed', error); }
  }
  function statusLabel(agent) {
    const status = String(agent.status || agent.state || (agent.busy ? 'working' : agent.live ? 'active' : 'offline')).toLowerCase();
    return status === 'working' || status === 'active' ? status : status === 'error' || status === 'errored' ? 'errored' : status;
  }
  function renderHome(panel) {
    panel.replaceChildren();
    if (state.workspaceLoading) { const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'Loading workspace…'; panel.append(p); return; }
    if (state.workspaceError) { const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = state.workspaceError; const b = document.createElement('button'); b.type = 'button'; b.className = 'btn primary'; b.textContent = 'Retry'; b.addEventListener('click', refresh); p.append(b); panel.append(p); return; }
    const operatorName = state.operator?.name || state.meta?.operator?.name || 'there';
    const intro = document.createElement('div'); intro.className = 'hello';
    intro.innerHTML = `<div class="greet">Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${esc(operatorName)}.</div><div class="sub">Here’s what’s happening across your workspace.</div>`;
    const grid = document.createElement('div'); grid.className = 'home-grid';
    const cards = [
      { title: 'Attention inbox', count: selectors.attention(), subtitle: 'Need a decision', tone: 'warn', detail: `${selectors.pendingApprovals()} approvals · ${selectors.pendingQuestions()} questions`, action: () => navigateView('attention') },
      { title: 'Messages for you', count: selectors.unreadDms() + selectors.unreadMentions(), subtitle: 'Unread & mentions', tone: 'accent', detail: `${selectors.unreadDms()} DMs · ${selectors.unreadMentions()} mentions`, action: () => navigateView('messages') },
      { title: 'Tasks in flight', count: selectors.openTasks(), subtitle: 'Across every channel', tone: 'ok', detail: `${listOf(state.tasks).filter(t => t.status === 'claimed').length} claimed · ${listOf(state.tasks).filter(t => t.status === 'blocked').length} blocked`, action: () => navigateView('tasks') },
    ];
    for (const { title, count, subtitle, tone, detail, action } of cards) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'hcard';
      card.innerHTML = `<div class="hc-top"><span class="hc-ic ${tone}"><span aria-hidden="true">${tone === 'warn' ? '!' : tone === 'ok' ? '✓' : '✦'}</span></span><span><span class="hc-title">${esc(title)}</span><span class="hc-sub">${esc(subtitle)}</span></span></div><span class="hc-num">${esc(String(count))}</span><span class="hc-sub">${esc(detail)}</span>`;
      card.addEventListener('click', action); grid.append(card);
    }
    const agents = (Array.isArray(Trio.store?.get('agents.list')) ? Trio.store.get('agents.list') : Array.isArray(state.agents) ? state.agents : []).filter(a => ['working','active'].includes(statusLabel(a))).slice(0, 4);
    const working = document.createElement('section'); working.className = 'home-section';
    working.innerHTML = `<div class="sec-head"><h3>Working right now</h3><span class="count">${agents.length}</span><span class="sh-line"></span></div>`;
    const workingList = document.createElement('div'); workingList.className = 'home-agent-list';
    if (!agents.length) { const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'No agents are active right now.'; workingList.append(p); }
    agents.forEach(agent => { const row = document.createElement('div'); row.className = 'hc-row'; row.innerHTML = `<span class="dotm" style="background:var(--ok)"></span><span class="grow"><b>${esc(agent.name || agent.id || 'Agent')}</b> · ${esc(agent.status_text || agent.status || 'Active')}</span><span class="t">${esc(agent.provider || 'agent')}</span>`; workingList.append(row); });
    working.append(workingList);
    const recent = document.createElement('section'); recent.className = 'home-section';
    recent.innerHTML = `<div class="sec-head"><h3>Recently active channels</h3><span class="sh-line"></span></div>`;
    const recentList = document.createElement('div'); recentList.className = 'home-channel-list';
    const chans = selectors.recentChannels();
    if (!chans.length) { const p = document.createElement('p'); p.textContent = 'No active channels.'; p.className = 'home-empty'; recentList.append(p); }
    for (const c of chans) { const b = document.createElement('button'); b.type = 'button'; b.className = 'home-channel'; b.innerHTML = `<strong>#${esc(c.code)}</strong><span>${esc(c.topic || 'No topic')}</span><small>${esc(String(c.members?.length || 0))} members${c.unread ? ` · ${esc(String(c.unread))} unread` : ''}</small>`; b.addEventListener('click', () => openChannel(c.code)); recentList.append(b); }
    recent.append(recentList);
    const usage = document.createElement('section'); usage.className = 'home-section'; usage.innerHTML = '<div class="sec-head"><h3>Usage</h3><span class="sh-line"></span></div>';
    usage.append(usageMeters(state.usage));
    const health = document.createElement('section'); health.className = 'home-section'; health.innerHTML = '<div class="sec-head"><h3>Runtime health</h3><span class="sh-line"></span></div>';
    const healthRow = document.createElement('div'); healthRow.className = 'health-row';
    const agentList = Array.isArray(Trio.store?.get('agents.list')) ? Trio.store.get('agents.list') : Array.isArray(state.agents) ? state.agents : [];
    [['Hub', 'ok', 'Live'], ['Agents', 'ok', String(agentList.length) + ' connected'], ['Database', 'ok', 'Ready']].forEach(([name, tone, value]) => { const chip = document.createElement('span'); chip.className = 'hchip'; chip.innerHTML = `<span class="d ${tone}"></span>${esc(name)} · ${esc(value)}`; healthRow.append(chip); });
    health.append(healthRow);
    panel.append(viewHeader('Home', 'Your workspace at a glance'), intro, grid, working, usage, recent, health);
  }
  function renderAttention(panel) {
    panel.replaceChildren(); panel.append(viewHeader('Attention', 'Everything waiting for you, in one calm place'));
    const tabs = document.createElement('div'); tabs.className = 'att-tabs';
    [['all','All'],['approval','Approvals'],['question','Questions']].forEach(([key,label]) => { const b = document.createElement('button'); b.type = 'button'; b.className = (state.attentionFilter || 'all') === key ? 'on' : ''; b.textContent = label; b.addEventListener('click', () => { state.attentionFilter = key; showView('attention'); }); tabs.append(b); });
    const tabsWrap = document.createElement('div'); tabsWrap.className = 'att-tabs-wrap'; tabsWrap.append(tabs); panel.append(tabsWrap);
    const items = selectors.attentionItems();
    const filtered = (state.attentionFilter && state.attentionFilter !== 'all') ? items.filter(item => item.kind === state.attentionFilter) : items;
    if (!filtered.length) { const p = document.createElement('p'); p.textContent = 'Nothing needs attention.'; p.className = 'home-empty'; panel.append(p); return; }
    const list = document.createElement('section'); list.className = 'attention-list';
    for (const item of filtered) {
      const article = document.createElement('article'); article.className = 'att-card k-' + item.kind;
      article.innerHTML = `<div class="ac-h"><span class="avatar-fallback">${esc((item.source || '?').slice(0,2).toUpperCase())}</span><span><span class="who">${esc(item.source || 'Workspace')}</span><span class="sub">${esc(item.kind)} · ${esc(timeAgo(item.timestamp) || 'now')}</span></span><span class="waiting"><span class="p"></span>waiting for you</span></div><div class="reason">${esc(item.title)}</div>${item.body ? `<div class="att-detail"><div class="r"><span class="k">Details</span><span class="v">${esc(item.body)}</span></div></div>` : ''}`;
      if (item.actions.length) {
        const row = document.createElement('div'); row.className = 'att-actions';
        for (const d of item.actions) {
          const b = document.createElement('button'); b.type = 'button'; b.className = d === 'decline' || d === 'cancel' ? 'abtn danger' : d === 'acceptForSession' ? 'abtn soft' : 'abtn ok'; b.textContent = d === 'accept' ? 'Allow once' : d === 'acceptForSession' ? 'Allow for session' : d[0].toUpperCase() + d.slice(1);
          b.disabled = pendingDecisions.has(item.id + ':' + d);
          b.addEventListener('click', () => resolveApproval(item.id, d));
          row.append(b);
        }
        article.append(row);
      }
      list.append(article);
    }
    panel.append(list);
  }
  function timeAgo(iso) { if (!iso) return ''; try { const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + 'm'; const h = Math.floor(m / 60); if (h < 24) return h + 'h'; return Math.floor(h / 24) + 'd'; } catch { return ''; } }
  function usageTone(pct) { return pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok'; }
  // Floors rather than rounds so "resets in Nh" is always a safe lower bound
  // (a user who waits N hours never finds the reset already overdue), and
  // distinguishes an already-past reset ("resets now" — the cached quota
  // read is just stale) from one genuinely under an hour out.
  function resetLabel(unixSeconds) {
    if (!unixSeconds) return '';
    const ms = unixSeconds * 1000 - Date.now();
    if (ms <= 0) return 'resets now';
    const h = Math.floor(ms / 3600000);
    if (h < 1) return 'resets within the hour';
    if (h < 24) return `resets in ${h}h`;
    return `resets in ${Math.floor(h / 24)}d`;
  }
  function usageMeter(label, pct, resetsAt) {
    const wrap = document.createElement('div'); wrap.className = 'usage-meter';
    if (pct == null) {
      wrap.innerHTML = `<div class="usage-meter-head"><span>${esc(label)}</span><span class="usage-meter-pct">unknown</span></div>`;
      return wrap;
    }
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    wrap.innerHTML = `<div class="usage-meter-head"><span>${esc(label)}</span><span class="usage-meter-pct">${esc(String(p))}%${resetsAt ? ' · ' + esc(resetLabel(resetsAt)) : ''}</span></div><div class="usage-meter-track"><div class="usage-meter-fill ${usageTone(p)}" style="width:${p}%"></div></div>`;
    return wrap;
  }
  function usageMeters(usage) {
    const wrap = document.createElement('div'); wrap.className = 'usage-meters';
    const claude = usage?.claude;
    if (claude?.available) {
      wrap.append(usageMeter('Claude Code · 5 hour', claude.five_hour?.used_percentage, claude.five_hour?.resets_at));
      wrap.append(usageMeter('Claude Code · weekly', claude.seven_day?.used_percentage, claude.seven_day?.resets_at));
    } else {
      const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'Claude Code usage data not available.'; wrap.append(p);
    }
    if (!usage?.codex?.available) {
      // Framed as "not tracked yet" rather than an error/failure state —
      // this is permanently true until a Codex quota source exists, so it
      // must never read like something is broken.
      const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'Codex usage tracking isn’t available yet.'; wrap.append(p);
    }
    return wrap;
  }
  function renderTasks(panel) {
    panel.replaceChildren(); panel.append(viewHeader('Tasks', 'Claimable work across every channel'));
    const filters = ['open', 'claimed', 'blocked', 'done', 'all'];
    const filter = filters.includes(state.taskFilter) ? state.taskFilter : 'open';
    const filterBar = document.createElement('div'); filterBar.className = 'att-tabs';
    for (const f of filters) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = f[0].toUpperCase() + f.slice(1);
      b.className = f === filter ? 'on' : '';
      b.addEventListener('click', () => { state.taskFilter = f; showView('tasks'); });
      filterBar.append(b);
    }
    panel.append(filterBar);
    const counts = { open: 0, claimed: 0, blocked: 0, done: 0, all: 0 };
    const all = selectors.taskItems();
    for (const t of all) { counts[t.status] = (counts[t.status] || 0) + 1; counts.all++; }
    const list = document.createElement('div'); list.className = 'task-list';
    const rows = filter === 'all' ? all : all.filter(t => t.status === filter);
    if (!rows.length) { const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'No ' + (filter === 'all' ? '' : filter + ' ') + 'tasks.'; list.append(p); }
    for (const t of rows) {
      const row = document.createElement('article'); row.className = 'task-row';
      const stateClass = ['open','claimed','blocked','done'].includes(t.status) ? t.status : 'cancelled';
      row.innerHTML = `<span class="tnum">#${esc(t.id)}</span><span class="tmain"><span class="tdesc">${esc(t.title)}</span><span class="tmeta"><span class="tstate ${stateClass}"><span class="d"></span>${esc(t.status)}</span>${t.channel ? `<span>#${esc(t.channel)}</span>` : ''}${t.owner ? `<span>· ${esc(t.owner)}</span>` : ''}${t.blockers.length ? `<span class="dep-chip">depends on ${esc(t.blockers.join(', '))}</span>` : ''}</span></span>`;
      list.append(row);
    }
    panel.append(list);
    const count = document.createElement('p'); count.className = 'task-count'; count.textContent = `open ${counts.open} · claimed ${counts.claimed} · blocked ${counts.blocked} · done ${counts.done}`;
    panel.append(count);
  }
  function renderMessages(panel) {
    panel.replaceChildren(); panel.append(viewHeader('Messages', 'Mentions and direct messages, with read/unread state'));
    const tabs = document.createElement('div'); tabs.className = 'att-tabs';
    const tabKeys = [['all','All'],['mentions','Mentions'],['dms','DMs']];
    const filter = tabKeys.map(t => t[0]).includes(state.messagesTab) ? state.messagesTab : 'all';
    for (const [key, label] of tabKeys) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      const count = key === 'all' ? selectors.unreadDms() + selectors.unreadMentions() : key === 'mentions' ? selectors.unreadMentions() : selectors.unreadDms();
      if (count) { const badge = document.createElement('span'); badge.className = 'mini-badge'; badge.textContent = String(count); b.append(badge); }
      b.className = filter === key ? 'on' : '';
      b.addEventListener('click', () => { state.messagesTab = key; showView('messages'); });
      tabs.append(b);
    }
    const tabsWrap = document.createElement('div'); tabsWrap.className = 'att-tabs-wrap'; tabsWrap.append(tabs); panel.append(tabsWrap);
    const list = document.createElement('section'); list.className = 'attention-list';

    function mentionCard(m) {
      const article = document.createElement('article'); article.className = 'att-card k-mention' + (m.read ? '' : ' unread');
      const source = m.member_name || m.member_id || 'Unknown';
      const head = `<div class="ac-h"><span class="avatar-fallback">${esc(source.slice(0,2).toUpperCase())}</span><span><span class="who">${esc(source)}</span><span class="sub">#${esc(m.channel)} · ${esc(timeAgo(m.created_at) || 'now')}</span></span>${m.read ? '' : '<span class="waiting"><span class="p"></span>unread</span>'}</div>`;
      const body = `<div class="reason">${esc(m.content || '')}</div>`;
      const actions = document.createElement('div'); actions.className = 'att-actions';
      if (!m.read) {
        const readBtn = document.createElement('button'); readBtn.type = 'button'; readBtn.className = 'abtn ok'; readBtn.textContent = 'Mark read';
        readBtn.addEventListener('click', (e) => { e.stopPropagation(); markMessagesRead([m.id]).then(() => { m.read = true; if (state.messagesTab === 'all' || state.messagesTab === 'mentions') renderMessages(panel); else showView('messages'); }); });
        actions.append(readBtn);
      }
      article.innerHTML = head + body;
      article.append(actions);
      article.addEventListener('click', () => { markMessagesRead([m.id]).then(() => { m.read = true; openChannel(m.channel); setTimeout(() => { const card = document.querySelector(`[data-message-id="${m.id}"]`); if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.focus(); } }, 300); }); });
      return article;
    }

    function dmCard(dm) {
      const article = document.createElement('article'); article.className = 'att-card k-mention' + (dm.unread ? ' unread' : '');
      const label = dm.name || dm.key || 'Conversation';
      const head = `<div class="ac-h"><span class="avatar-fallback">${esc((label).slice(0,2).toUpperCase())}</span><span><span class="who">${esc(label)}</span><span class="sub">Direct message · ${esc(timeAgo(dm.last_at) || 'now')}</span></span>${dm.unread ? `<span class="waiting"><span class="p"></span>${Number(dm.unread) || ''} unread</span>` : ''}</div>`;
      const body = `<div class="reason">${esc(dm.from || 'Someone')}: ${esc(dm.preview || '')}</div>`;
      article.innerHTML = head + body;
      article.addEventListener('click', () => { openDm(dm); });
      return article;
    }

    const showMentions = filter === 'all' || filter === 'mentions';
    const showDms = filter === 'all' || filter === 'dms';
    let items = [];
    if (showMentions) { for (const m of listOf(state.mentions)) items.push({ ...m, kind: 'mention' }); }
    if (showDms) { for (const d of (state.dms?.your_dms || [])) if (!d.archived) items.push({ ...d, kind: 'dm' }); }
    items.sort((a, b) => new Date(b.created_at || b.last_at || 0) - new Date(a.created_at || a.last_at || 0));

    if (!items.length) {
      const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'No messages.';
      list.append(p);
    } else {
      for (const item of items) {
        list.append(item.kind === 'mention' ? mentionCard(item) : dmCard(item));
      }
    }
    if (filter === 'mentions' && listOf(state.mentions).some(m => !m.read)) {
      const footer = document.createElement('div'); footer.className = 'att-actions';
      const allBtn = document.createElement('button'); allBtn.type = 'button'; allBtn.className = 'abtn ok'; allBtn.textContent = 'Mark all mentions read';
      allBtn.addEventListener('click', async () => {
        const ids = listOf(state.mentions).filter(m => !m.read).map(m => m.id);
        await markMessagesRead(ids);
        listOf(state.mentions).forEach(m => m.read = true);
        renderMessages(panel);
        renderRail();
      });
      footer.append(allBtn); panel.append(footer);
    }
    panel.append(list);
  }
  function showView(view) {
    state.view = view;
    state.channel = '';
    state.dmKey = '';
    state.dmName = '';
    state.readOnly = false;
    state.members = new Map();
    Trio.stopEvents?.();
    closeDetails();
    $('app')?.classList.remove('channel-details-open');
    const detailsBtn = $('details-btn');
    const moreBtn = $('channel-more-btn');
    const searchBtn = $('search-btn');
    const conn = $('h-conn');
    if (detailsBtn) detailsBtn.classList.add('hidden');
    if (moreBtn) moreBtn.classList.add('hidden');
    if (searchBtn) searchBtn.classList.add('hidden');
    if (conn) conn.classList.add('hidden');
    const shell = document.querySelector('.conversation-shell');
    shell?.classList.add('workspace-page');
    updateTopbar(view === 'home' ? 'Atrium' : view[0].toUpperCase() + view.slice(1), view === 'home' ? 'Home' : `trio view · ${view}`);
    document.querySelectorAll('[data-trio-view]').forEach(n => n.hidden = true);
    let panel = $(`trio-${view}-view`);
    if (!panel) { panel = document.createElement('section'); panel.id = `trio-${view}-view`; panel.dataset.trioView = view; panel.className = 'workspace-view'; document.querySelector('.conversation-shell')?.prepend(panel); }
    panel.hidden = false;
    if (view === 'home') { renderHome(panel); }
    else if (view === 'tasks') { renderTasks(panel); }
    else if (view === 'attention') { renderAttention(panel); }
    else if (view === 'messages') { renderMessages(panel); }
    else if (view === 'roster') { Trio.agents?.renderPage?.(panel); }
    else if (view === 'prefs') { Trio.preferences?.renderPage?.(panel); }
    else panel.innerHTML = `<h2>Home</h2><p>${(state.channels || []).length} active channels · ${(state.dms?.your_dms || []).length} direct conversations</p>`;
    renderFacePile();
    renderRail();
  }
  async function createChannel() {
    modal('Create channel', '<label>Channel code<input name="code" required pattern="[a-z0-9][a-z0-9-]*"></label><label>Topic<input name="topic"></label>', async node => { const f=new FormData(node.querySelector('form')); try { await api.post('/api/channels', {code:f.get('code'),topic:f.get('topic')}); openChannel(f.get('code')); } catch (error) { toast(error.message || 'Could not create channel'); } });
  }
  function dmTargets() {
    const targets = state.dms?.targets || [];
    if (targets.length) return targets.slice().sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    return (Trio.store?.get('agents.list') || state.agents || []).map(agent => ({id: agent.id, name: agent.name || agent.id, dm_channel: agent.dm_channel})).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  function openDmDialog() {
    const targets = dmTargets();
    const options = targets.map(target => `<option value="${esc(target.id)}">${esc(target.name || target.id)}</option>`).join('');
    modal('Start a direct message', `<p>Choose an agent to open a private conversation with.</p><label for="dm-agent">Agent<select id="dm-agent" name="agent" required ${targets.length ? '' : 'disabled'}><option value="">Select an agent…</option>${options}</select></label>${targets.length ? '' : '<p class="home-empty">No agents are available yet.</p>'}`, node => {
      const id = new FormData(node.querySelector('form')).get('agent');
      const target = targets.find(item => item.id === id);
      if (!target) return;
      const existing = (state.dms?.your_dms || []).find(dm => dm.key === id);
      openDm(existing || {key: id, member_ids: [id], name: target.name || id, channel: target.dm_channel || state.channel});
    });
    document.getElementById('dm-agent')?.focus();
  }
  function viewArchiveChannel(code) { loadConversation(code, 'trio#' + code, 'Archived channel — read only', true, false); }
  function viewArchiveDm(dm) { openDm(dm, true); }
  function buildArchiveList(container, items, kind) {
    container.replaceChildren();
    if (!items.length) { const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'Nothing archived.'; container.append(p); return; }
    const q = (state.archiveSearch || '').toLowerCase();
    const filtered = q ? items.filter(x => (x.code || x.name || x.key || '').toLowerCase().includes(q)) : items;
    if (!filtered.length) { const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'No matches.'; container.append(p); return; }
    for (const x of filtered) {
      const key = x.code || x.key; const label = x.code || x.name || x.key;
      const li = document.createElement('li'); li.className = 'archive-row';
      li.innerHTML = `<span class="archive-label">${esc(label)}</span><span class="archive-actions"><button data-kind="${esc(kind)}" data-action="view" data-key="${esc(key)}">View</button><button data-kind="${esc(kind)}" data-action="restore" data-key="${esc(key)}">Restore</button></span>`;
      li.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.action === 'view') b.dataset.kind === 'channel' ? viewArchiveChannel(b.dataset.key) : viewArchiveDm(x);
        else archive(b.dataset.kind, b.dataset.key, false);
      }));
      container.append(li);
    }
  }
  async function showArchives() {
    try {
      const [channels, dms] = await Promise.all([api.get('/api/channels?archived=1'), api.get('/api/dms?archived=1')]);
      const archivedChannels = channels.channels || []; const archivedDms = dms.your_dms || [];
      let panel = $('trio-archives'); if (!panel) { panel = document.createElement('dialog'); panel.id = 'trio-archives'; panel.className = 'archive-modal'; document.body.append(panel); }
      Trio.ui.configureDialog(panel);
      panel.innerHTML = '<form method="dialog"><button type="submit" formnovalidate class="modal-close" value="cancel">×</button><h2>Archives</h2><input class="archive-search" placeholder="Filter archived…" aria-label="Filter archived"><section><h3>Channels</h3><ul class="archive-channel-list"></ul></section><section><h3>Direct messages</h3><ul class="archive-dm-list"></ul></section></form>';
      const cList = panel.querySelector('.archive-channel-list'); const dList = panel.querySelector('.archive-dm-list');
      buildArchiveList(cList, archivedChannels, 'channel'); buildArchiveList(dList, archivedDms, 'dm');
      const input = panel.querySelector('.archive-search');
      input.addEventListener('input', () => { state.archiveSearch = input.value; buildArchiveList(cList, archivedChannels, 'channel'); buildArchiveList(dList, archivedDms, 'dm'); });
      panel.showModal();
    } catch (error) { toast(error.message || 'Could not load archives'); }
  }
  async function archiveCurrent() {
    const target = state.dmKey ? 'this DM' : (state.channel ? 'this channel' : '');
    if (!target) { Trio.ui.toast('No conversation to archive'); return; }
    Trio.ui.confirmAction(`Archive ${target}?`, () => {
      const nextArchived = !state.readOnly;
      if (state.dmKey) {
        const title = 'DM ' + state.dmName;
        archive('dm', state.dmKey, nextArchived).then(() =>
          loadConversation(state.channel, title, nextArchived ? 'Archived private conversation' : 'Private conversation', nextArchived, true));
      } else if (state.channel) {
        const title = 'trio#' + state.channel;
        archive('channel', state.channel, nextArchived).then(() =>
          loadConversation(state.channel, title, nextArchived ? 'Archived channel — read only' : 'Live agent workspace', nextArchived, false));
      }
    });
  }
  const menuIcon = {
    details: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M9 9h5M9 13h6M9 17h4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
    mute: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="m9 21h6"/>',
    archive: '<path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/>',
  };
  function menuSvg(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${menuIcon[name] || ''}</svg>`; }
  function closeChannelMenu() {
    const menu = $('channel-menu'); const button = $('channel-more-btn');
    if (!menu) return;
    menu.hidden = true; menu.classList.remove('open');
    button?.classList.remove('menu-active'); button?.setAttribute('aria-expanded', 'false');
  }
  function openChannelMenu() {
    const menu = $('channel-menu'); const button = $('channel-more-btn');
    if (!menu || !button) return;
    if (!menu.hidden) { closeChannelMenu(); return; }
    const isChannel = !!state.channel && !state.dmKey;
    const archived = !!state.readOnly;
    // LOTC/Frodo: this used to be a stub — clicking it just toasted "muted"
    // and did nothing, which cross-channel chimes turned from a cosmetic gap
    // into a real "the only escape hatch is fake" problem. The key here must
    // match what Trio.notifications.conversationKeyFor() resolves for a live
    // message in this same conversation (channel code, or 'dm:'+dmKey).
    const muteKey = state.dmKey ? 'dm:' + state.dmKey : state.channel;
    const muted = Trio.notifications?.isMuted?.(muteKey);
    const rows = [
      `<button type="button" role="menuitem" data-menu-action="details">${menuSvg('details')}<span>${isChannel ? 'Channel details' : 'Conversation details'}</span></button>`,
      `<button type="button" role="menuitem" data-menu-action="search">${menuSvg('search')}<span>${isChannel ? 'Search this channel' : 'Search this conversation'}</span></button>`,
      `<button type="button" role="menuitem" data-menu-action="mute">${menuSvg('mute')}<span>${muted ? 'Unmute notifications' : 'Mute notifications'}</span></button>`,
      '<div class="menu-sep" role="separator"></div>',
      isChannel
        ? `<button type="button" role="menuitem" class="danger" data-menu-action="archive">${menuSvg('archive')}<span>${archived ? 'Restore channel' : 'Archive channel'}</span></button>`
        : `<button type="button" role="menuitem" data-menu-action="archive">${menuSvg('archive')}<span>${archived ? 'Restore conversation' : 'Archive conversation'}</span></button>`,
    ];
    menu.innerHTML = rows.join(''); menu.hidden = false; menu.classList.add('open');
    button.classList.add('menu-active'); button.setAttribute('aria-expanded', 'true');
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth || 218;
    const top = Math.min(window.innerHeight - 12 - (menu.offsetHeight || 190), rect.bottom + 8);
    menu.style.left = Math.max(12, rect.right - width) + 'px'; menu.style.top = Math.max(12, top) + 'px';
    menu.querySelectorAll('[data-menu-action]').forEach(item => item.addEventListener('click', () => {
      const action = item.dataset.menuAction;
      if (action === 'details') showDetails();
      if (action === 'search') openSearch();
      if (action === 'mute') {
        closeChannelMenu();
        const nowMuted = Trio.notifications?.toggleMute?.(muteKey);
        toast(nowMuted ? 'Notifications muted for this conversation' : 'Notifications unmuted for this conversation');
      }
      if (action === 'archive') { closeChannelMenu(); archiveCurrent(); }
    }));
    menu.querySelector('button')?.focus();
  }
  let menuClick = null, menuKeydown = null, menuButtonClick = null;
  let drawerResizeStart = null, drawerResizeMove = null, drawerResizeEnd = null;
  let unroute = null;
  let wsl = null;
  function onWorkspaceUpdate() { if (['home','attention','messages','tasks'].includes(state.view)) showView(state.view); }
  function onRoute(route) {
    if (!route) return;
    if (route.name === 'channel') {
      const subtitle = route.params.archived ? 'Archived channel — read only' : 'Live agent workspace';
      if (state.channel !== route.params.code) loadConversation(route.params.code, '#' + route.params.code, subtitle, !!route.params.archived, false);
      else { state.view = 'conversation'; state.readOnly = !!route.params.archived; state.dmKey = ''; showConversationPage(); updateTopbar('#' + route.params.code, subtitle); renderFacePile(); renderRail(); }
    }
    else if ((route.name === 'dm' || route.name === 'audit') && state.dmKey !== route.params.key) openDmByKey(route.params.key, route.name === 'audit');
    else if (route.name === 'home') showView('home');
    else if (route.name === 'attention') showView('attention');
    else if (route.name === 'messages') showView('messages');
    else if (route.name === 'tasks') showView('tasks');
    else if (route.name === 'roster') showView('roster');
    else if (route.name === 'prefs') showView('prefs');
  }
  async function refresh() {
    if (state.workspaceLoading) return;
    state.workspaceLoading = true; state.workspaceError = '';
    renderRail();
    const query = state.channel ? '?channel=' + encodeURIComponent(state.channel) : '';
    const requests = [
      api.get('/api/channels').then(data => { state.channels = data.channels || []; Trio.store.set('workspace.channels', state.channels); renderRail(); }),
      api.get('/api/dms').then(data => { state.dms = data; Trio.store.set('workspace.dms', state.dms); renderRail(); }),
      api.get('/api/meta' + query).then(data => { state.meta = {...state.meta, ...data}; Trio.store.set('workspace.meta', state.meta); renderRail(); }),
      api.get('/api/tasks' + query).then(data => { state.tasks = data.tasks || []; Trio.store.set('workspace.tasks', state.tasks); }),
      api.get('/api/approvals').then(data => { state.approvals = data.approvals || []; Trio.store.set('workspace.approvals', state.approvals); }),
      api.get('/api/questions').then(data => { state.questions = data.questions || []; Trio.store.set('workspace.questions', state.questions); }),
      api.get('/api/mentions').then(data => { state.mentions = data.mentions || []; Trio.store.set('workspace.mentions', state.mentions); }),
      api.get('/api/usage').then(data => { state.usage = data; Trio.store.set('workspace.usage', state.usage); }),
    ];
    const results = await Promise.allSettled(requests);
    const failures = results.filter(result => result.status === 'rejected');
    failures.forEach(result => console.warn('workspace refresh failed', result.reason));
    if (failures.length === results.length) state.workspaceError = 'Workspace refresh failed';
    state.workspaceLoading = false;
    renderRail();
    Trio.events.dispatchEvent(new CustomEvent('workspace:updated', {detail: state}));
    if (['home','attention','messages','tasks'].includes(state.view)) showView(state.view);
  }
  let searchDialog = null, searchController = null, searchTimer = null, searchKeydown = null, detailsClick = null;
  function onSearchKey(event) { if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); openSearch(); } }
  function renderSearchResults(query, results = []) {
    const list = searchDialog.querySelector('.search-results');
    list.innerHTML = '';
    if (state.searchLoading) { list.innerHTML = '<p class="home-empty">Searching…</p>'; return; }
    if (!query) { list.innerHTML = '<p class="home-empty">Start typing to search.</p>'; return; }
    if (!results.length) { list.innerHTML = '<p class="home-empty">No results.</p>'; return; }
    const q = query.toLowerCase();
    for (const r of results) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'search-result';
      const ctx = r.dm ? 'DM · ' + r.dm : '#' + (r.channel || 'unknown');
      const author = r.member_name || r.member_id || 'unknown';
      const time = r.created_at ? new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const escaped = esc(r.content || '');
      const text = q && escaped.toLowerCase().includes(q.toLowerCase()) ? escaped.replace(new RegExp('(' + escRe(q) + ')', 'ig'), '<mark>$1</mark>') : escaped;
      b.innerHTML = `<span class="search-meta">${esc(ctx)} · ${esc(author)} · ${esc(time)}</span><span class="search-body">${text}</span>`;
      b.addEventListener('click', () => { searchDialog.close(); if (r.dm) openDmByKey(r.dm); else openChannel(r.channel); if (r.id != null) setTimeout(() => { const card = document.querySelector(`[data-message-id="${r.id}"]`); if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.focus(); } }, 200); });
      list.append(b);
    }
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  async function doSearch(q) {
    if (!q) { renderSearchResults(''); return; }
    state.searchLoading = true; renderSearchResults(q, []);
    if (searchController) { try { searchController.abort(); } catch {} }
    searchController = new AbortController();
    try {
      const resp = await fetch('/api/search?q=' + encodeURIComponent(q) + (state.channel ? '&channel=' + encodeURIComponent(state.channel) : ''), { signal: searchController.signal, headers: { Accept: 'application/json' } });
      if (!resp.ok) throw new Error('search failed');
      const data = await resp.json();
      renderSearchResults(q, data.results || []);
    } catch (e) { if (e.name !== 'AbortError') { console.warn('search failed', e); renderSearchResults(q, []); } }
    finally { state.searchLoading = false; }
  }
  function channelStatus(member) {
    // Agent roster objects carry {state, live, busy} from the supervisor —
    // the same source as the Agent roster page. Prefer those when present so
    // the details panel agrees with the roster instead of falling back to the
    // heartbeat-based channel roster status (which reads stale/dead for a
    // sleeping agent because no monitor is running to heartbeat).
    if (member?.live != null && member?.state != null) {
      const rawState = String(member.state).toLowerCase();
      // Compaction is its own state — surface it as "Compacting", not
      // "Sleeping", so the drawer/face-pile agree with the Agent roster card.
      if (rawState === 'compacting') return 'compacting';
      if (member.live) return member.busy ? 'working' : 'idle';
      if (rawState === 'error' || rawState === 'errored') return 'errored';
      if (rawState === 'sleeping') return rawState;
      return 'offline';
    }
    const raw = String(member?.status || (member?.busy ? 'working' : member?.live ? 'active' : 'offline')).toLowerCase();
    if (raw === 'error') return 'errored';
    if (raw === 'stale' || raw === 'dead') return 'offline';
    return ['working','blocked','errored','sleeping','active','idle','offline','compacting'].includes(raw) ? raw : 'offline';
  }
  function channelStatusLabel(status) { return status === 'errored' ? 'Errored' : status[0].toUpperCase() + status.slice(1); }
  function channelStatusChip(status) { return `<span class="channel-status-chip ${status}"><span class="dot"></span>${channelStatusLabel(status)}</span>`; }
  // Live "what are they doing" hint sourced from sessions.last_tool_name/
  // last_tool_target (nth_activity_hook) — only meaningful while `working`,
  // since a finished turn's last tool call is stale trivia otherwise.
  function toolSuffix(member, status) {
    if (status !== 'working' || !member?.last_tool_name) return '';
    const target = member.last_tool_target ? `: ${member.last_tool_target}` : '';
    const when = member.last_tool_at ? ` (${timeAgo(member.last_tool_at) || 'now'})` : '';
    return ` — using ${member.last_tool_name}${target}${when}`;
  }
  // A small numeric context-fullness hint, shown wherever a member's context
  // usage is known (nth_supervisor persists it from a Claude Code turn's
  // token usage). Absent for anyone that hasn't completed a turn yet —
  // humans, freshly-spawned agents, or non-Claude providers.
  // LOTC/Frodo: "43% ctx" alone reads as directionally ambiguous (used vs.
  // remaining, battery-meter mental model) — "% full" states the direction
  // in the face of the badge, not just the hover tooltip.
  function contextBadge(member) {
    if (member?.context_pct == null) return '';
    const pct = Math.round(Number(member.context_pct));
    return `<span class="context-badge ${usageTone(pct)}" title="${esc(String(pct))}% of context window used">${esc(String(pct))}% full</span>`;
  }
  function detailMember(member) {
    const name = member.name || member.id || 'Unknown member';
    const status = channelStatus(member);
    const statusText = member.status_text || member.statusText || (status === 'active' ? 'Active in this channel' : channelStatusLabel(status));
    const hint = toolSuffix(member, status).replace(/^ — /, '');
    const tool = hint ? `<div class="channel-member-tool">${esc(hint)}</div>` : '';
    return `<div class="channel-member">${avatarFor(member, status)}<div class="channel-member-copy"><div class="channel-member-name">${esc(name)}</div><div class="channel-member-status">${esc(statusText)}</div>${tool}</div>${contextBadge(member)}${channelStatusChip(status)}</div>`;
  }
  function detailTask(task) {
    const status = ['open','claimed','blocked','done'].includes(task.status) ? task.status : 'open';
    const title = task.title || task.description || task.message || 'Task';
    return `<div class="channel-task"><span class="tstate ${status}"><span class="d"></span>${esc(status)}</span><span class="channel-task-text">#${esc(task.id)} ${esc(title)}</span></div>`;
  }
  function closeDetails() {
    const drawer = $('channel-drawer');
    if (!drawer) return;
    drawer.classList.remove('open'); $('app')?.classList.remove('channel-details-open'); drawer.setAttribute('aria-hidden', 'true'); $('details-btn')?.classList.remove('menu-active');
  }
  function startDrawerResize(event) {
    if (event.button !== 0) return;
    const app = $('app'); const drawer = $('channel-drawer'); const handle = $('channel-drawer-resize');
    if (!app || !drawer || !handle) return;
    event.preventDefault();
    const startWidth = drawer.getBoundingClientRect().width;
    const startX = event.clientX;
    const minWidth = 320;
    const maxWidth = Math.min(560, Math.max(minWidth, window.innerWidth - 420));
    app.classList.add('is-resizing');
    drawerResizeStart = {startWidth, startX, minWidth, maxWidth};
    drawerResizeMove = move => {
      if (!drawerResizeStart) return;
      const width = Math.round(Math.max(drawerResizeStart.minWidth, Math.min(drawerResizeStart.maxWidth, drawerResizeStart.startWidth + drawerResizeStart.startX - move.clientX)));
      app.style.setProperty('--channel-drawer-width', width + 'px');
      handle.setAttribute('aria-valuenow', String(width));
    };
    drawerResizeEnd = () => {
      drawerResizeStart = null; app.classList.remove('is-resizing');
      document.removeEventListener('pointermove', drawerResizeMove); document.removeEventListener('pointerup', drawerResizeEnd);
    };
    document.addEventListener('pointermove', drawerResizeMove); document.addEventListener('pointerup', drawerResizeEnd, {once:true});
  }
  function showDetails() {
    const drawer = $('channel-drawer'); const body = $('channel-drawer-body');
    if (!drawer || !body) return;
    closeChannelMenu();
    const channel = (state.channels || []).find(c => c.code === state.channel);
    const archived = !!channel?.archived || !!state.readOnly;
    const dm = state.dmKey ? (state.dms?.your_dms || []).find(d => d.key === state.dmKey) : null;
    const title = dm ? (dm.name || state.dmKey) : '#' + (state.channel || 'Atrium');
    // For a DM, show only the conversation participants — not the whole channel
    // roster. Agent DMs all share AGENT_INBOX_CHANNEL, so the unfiltered roster
    // would list every agent ever created, each stamped "active" at spawn.
    // Agent participants use the supervisor-backed {state, live, busy} from
    // state.agents (same source as the Agent roster page) so the status chip
    // agrees with the roster instead of the heartbeat-based channel status.
    //
    // LOTC: this merge used to run ONLY on the DM path (dmIds.map(...)) — a
    // normal channel's member list (allMembers, the common case) fell straight
    // through to the raw heartbeat-based rows with no {state,live,busy}, so
    // channelStatus()'s "prefer the roster's fields" branch below never fired
    // for it and the drawer permanently disagreed with the Agent roster page.
    const allMembers = [...(state.members?.values?.() || [])];
    const agentsById = new Map((state.agents || []).map(a => [a.id, a]));
    // The operator's raw object (from /api/... identity endpoints) carries no
    // liveness field at all ({id,name,source,pending}), so channelStatus()'s
    // fallback branch always landed on its hardcoded 'offline' default — not
    // "usually" offline, ALWAYS, regardless of the operator actually viewing
    // this exact page right now. Rendering this drawer at all means the
    // operator's own client is live, so mark self-presence true.
    const rawOperator = state.operator || state.meta?.operator;
    const operator = rawOperator ? { ...rawOperator, live: true, state: rawOperator.state || 'running', busy: false } : rawOperator;
    const mergeRosterInfo = member => {
      const agent = agentsById.get(member.id);
      if (agent) return { ...member, ...agent };
      return operator?.id === member.id ? { ...member, ...operator } : member;
    };
    const resolveDmMember = id => {
      const agent = agentsById.get(id);
      const rosterM = allMembers.find(m => m.id === id);
      if (agent) return { ...rosterM, ...agent };
      return rosterM || (id === operator?.id ? operator : { id, name: id });
    };
    const dmIds = Array.isArray(state.dmMemberIds) ? state.dmMemberIds.slice() : [];
    if (operator?.id && !dmIds.includes(operator.id)) dmIds.push(operator.id);
    const members = dm && dmIds.length
      ? dmIds.map(resolveDmMember)
      : (() => {
          const merged = allMembers.map(mergeRosterInfo);
          if (operator?.id && !merged.some(m => m.id === operator.id)) merged.push(operator);
          return merged;
        })();
    const memberCount = dm ? dmIds.length : (members.length || Number(channel?.members) || 0);
    const tasks = selectors.taskItems().filter(task => !task.channel || task.channel === state.channel).filter(task => task.status !== 'done' && task.status !== 'cancelled');
    const connection = $('h-conn')?.querySelector('.conn-label')?.textContent || (archived ? 'Archived' : 'Live');
    $('channel-drawer-title').textContent = title;
    body.innerHTML = `<section class="channel-drawer-section"><h3>Topic</h3><div class="channel-drawer-topic">${esc(channel?.topic || (dm ? 'Private conversation' : 'No topic'))}</div></section><section class="channel-drawer-section"><h3>Members · ${memberCount}</h3>${members.length ? members.map(detailMember).join('') : '<div class="channel-drawer-empty">Waiting for the current roster…</div>'}</section><section class="channel-drawer-section"><h3>Tasks · ${tasks.length}</h3>${tasks.length ? tasks.slice(0, 4).map(detailTask).join('') : '<div class="channel-drawer-empty">No open tasks.</div>'}${tasks.length > 4 ? '<div class="channel-drawer-empty">+' + (tasks.length - 4) + ' more tasks</div>' : ''}<button type="button" class="btn ghost" id="open-channel-tasks">Open tasks view</button></section><section class="channel-drawer-section"><h3>Activity</h3><div class="kv"><span class="k">Messages loaded</span><span class="v" id="channel-drawer-msgcount" title="Capped at the most recent 500 — not literally every message in this conversation's history">${messageCountLabel()}</span></div>${dm ? `<div class="kv"><span class="k">Channel size</span><span class="v channel-drawer-empty-inline">not available for DMs</span></div>` : `<div class="kv"><span class="k">Channel size</span><span class="v" id="channel-drawer-size" title="Rough estimate of this channel's message-history size — a different measurement than an individual agent's own context-fullness badge above">…</span></div>`}<div class="kv"><span class="k">Connection</span><span class="v live">${esc(connection)}</span></div></section><section class="channel-drawer-section"><h3>${dm ? 'Conversation' : 'Channel'}</h3><div class="channel-drawer-actions"><button type="button" class="btn" id="edit-channel-objective">${dm ? 'Conversation settings' : 'Edit objective'}</button>${state.channel ? `<button type="button" class="btn danger" id="archive-channel-drawer">${dm ? (archived ? 'Restore conversation' : 'Archive conversation') : (archived ? 'Restore channel' : 'Archive channel')}</button>` : ''}</div></section>`;
    $('app')?.classList.add('channel-details-open'); drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); $('details-btn')?.classList.add('menu-active');
    $('channel-drawer-close')?.focus();
    $('open-channel-tasks')?.addEventListener('click', () => { closeDetails(); navigateView('tasks'); });
    $('edit-channel-objective')?.addEventListener('click', () => toast('Objective editing is coming soon'));
    $('archive-channel-drawer')?.addEventListener('click', () => { closeDetails(); archiveCurrent(); });
    refreshDrawerActivity();
  }
  // LOTC/Frodo: "Messages loaded" is exactly what state.messages.size is —
  // the currently in-memory set, capped at 11-conversation.js's
  // pruneMessages(500) — NOT literally "today" (no date filter exists) and
  // not the conversation's full history. A busy channel pins at 500 and
  // stops moving even as more arrive; showing "500+" instead of a frozen
  // "500" makes that cap visible instead of looking broken.
  const LOADED_MESSAGES_CAP = 500;
  function messageCountLabel() {
    const size = state.messages?.size || 0;
    return size >= LOADED_MESSAGES_CAP ? `${LOADED_MESSAGES_CAP}+` : String(size);
  }
  // 2-significant-figure K/M formatting (1.2K, 12K, 120K, 1.2M) — avoids
  // Number.toPrecision's exponential-notation quirk for 3-digit values
  // (e.g. (123).toPrecision(2) === "1.2e+2", not "120").
  function roundToSigFigs(value, figs) {
    if (!value) return 0;
    const magnitude = Math.pow(10, figs - Math.ceil(Math.log10(Math.abs(value))));
    return Math.round(value * magnitude) / magnitude;
  }
  const CHANNEL_SIZE_WARN_TOKENS = 850000;
  function formatTokenEstimate(tokens) {
    const n = Number(tokens) || 0;
    if (n >= 1e6) return roundToSigFigs(n / 1e6, 2) + 'M';
    if (n >= 1e3) return roundToSigFigs(n / 1e3, 2) + 'K';
    return String(Math.round(n));
  }
  const WARNING_TRIANGLE_SVG = '<svg class="size-warn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Approaching context limit"><path d="m10.29 3.86-8.18 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.89-3.14l-8.18-14a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  let drawerActivityFetchToken = 0;
  // Live-refresh both the message count (from already-in-memory state — no
  // request needed) and the channel-size estimate (a cheap aggregate) every
  // time this is called. Previously "Messages today" only reflected
  // whatever was true at the moment the drawer happened to open — a message
  // arriving while it stayed open just sat there stale until close+reopen.
  async function refreshDrawerActivity(messageChannel) {
    const drawer = $('channel-drawer');
    if (!drawer || !drawer.classList.contains('open')) return;
    const countEl = $('channel-drawer-msgcount');
    if (countEl) countEl.textContent = messageCountLabel();
    const sizeEl = $('channel-drawer-size');
    if (!sizeEl || !state.channel) return;
    // LOTC/Legolas: 'message' fires for the workspace-wide stream, not just
    // the open channel — a message anywhere used to refire this fetch for
    // whatever channel's drawer happened to be open. Skip the network
    // round-trip when we KNOW the event was for a different channel; a
    // missing/ambiguous channel field (or an explicit call with none, e.g.
    // the drawer's own open-time refresh) still fetches, since that's the
    // safe default.
    if (messageChannel != null && messageChannel !== state.channel) return;
    const fetchToken = ++drawerActivityFetchToken;
    try {
      const data = await api.get('/api/channel-size?channel=' + encodeURIComponent(state.channel));
      // The drawer may have closed, or moved to a different channel/DM,
      // while this request was in flight — a stale response landing after
      // must not overwrite what's now on screen.
      if (fetchToken !== drawerActivityFetchToken) return;
      const el = $('channel-drawer-size');
      if (!el) return;
      const tokens = data.estimated_tokens || 0;
      const warn = tokens > CHANNEL_SIZE_WARN_TOKENS;
      el.title = 'Rough estimate — message + sender text ÷ 4, plus per-message JSON overhead. Not an exact tokenizer count.';
      el.innerHTML = `${esc(formatTokenEstimate(tokens))} tokens (est.)${warn ? ` <span title="Approaching ${esc(formatTokenEstimate(CHANNEL_SIZE_WARN_TOKENS))} tokens — agents' context may compact soon">${WARNING_TRIANGLE_SVG}</span>` : ''}`;
      el.classList.toggle('size-warn', warn);
    } catch (e) {
      if (fetchToken !== drawerActivityFetchToken || !sizeEl) return;
      // LOTC/Frodo: collapsing every failure (403/404/500) to the same bare
      // "—" left a scoped/guest viewer unable to tell "forbidden" apart from
      // "broken" apart from "empty". At minimum distinguish the one case
      // that's a normal, expected outcome (not authorized for this channel)
      // from a genuine error.
      sizeEl.textContent = e?.status === 403 ? 'not visible to you' : 'unavailable';
      sizeEl.title = '';
    }
  }
  // Live workspace refresh on incoming messages. Without this, the rail unread
  // badges (/api/channels) and the Home cards (Attention inbox / Messages for
  // you / Tasks in flight, from /api/mentions|approvals|questions) only updated
  // on the 15s setInterval — so a message arriving in another channel didn't
  // bump its unread bubble or the Home counts until the next poll. The
  // workspace-wide SSE stream already delivers every channel's messages to the
  // operator, so re-poll (debounced, to collapse bursts / the prime flood) when
  // one lands. refresh() itself no-ops if a poll is already in flight; the 15s
  // interval remains a backstop.
  let liveRefreshDebounce = null;
  function onMessageLiveRefresh() {
    clearTimeout(liveRefreshDebounce);
    liveRefreshDebounce = setTimeout(() => { refresh(); }, 600);
  }
  let drawerActivityDebounce = null;
  function onMessageForDrawer(event) {
    clearTimeout(drawerActivityDebounce);
    const messageChannel = event?.detail?.channel;
    drawerActivityDebounce = setTimeout(() => refreshDrawerActivity(messageChannel), 400);
  }
  function openSearch() {
    if (!searchDialog) { searchDialog = document.createElement('dialog'); searchDialog.id = 'trio-search'; searchDialog.className = 'search-modal'; document.body.append(searchDialog); }
    Trio.ui.configureDialog(searchDialog);
    searchDialog.innerHTML = '<form method="dialog"><button type="submit" formnovalidate class="modal-close" value="cancel">×</button><input class="search-input" placeholder="Search messages…" aria-label="Search"><div class="search-results"></div></form>';
    searchDialog.showModal();
    const input = searchDialog.querySelector('.search-input');
    input.focus();
    input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(input.value.trim()), 200); });
  }
  let refreshInterval = null;
  function mount() { refresh(); renderFacePile(); if (!refreshInterval) refreshInterval = setInterval(refresh, 15000); unroute = Trio.router?.on?.(onRoute); wsl = onWorkspaceUpdate; Trio.events?.addEventListener?.('workspace:updated', wsl); Trio.events?.addEventListener?.('roster', renderFacePile); Trio.events?.addEventListener?.('message', onMessageForDrawer); Trio.events?.addEventListener?.('message', onMessageLiveRefresh); const searchBtn = $('search-btn'); if (searchBtn) { searchBtn.addEventListener('click', openSearch); } const detailsBtn = $('details-btn'); if (detailsBtn) { detailsClick = showDetails; detailsBtn.addEventListener('click', detailsClick); } const drawerClose = $('channel-drawer-close'); if (drawerClose) drawerClose.addEventListener('click', closeDetails); const drawerResize = $('channel-drawer-resize'); if (drawerResize) drawerResize.addEventListener('pointerdown', startDrawerResize); const menuButton = $('channel-more-btn'); if (menuButton) { menuButtonClick = openChannelMenu; menuButton.addEventListener('click', menuButtonClick); } menuClick = event => { if (!event.target.closest('#channel-menu, #channel-more-btn')) closeChannelMenu(); }; menuKeydown = event => { if (event.key === 'Escape') { closeChannelMenu(); closeDetails(); } }; document.addEventListener('click', menuClick); document.addEventListener('keydown', menuKeydown); searchKeydown = onSearchKey; document.addEventListener('keydown', searchKeydown); }
  function unmount() { closeChannelMenu(); closeDetails(); if (drawerResizeEnd) drawerResizeEnd(); if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; } if (unroute) { unroute(); unroute = null; } if (wsl) { Trio.events?.removeEventListener?.('workspace:updated', wsl); wsl = null; } Trio.events?.removeEventListener?.('roster', renderFacePile); Trio.events?.removeEventListener?.('message', onMessageForDrawer); Trio.events?.removeEventListener?.('message', onMessageLiveRefresh); clearTimeout(liveRefreshDebounce); clearTimeout(drawerActivityDebounce); const searchBtn = $('search-btn'); if (searchBtn && openSearch) searchBtn.removeEventListener('click', openSearch); const detailsBtn = $('details-btn'); if (detailsBtn && detailsClick) detailsBtn.removeEventListener('click', detailsClick); const drawerClose = $('channel-drawer-close'); if (drawerClose) drawerClose.removeEventListener('click', closeDetails); const drawerResize = $('channel-drawer-resize'); if (drawerResize) drawerResize.removeEventListener('pointerdown', startDrawerResize); const menuButton = $('channel-more-btn'); if (menuButton && menuButtonClick) menuButton.removeEventListener('click', menuButtonClick); if (menuClick) document.removeEventListener('click', menuClick); if (menuKeydown) document.removeEventListener('keydown', menuKeydown); if (searchKeydown) document.removeEventListener('keydown', searchKeydown); }
  Trio.workspace = {init: mount, mount, unmount, render: renderRail, renderFacePile, refresh, archive, archiveCurrent, openChannel, openDm, openDmByKey, openDmDialog, dmTargets, groupNavigation, attentionCount, selectors, showView, search: openSearch, modal, toast, showDetails, channelStatus, toolSuffix, usageTone, resetLabel, contextBadge, formatTokenEstimate, refreshDrawerActivity, messageCountLabel};
})();
