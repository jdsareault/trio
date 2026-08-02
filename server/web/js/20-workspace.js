(() => {
  'use strict';
  const Trio = window.Trio;
  const state = Trio.state;
  const api = Trio.api;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const listOf = value => Array.isArray(value) ? value : [];
  const pendingDecisions = new Set();
  const $ = id => document.getElementById(id);

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
    blockedAgents(src = state) { return listOf(src.agents).filter(a => a.status === 'blocked' || a.status === 'error' || a.status === 'errored').length; },
    activeAgents(src = state) { return listOf(src.agents).filter(a => ['working','active','idle'].includes(a.status)).length; },
    unreadDms(src = state) { return (src.dms?.your_dms || []).reduce((s, d) => s + (Number(d.unread) || 0), 0); },
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
    attention(src = state) { return selectors.pendingApprovals(src) + selectors.openTasks(src) + selectors.blockedAgents(src); },
    attentionItems(src = state) {
      const items = [];
      for (const a of listOf(src.approvals)) {
        if (a.status === 'resolved' || a.status === 'accepted') continue;
        items.push({ id: a.id, kind: 'approval', severity: 'high', title: a.title || a.agent_name || 'Approval requested', source: a.agent_name || a.member_id, timestamp: a.created_at, status: a.status, body: a.reason || a.command || '', actions: ['accept','acceptForSession','decline', ...(a.can_cancel ? ['cancel'] : [])] });
      }
      for (const t of listOf(src.tasks)) {
        if (t.status !== 'blocked') continue;
        items.push({ id: 'task-' + t.id, kind: 'task', severity: 'medium', title: t.description || t.message || t.title || 'Blocked task', source: t.claimed_by || 'unknown', timestamp: t.updated_at, status: t.status, body: 'Blocked by ' + (t.blocked_by || []).join(', '), actions: [] });
      }
      for (const a of listOf(src.agents)) {
        if (a.status !== 'blocked' && a.status !== 'error' && a.status !== 'errored') continue;
        items.push({ id: 'agent-' + a.id, kind: 'agent', severity: 'high', title: (a.name || a.id) + ' needs help', source: a.id, timestamp: a.last_active, status: a.status, body: a.status_text || a.error || '', actions: [] });
      }
      return items.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    },
  };
  function attentionCount(meta = state.meta || {}) { return selectors.pendingApprovals({ approvals: meta.approvals }) + selectors.openTasks({ tasks: meta.tasks }); }
  function openChannel(code, extra = '') {
    const readOnly = extra === 'archived';
    if (Trio.router?.navigate) Trio.router.navigate('channel', { code, archived: readOnly });
    loadConversation(code, 'trio#' + code, readOnly ? 'Archived channel — read only' : 'Live agent workspace', readOnly, false);
  }
  function loadConversation(channel, title, subtitle, readOnly = false, isDm = false, isAudit = false) {
    if (Trio.store) Trio.store.set('session.channel', channel);
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
    const loader = Trio.loader?.load ? Trio.loader : { load: (name, fn) => { const c = { abort() {} }; return fn(c); } };
    loader.load('dm:' + dm.key, signal => api.get('/api/dms?with=' + encodeURIComponent(dm.key) + (readOnly && !auditReadOnly ? '&archived=1' : ''), false, { signal })).then(data => {
      state.dmLoading = false; state.dmError = '';
      if (data && Array.isArray(data.messages)) { data.messages.forEach(Trio.conversation.upsert); }
      if (data && data.ok === false) { state.dmError = data.error || 'Could not load DM'; }
      Trio.conversation?.render?.();
    }).catch(error => {
      if (error?.name === 'AbortError' || (typeof error === 'string' && error.includes('aborted'))) return;
      state.dmLoading = false; state.dmError = error.message || 'Could not load DM'; Trio.conversation?.render?.();
    });
  }
  function openDmByKey(key, audit = false) {
    if (!key) return;
    api.get('/api/dms?with=' + encodeURIComponent(key)).then(data => {
      const auditThread = (data.agent_dms || []).find(d => d.key === key);
      if (audit && auditThread) return openDm(auditThread, false, true);
      const yours = (data.your_dms || []).find(d => d.key === key);
      if (yours) return openDm(yours, false, false);
      if (auditThread) return openDm(auditThread, false, true);
      return api.get('/api/dms?archived=1&with=' + encodeURIComponent(key));
    }).then(data => {
      if (data) { const dm = (data.your_dms || []).find(d => d.key === key); if (dm) openDm(dm, true); }
    }).catch(error => Trio.ui.toast(error.message || 'Could not load DM'));
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
      plus: '<path d="M12 5v14M5 12h14"/>',
      roster: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a5 5 0 0 0-4-4.9"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 17 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
  }
  function initials(label) { return String(label || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(); }
  function avatar(label, tone = 'eucalyptus', status = '') { return `<span class="av av-28 tone-${tone} ${status ? 'st-' + status : ''}">${esc(initials(label))}${status ? '<span class="st-ring"></span>' : ''}</span>`; }
  function avatarTone(label) { const tones = ['coral', 'indigo', 'eucalyptus', 'amber', 'plum']; return tones[[...String(label || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0) % tones.length]; }
  function navItem(label, icon, onClick, badge = '', active = false) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'nav-item'; button.classList.toggle('active', active);
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
    const visual = audit && people.length > 1 ? `<span class="dm-pair">${avatar(people[0], avatarTone(people[0]))}${avatar(people[1], avatarTone(people[1]))}</span>` : avatar(people[0] || label, avatarTone(label), dm.unread ? 'online' : 'idle');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'dm-item'; button.classList.toggle('active', state.view === 'conversation' && state.dmKey === dm.key);
    button.innerHTML = `${visual}<span class="dm-copy"><span class="dm-name">${esc(label)}</span></span>${dm.unread ? '<span class="unread-dot" aria-label="Unread"></span>' : ''}`;
    button.addEventListener('click', () => openDm(dm, false, audit)); return button;
  }
  function renderRail() {
    const rail = $('workspace-rail'); if (!rail) return;
    const nav = groupNavigation(state.channels || [], state.dms || {});
    rail.textContent = '';
    const workspaceItems = [
      navItem('Home', 'home', () => showView('home'), '', state.view === 'home'),
      navItem('Attention', 'attention', () => showView('attention'), String(selectors.attention() || ''), state.view === 'attention'),
      itemWithAdd(navItem('Agent roster', 'roster', () => showView('roster'), '', state.view === 'roster'), () => Trio.agents?.create?.(), 'Create agent'),
      navItem('Tasks', 'tasks', () => showView('tasks'), '', state.view === 'tasks'),
      navItem('Preferences', 'settings', () => showView('prefs'), '', state.view === 'prefs'),
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
      { title: 'Attention inbox', count: selectors.attention(), subtitle: 'Need a decision', tone: 'warn', detail: `${selectors.pendingApprovals()} approvals · ${selectors.blockedAgents()} agent issues`, action: () => showView('attention') },
      { title: 'Messages for you', count: selectors.unreadDms(), subtitle: 'Unread & mentions', tone: 'accent', detail: 'Private messages and direct pings', action: () => { const d = (state.dms?.your_dms || []).find(x => x.unread); if (d) openDm(d); } },
      { title: 'Tasks in flight', count: selectors.openTasks(), subtitle: 'Across every channel', tone: 'ok', detail: `${listOf(state.tasks).filter(t => t.status === 'claimed').length} claimed · ${listOf(state.tasks).filter(t => t.status === 'blocked').length} blocked`, action: () => showView('tasks') },
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
    const health = document.createElement('section'); health.className = 'home-section'; health.innerHTML = '<div class="sec-head"><h3>Runtime health</h3><span class="sh-line"></span></div>';
    const healthRow = document.createElement('div'); healthRow.className = 'health-row';
    const agentList = Array.isArray(Trio.store?.get('agents.list')) ? Trio.store.get('agents.list') : Array.isArray(state.agents) ? state.agents : [];
    [['Hub', 'ok', 'Live'], ['Agents', 'ok', String(agentList.length) + ' connected'], ['Database', 'ok', 'Ready']].forEach(([name, tone, value]) => { const chip = document.createElement('span'); chip.className = 'hchip'; chip.innerHTML = `<span class="d ${tone}"></span>${esc(name)} · ${esc(value)}`; healthRow.append(chip); });
    health.append(healthRow);
    panel.append(viewHeader('Home', 'Your workspace at a glance'), intro, grid, working, recent, health);
  }
  function renderAttention(panel) {
    panel.replaceChildren(); panel.append(viewHeader('Attention', 'Everything waiting for you, in one calm place'));
    const tabs = document.createElement('div'); tabs.className = 'att-tabs';
    [['all','All'],['approval','Approvals'],['task','Tasks'],['agent','Agents']].forEach(([key,label]) => { const b = document.createElement('button'); b.type = 'button'; b.className = (state.attentionFilter || 'all') === key ? 'on' : ''; b.textContent = label; b.addEventListener('click', () => { state.attentionFilter = key; showView('attention'); }); tabs.append(b); });
    panel.append(tabs);
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
  function showView(view) {
    state.view = view;
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
    else if (view === 'roster') { Trio.agents?.renderPage?.(panel); }
    else if (view === 'prefs') { Trio.preferences?.renderPage?.(panel); }
    else panel.innerHTML = `<h2>Home</h2><p>${(state.channels || []).length} active channels · ${(state.dms?.your_dms || []).length} direct conversations</p>`;
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
  let unroute = null;
  let wsl = null;
  function onWorkspaceUpdate() { if (['home','attention','tasks'].includes(state.view)) showView(state.view); }
  function onRoute(route) {
    if (!route) return;
    if (route.name === 'channel') {
      const subtitle = route.params.archived ? 'Archived channel — read only' : 'Live agent workspace';
      if (state.channel !== route.params.code) loadConversation(route.params.code, 'trio#' + route.params.code, subtitle, !!route.params.archived, false);
      else { state.view = 'conversation'; state.readOnly = !!route.params.archived; state.dmKey = ''; showConversationPage(); updateTopbar('trio#' + route.params.code, subtitle); renderRail(); }
    }
    else if ((route.name === 'dm' || route.name === 'audit') && state.dmKey !== route.params.key) openDmByKey(route.params.key, route.name === 'audit');
    else if (route.name === 'home') showView('home');
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
    ];
    const results = await Promise.allSettled(requests);
    const failures = results.filter(result => result.status === 'rejected');
    failures.forEach(result => console.warn('workspace refresh failed', result.reason));
    if (failures.length === results.length) state.workspaceError = 'Workspace refresh failed';
    state.workspaceLoading = false;
    renderRail();
    Trio.events.dispatchEvent(new CustomEvent('workspace:updated', {detail: state}));
    if (['home','attention','tasks'].includes(state.view)) showView(state.view);
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
  function showDetails() {
    const channel = (state.channels || []).find(c => c.code === state.channel);
    const topic = channel?.topic || 'No topic';
    const archived = !!channel?.archived || !!state.readOnly;
    const members = [...(state.members?.values() || [])].map(m => m.name || m.id);
    const dm = state.dmKey ? (state.dms?.your_dms || []).find(d => d.key === state.dmKey) : null;
    const title = dm ? (dm.name || state.dmKey) : (state.channel || 'Atrium');
    const body = `<h3>${esc(title)}</h3><p class="detail-row"><b>Topic</b><span>${esc(topic)}</span></p><p class="detail-row"><b>Status</b><span>${esc(archived ? 'Archived' : 'Active')}</span></p><p class="detail-row"><b>Members</b><span>${esc(members.join(', ') || 'Unknown')}</span></p><p class="detail-row"><b>Open tasks</b><span>${selectors.openTasks()}</span></p>`;
    Trio.ui.modal('Conversation details', body + '<div class="agent-actions"><button id="details-archive" type="button">' + (archived ? 'Restore' : 'Archive') + '</button></div>', () => {});
    setTimeout(() => {
      const btn = document.getElementById('details-archive');
      if (btn) btn.addEventListener('click', () => { const target = state.dmKey ? 'dm' : 'channel'; archive(target, state.dmKey || state.channel, !archived); document.getElementById('trio-control-modal')?.close?.(); });
    }, 0);
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
  function mount() { refresh(); if (!refreshInterval) refreshInterval = setInterval(refresh, 15000); unroute = Trio.router?.on?.(onRoute); wsl = onWorkspaceUpdate; Trio.events?.addEventListener?.('workspace:updated', wsl); const searchBtn = $('search-btn'); if (searchBtn) { searchBtn.addEventListener('click', openSearch); } const detailsBtn = $('details-btn'); if (detailsBtn) { detailsClick = showDetails; detailsBtn.addEventListener('click', detailsClick); } searchKeydown = onSearchKey; document.addEventListener('keydown', searchKeydown); }
  function unmount() { if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; } if (unroute) { unroute(); unroute = null; } if (wsl) { Trio.events?.removeEventListener?.('workspace:updated', wsl); wsl = null; } const searchBtn = $('search-btn'); if (searchBtn && openSearch) searchBtn.removeEventListener('click', openSearch); const detailsBtn = $('details-btn'); if (detailsBtn && detailsClick) detailsBtn.removeEventListener('click', detailsClick); if (searchKeydown) document.removeEventListener('keydown', searchKeydown); }
  Trio.workspace = {init: mount, mount, unmount, render: renderRail, refresh, archive, archiveCurrent, openDm, openDmByKey, groupNavigation, attentionCount, selectors, showView, search: openSearch, modal, toast};
})();
