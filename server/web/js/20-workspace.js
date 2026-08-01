(() => {
  'use strict';
  const Trio = window.Trio;
  const state = Trio.state;
  const api = Trio.api;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
    pendingApprovals(src = state) { return (src.approvals || []).filter(a => a.status !== 'resolved' && a.status !== 'accepted').length; },
    openTasks(src = state) { return (src.tasks || []).filter(t => t.status === 'open' || t.status === 'blocked').length; },
    blockedAgents(src = state) { return (src.agents || []).filter(a => a.status === 'blocked' || a.status === 'error' || a.status === 'errored').length; },
    activeAgents(src = state) { return (src.agents || []).filter(a => ['working','active','idle'].includes(a.status)).length; },
    unreadDms(src = state) { return (src.dms?.your_dms || []).reduce((s, d) => s + (Number(d.unread) || 0), 0); },
    recentChannels(src = state) { return (src.channels || []).filter(c => !c.archived).slice(0, 5); },
    taskItems(src = state) {
      return (src.tasks || []).map(t => ({
        id: t.id || t.task_id,
        status: t.status || 'open',
        title: t.message || t.title || 'Task',
        owner: t.claimed_by || '',
        blockers: Array.isArray(t.blocked_by) ? t.blocked_by : [],
        channel: t.channel,
        updatedAt: t.updated_at,
      }));
    },
    attention(src = state) { return selectors.pendingApprovals(src) + selectors.openTasks(src) + selectors.blockedAgents(src); },
    attentionItems(src = state) {
      const items = [];
      for (const a of src.approvals || []) {
        if (a.status === 'resolved' || a.status === 'accepted') continue;
        items.push({ id: a.id, kind: 'approval', severity: 'high', title: a.title || a.agent_name || 'Approval requested', source: a.agent_name || a.member_id, timestamp: a.created_at, status: a.status, body: a.reason || a.command || '', actions: ['accept','acceptForSession','decline', ...(a.can_cancel ? ['cancel'] : [])] });
      }
      for (const t of src.tasks || []) {
        if (t.status !== 'blocked') continue;
        items.push({ id: 'task-' + t.id, kind: 'task', severity: 'medium', title: t.message || t.title || 'Blocked task', source: t.claimed_by || 'unknown', timestamp: t.updated_at, status: t.status, body: 'Blocked by ' + (t.blocked_by || []).join(', '), actions: [] });
      }
      for (const a of src.agents || []) {
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
  function loadConversation(channel, title, subtitle, readOnly = false, isDm = false) {
    if (Trio.store) Trio.store.set('session.channel', channel);
    state.view = 'conversation';
    state.readOnly = !!readOnly;
    state.dmKey = isDm ? (state.dmKey || '') : '';
    state.dmLoading = false;
    state.dmError = '';
    if (!isDm) state.dmThread = null;
    state.channel = channel;
    document.getElementById('h-channel').textContent = title;
    document.getElementById('h-meta').textContent = subtitle;
    const banner = document.getElementById('private-banner');
    if (banner) { banner.classList.toggle('hidden', !isDm); banner.textContent = isDm ? (readOnly ? 'Archived private conversation — read only' : 'Private conversation') : ''; }
    state.messages = new Map(); state.messageDomById = new Map(); state.answers = new Map();
    Trio.conversation?.render?.();
    Trio.startEvents?.(state.channel);
  }
  function openDm(dm, readOnly = false) {
    state.dmMemberIds = (dm.member_ids || []).slice();
    state.dmTargetId = state.dmMemberIds[0] || '';
    state.dmName = dm.name || dm.key;
    state.dmKey = dm.key;
    state.dmThread = dm;
    loadConversation(dm.channel || state.channel, 'DM ' + state.dmName, readOnly ? 'Archived private conversation' : 'Private conversation', readOnly, true);
    if (Trio.router?.navigate) Trio.router.navigate('dm', { key: dm.key, archived: readOnly });
    Trio.loader?.cancel?.('dm:' + dm.key);
    state.dmLoading = true; state.dmError = ''; Trio.conversation?.render?.();
    const loader = Trio.loader?.load ? Trio.loader : { load: (name, fn) => { const c = { abort() {} }; return fn(c); } };
    loader.load('dm:' + dm.key, signal => api.get('/api/dms?with=' + encodeURIComponent(dm.key) + (readOnly ? '&archived=1' : ''), false, { signal })).then(data => {
      state.dmLoading = false; state.dmError = '';
      if (data && Array.isArray(data.messages)) { data.messages.forEach(Trio.conversation.upsert); }
      if (data && data.ok === false) { state.dmError = data.error || 'Could not load DM'; }
      Trio.conversation?.render?.();
    }).catch(error => {
      if (error?.name === 'AbortError' || (typeof error === 'string' && error.includes('aborted'))) return;
      state.dmLoading = false; state.dmError = error.message || 'Could not load DM'; Trio.conversation?.render?.();
    });
  }
  function openDmByKey(key) {
    if (!key) return;
    api.get('/api/dms?with=' + encodeURIComponent(key)).then(data => {
      const dm = (data.your_dms || []).find(d => d.key === key) || (data.agent_dms || []).find(d => d.key === key);
      if (dm) return openDm(dm, false);
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
      const list = state.approvals || [];
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
  function railItem(label, subtitle, onClick, badge = '', active = false) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'rail-item';
    button.classList.toggle('active', active);
    button.innerHTML = `<span class="rail-copy"><strong>${esc(label)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</span>${badge ? `<b class="rail-badge">${esc(badge)}</b>` : ''}`;
    button.addEventListener('click', onClick); return button;
  }
  function section(title, items) {
    const wrap = document.createElement('section'); wrap.className = 'rail-section';
    wrap.innerHTML = `<h2>${esc(title)}</h2>`; items.forEach(item => wrap.append(item)); return wrap;
  }
  function renderRail() {
    const rail = $('workspace-rail'); if (!rail) return;
    const nav = groupNavigation(state.channels || [], state.dms || {});
    rail.textContent = '';
    const controls = document.createElement('div'); controls.className = 'rail-views';
    [['Home', 'home'], ['Attention', 'attention'], ['Tasks', 'tasks']].forEach(([label, view]) =>
      controls.append(railItem(label, '', () => showView(view), view === 'attention' ? String(selectors.attention() || '') : '', state.view === view)));
    rail.append(controls, section('Channels', nav.active.map(c => railItem(c.code, c.topic || c.status, () => openChannel(c.code), c.unread || '', state.view === 'conversation' && !state.dmKey && state.channel === c.code))));
    if (nav.yours.length) rail.append(section('Direct messages', nav.yours.map(d => railItem(d.name || d.key, d.preview || 'Private', () => openDm(d), d.unread ? String(d.unread) : '', state.view === 'conversation' && state.dmKey === d.key))));
    if (nav.agentAudit.length) rail.append(section('Agent activity', nav.agentAudit.map(d => railItem(d.name || d.key, d.preview || 'Agent-to-agent', () => openDm(d, true), '', state.view === 'conversation' && state.dmKey === d.key))));
    const actions = document.createElement('div'); actions.className = 'rail-actions';
    actions.append(railItem('+ New channel', '', createChannel), railItem('Archive browser', '', showArchives), railItem('Agent roster', '', () => { const panel = document.getElementById('trio-agents'); if (panel) panel.hidden = false; Trio.agents?.refresh?.(); }), railItem('Preferences', '', () => Trio.preferences?.panel?.())); rail.append(actions);
  }
  function updateTopbar(title, subtitle) {
    const h = $('h-channel'); const m = $('h-meta');
    if (h) h.textContent = title || 'Atrium';
    if (m) m.textContent = subtitle || '';
  }
  function renderHome(panel) {
    panel.replaceChildren();
    if (state.workspaceLoading) { const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = 'Loading workspace…'; panel.append(p); return; }
    if (state.workspaceError) { const p = document.createElement('p'); p.className = 'home-empty'; p.textContent = state.workspaceError; const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Retry'; b.addEventListener('click', refresh); p.append(b); panel.append(p); return; }
    const grid = document.createElement('div'); grid.className = 'home-grid';
    const cards = [
      { title: 'Attention', count: selectors.attention(), subtitle: 'Need action', action: () => showView('attention') },
      { title: 'Open tasks', count: selectors.openTasks(), subtitle: 'In flight', action: () => showView('tasks') },
      { title: 'Unread DMs', count: selectors.unreadDms(), subtitle: 'Private messages', action: () => showView('home') },
      { title: 'Active agents', count: selectors.activeAgents(), subtitle: 'Working now', action: () => { const panel = $('trio-agents'); if (panel) panel.hidden = false; Trio.agents?.refresh?.(); } },
    ];
    for (const { title, count, subtitle, action } of cards) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'home-card';
      card.innerHTML = `<strong>${esc(title)}</strong><span class="home-count">${esc(String(count))}</span><small>${esc(subtitle)}</small>`;
      card.addEventListener('click', action); grid.append(card);
    }
    const recent = document.createElement('div'); recent.className = 'home-recent';
    const head = document.createElement('h2'); head.textContent = 'Recent channels'; recent.append(head);
    const chans = selectors.recentChannels();
    if (!chans.length) { const p = document.createElement('p'); p.textContent = 'No active channels.'; p.className = 'home-empty'; recent.append(p); }
    for (const c of chans) { const b = document.createElement('button'); b.type = 'button'; b.className = 'home-channel'; b.textContent = c.code; b.addEventListener('click', () => openChannel(c.code)); recent.append(b); }
    panel.append(grid, recent);
  }
  function renderAttention(panel) {
    panel.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'Attention'; panel.append(heading);
    const items = selectors.attentionItems();
    if (!items.length) { const p = document.createElement('p'); p.textContent = 'Nothing needs attention.'; p.className = 'home-empty'; panel.append(p); return; }
    const list = document.createElement('section'); list.className = 'attention-list';
    for (const item of items) {
      const article = document.createElement('article'); article.className = 'attention-item severity-' + item.severity;
      const title = document.createElement('b'); title.textContent = item.title;
      const meta = document.createElement('small'); meta.textContent = [item.kind, item.source, timeAgo(item.timestamp)].filter(Boolean).join(' · ');
      const body = document.createElement('p'); body.textContent = item.body;
      article.append(title, meta, body);
      if (item.actions.length) {
        const row = document.createElement('div'); row.className = 'attention-actions';
        for (const d of item.actions) {
          const b = document.createElement('button'); b.type = 'button'; b.textContent = d === 'acceptForSession' ? 'Allow this session' : d;
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
    panel.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'Tasks'; panel.append(heading);
    const filters = ['open', 'claimed', 'blocked', 'done', 'all'];
    const filter = filters.includes(state.taskFilter) ? state.taskFilter : 'open';
    const filterBar = document.createElement('div'); filterBar.className = 'task-filters';
    for (const f of filters) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = f;
      b.className = f === filter ? 'active' : '';
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
      row.innerHTML = `<b>#${esc(t.id)}</b><span>${esc(t.title)}</span><small>${esc(t.status)}</small>`;
      if (t.owner) { const owner = document.createElement('small'); owner.textContent = 'claimed by ' + t.owner; row.append(owner); }
      if (t.blockers.length) { const b = document.createElement('small'); b.textContent = 'blocked: ' + t.blockers.join(', '); b.style.color = 'var(--warm)'; row.append(b); }
      list.append(row);
    }
    panel.append(list);
    const count = document.createElement('p'); count.className = 'task-count'; count.textContent = `open ${counts.open} · claimed ${counts.claimed} · blocked ${counts.blocked} · done ${counts.done}`;
    panel.append(count);
  }
  function showView(view) {
    state.view = view;
    updateTopbar(view === 'home' ? 'Atrium' : view[0].toUpperCase() + view.slice(1), view === 'home' ? 'Home' : `trio view · ${view}`);
    document.querySelectorAll('[data-trio-view]').forEach(n => n.hidden = true);
    let panel = $(`trio-${view}-view`);
    if (!panel) { panel = document.createElement('section'); panel.id = `trio-${view}-view`; panel.dataset.trioView = view; panel.className = 'workspace-view'; document.querySelector('.conversation-shell')?.prepend(panel); }
    panel.hidden = false;
    if (view === 'home') { renderHome(panel); }
    else if (view === 'tasks') { renderTasks(panel); }
    else if (view === 'attention') { renderAttention(panel); }
    else panel.innerHTML = `<h2>Home</h2><p>${(state.channels || []).length} active channels · ${(state.dms?.your_dms || []).length} direct conversations</p>`;
  }
  async function createChannel() {
    modal('Create channel', '<label>Channel code<input name="code" required pattern="[a-z0-9][a-z0-9-]*"></label><label>Topic<input name="topic"></label>', async node => { const f=new FormData(node.querySelector('form')); try { await api.post('/api/channels', {code:f.get('code'),topic:f.get('topic')}); openChannel(f.get('code')); } catch (error) { toast(error.message || 'Could not create channel'); } });
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
      panel.innerHTML = '<form method="dialog"><button class="modal-close" value="cancel">×</button><h2>Archives</h2><input class="archive-search" placeholder="Filter archived…" aria-label="Filter archived"><section><h3>Channels</h3><ul class="archive-channel-list"></ul></section><section><h3>Direct messages</h3><ul class="archive-dm-list"></ul></section></form>';
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
      if (state.dmKey) { archive('dm', state.dmKey, !state.readOnly).then(() => state.readOnly = !state.readOnly); }
      else if (state.channel) { archive('channel', state.channel, !state.readOnly).then(() => state.readOnly = !state.readOnly); }
    });
  }
  let unroute = null;
  let wsl = null;
  function onWorkspaceUpdate() { if (['home','attention','tasks'].includes(state.view)) showView(state.view); }
  function onRoute(route) {
    if (!route) return;
    if (route.name === 'channel' && state.channel !== route.params.code) loadConversation(route.params.code, 'trio#' + route.params.code, route.params.archived ? 'Archived channel — read only' : 'Live agent workspace', !!route.params.archived, false);
    else if ((route.name === 'dm' || route.name === 'audit') && state.dmKey !== route.params.key) openDmByKey(route.params.key);
    else if (route.name === 'home') showView('home');
  }
  async function refresh() {
    if (state.workspaceLoading) return;
    state.workspaceLoading = true; state.workspaceError = '';
    try {
      const query = state.channel ? '?channel=' + encodeURIComponent(state.channel) : '';
      const [channels, dms, meta, tasks, approvals] = await Promise.all([api.get('/api/channels'), api.get('/api/dms'), api.get('/api/meta' + query), api.get('/api/tasks' + query).catch(() => ({tasks:[]})), api.get('/api/approvals').catch(() => ({approvals:[]}))]);
      state.channels = channels.channels || []; state.dms = dms; state.meta = {...state.meta, ...meta}; state.tasks=tasks.tasks||[]; state.approvals=approvals.approvals||[];
      Trio.store.set('workspace.channels', state.channels);
      Trio.store.set('workspace.dms', state.dms);
      Trio.store.set('workspace.meta', state.meta);
      Trio.store.set('workspace.tasks', state.tasks);
      Trio.store.set('workspace.approvals', state.approvals);
      renderRail();
      Trio.events.dispatchEvent(new CustomEvent('workspace:updated', {detail: state}));
    } catch (error) { state.workspaceError = error.message || 'Workspace refresh failed'; console.warn('workspace refresh failed', error); }
    finally { state.workspaceLoading = false; if (['home','attention','tasks'].includes(state.view)) showView(state.view); }
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
    searchDialog.innerHTML = '<form method="dialog"><button class="modal-close" value="cancel">×</button><input class="search-input" placeholder="Search messages…" aria-label="Search"><div class="search-results"></div></form>';
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
