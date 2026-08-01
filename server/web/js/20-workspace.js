(() => {
  'use strict';
  const Trio = window.Trio;
  const state = Trio.state;
  const api = Trio.api;
  let dmPoll = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const $ = id => document.getElementById(id);

  function groupNavigation(channels = [], dms = {}) {
    return {
      active: channels.filter(c => !c.archived),
      archived: channels.filter(c => c.archived),
      yours: dms.your_dms || [],
      agentAudit: dms.agent_dms || [],
    };
  }
  function attentionCount(meta = state.meta || {}) {
    return (meta.approvals || []).filter(a => a.status !== 'resolved').length +
      (meta.tasks || []).filter(t => t.status === 'open' || t.status === 'blocked').length;
  }
  function openChannel(code, extra = '') {
    const query = new URLSearchParams({channel: code});
    if (extra) query.set(extra, '1');
    location.assign('/?' + query);
  }
  function loadConversation(channel, title, subtitle, readOnly = false, isDm = false) {
    if (dmPoll) { clearInterval(dmPoll); dmPoll = null; }
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
    Trio.startEvents?.();
  }
  function openDm(dm, readOnly = false) {
    state.dmMemberIds = (dm.member_ids || []).slice();
    state.dmTargetId = state.dmMemberIds[0] || '';
    state.dmName = dm.name || dm.key;
    state.dmKey = dm.key;
    state.dmThread = dm;
    loadConversation(dm.channel || state.channel, 'DM ' + state.dmName, readOnly ? 'Archived private conversation' : 'Private conversation', readOnly, true);
    if (dmPoll) { clearInterval(dmPoll); dmPoll = null; }
    // Temporary polling for DM freshness; remove once a workspace/DM EventSource lands (task 1.7).
    if (!readOnly) dmPoll = setInterval(() => refreshDm(dm.key), 5000);
    state.dmLoading = true; state.dmError = ''; Trio.conversation?.render?.();
    api.get('/api/dms?with=' + encodeURIComponent(dm.key) + (readOnly ? '&archived=1' : '')).then(data => {
      state.dmLoading = false; state.dmError = '';
      if (data && Array.isArray(data.messages)) { data.messages.forEach(Trio.conversation.upsert); }
      if (data && data.ok === false) { state.dmError = data.error || 'Could not load DM'; }
      Trio.conversation?.render?.();
    }).catch(error => { state.dmLoading = false; state.dmError = error.message || 'Could not load DM'; Trio.conversation?.render?.(); });
  }
  function refreshDm(key) {
    if (!key || document.hidden) return;
    api.get('/api/dms?with=' + encodeURIComponent(key)).then(data => {
      if (data && Array.isArray(data.messages)) data.messages.forEach(Trio.conversation.upsert);
    }).catch(error => console.warn('DM refresh failed', error));
  }
  function openDmByKey(key) {
    if (!key) return;
    api.get('/api/dms?with=' + encodeURIComponent(key)).then(data => {
      const dm = (data.your_dms || []).find(d => d.key === key) || (data.agent_dms || []).find(d => d.key === key);
      if (dm) return openDm(dm, false);
      return api.get('/api/dms?archived=1&with=' + encodeURIComponent(key));
    }).then(data => {
      if (data) { const dm = (data.your_dms || []).find(d => d.key === key); if (dm) openDm(dm, true); }
    }).catch(error => toast(error.message || 'Could not load DM'));
  }
  function toast(message) {
    let host = $('trio-toasts');
    if (!host) { host = document.createElement('div'); host.id = 'trio-toasts'; host.className = 'toast-wrap'; document.body.append(host); }
    const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; host.append(node);
    setTimeout(() => node.remove(), 3500);
  }
  function modal(title, body, submit) {
    let node = $('trio-control-modal');
    if (!node) { node = document.createElement('dialog'); node.id = 'trio-control-modal'; document.body.append(node); }
    node.innerHTML = `<form method="dialog" class="control-modal"><button class="modal-close" value="cancel">×</button><h2>${esc(title)}</h2>${body}<footer><button value="cancel">Cancel</button><button value="default" class="primary">Save</button></footer></form>`;
    node.addEventListener('close', () => { if (node.returnValue === 'default') submit?.(node); }, {once:true}); node.showModal();
  }
  async function archive(kind, key, archived) {
    try { await api.post('/api/archives', {kind, key, archived}); await refresh(); toast(archived ? 'Archived' : 'Restored'); }
    catch (error) { toast(error.message || 'Could not update archive'); }
  }
  async function resolveApproval(id, decision) {
    if (!id) return;
    try {
      await api.post('/api/approvals/' + encodeURIComponent(id) + '/resolve', { decision });
      const list = state.approvals || [];
      const a = list.find(x => x.id === id);
      if (a) { a.status = 'resolved'; a.resolved_decision = decision; }
      showView('attention');
      Trio.workspace?.refresh?.();
    } catch (error) { toast(error.message || 'Could not resolve approval'); }
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
      controls.append(railItem(label, '', () => showView(view), view === 'attention' && attentionCount() ? attentionCount() : '', state.view === view)));
    rail.append(controls, section('Channels', nav.active.map(c => railItem(c.code, c.topic || c.status, () => openChannel(c.code), c.unread || '', state.view === 'conversation' && !state.dmKey && state.channel === c.code))));
    if (nav.yours.length) rail.append(section('Direct messages', nav.yours.map(d => railItem(d.name || d.key, d.preview || 'Private', () => openDm(d), '', state.view === 'conversation' && state.dmKey === d.key))));
    if (nav.agentAudit.length) rail.append(section('Agent activity', nav.agentAudit.map(d => railItem(d.name || d.key, d.preview || 'Agent-to-agent', () => openDm(d, true), '', state.view === 'conversation' && state.dmKey === d.key))));
    const actions = document.createElement('div'); actions.className = 'rail-actions';
    actions.append(railItem('+ New channel', '', createChannel), railItem('Archive browser', '', showArchives), railItem('Agent roster', '', () => { const panel = document.getElementById('trio-agents'); if (panel) panel.hidden = false; Trio.agents?.refresh?.(); }), railItem('Preferences', '', () => Trio.preferences?.panel?.())); rail.append(actions);
  }
  function showView(view) {
    state.view = view;
    document.querySelectorAll('[data-trio-view]').forEach(n => n.hidden = true);
    let panel = $(`trio-${view}-view`);
    if (!panel) { panel = document.createElement('section'); panel.id = `trio-${view}-view`; panel.dataset.trioView = view; panel.className = 'workspace-view'; document.querySelector('.conversation-shell')?.prepend(panel); }
    panel.hidden = false;
    if (view === 'tasks') {
      const filter = state.taskFilter || 'open';
      const tasks = (state.tasks || state.meta?.tasks || []).filter(t => filter === 'all' || (t.status || 'open') === filter);
      panel.innerHTML = `<h2>Tasks</h2><div class="task-filters" id="trio-task-filters"><button data-filter="open" ${filter === 'open' ? 'class="active"' : ''}>Open</button><button data-filter="claimed" ${filter === 'claimed' ? 'class="active"' : ''}>Claimed</button><button data-filter="all" ${filter === 'all' ? 'class="active"' : ''}>All</button></div><div id="trio-task-list">${tasks.map(t => `<article class="task-row" data-status="${esc(t.status || 'open')}"><b>#${esc(t.id || t.task_id)}</b><span>${esc(t.message || t.title || 'Task')}</span><small>${esc(t.status || 'open')}</small></article>`).join('') || '<p>No tasks match.</p>'}</div>`;
      panel.querySelectorAll('#trio-task-filters [data-filter]').forEach(b => b.addEventListener('click', () => { state.taskFilter = b.dataset.filter; showView('tasks'); }));
    }
    else if (view === 'attention') {
      panel.innerHTML = `<h2>Attention</h2><section class="attention-cards" id="trio-attention-cards">${(state.approvals || []).map(a => `<article class="attention-card"><b>${esc(a.title || a.agent_name || 'Approval requested')}</b><p>${esc(a.reason || a.command || '')}</p><div class="decision-row"><button data-approval="${esc(a.id)}" data-decision="accept" ${a.status === 'resolved' ? 'disabled' : ''}>Allow</button><button data-approval="${esc(a.id)}" data-decision="decline" ${a.status === 'resolved' ? 'disabled' : ''}>Decline</button>${a.status === 'resolved' ? `<small>Resolved: ${esc(a.resolved_decision || '')}</small>` : ''}</div></article>`).join('') || '<p>Nothing needs attention.</p>'}</section>`;
      panel.querySelectorAll('#trio-attention-cards [data-approval]').forEach(b => b.addEventListener('click', () => resolveApproval(b.dataset.approval, b.dataset.decision)));
    }
    else panel.innerHTML = `<h2>Home</h2><p>${(state.channels || []).length} active channels · ${(state.dms?.your_dms || []).length} direct conversations</p>`;
  }
  async function createChannel() {
    modal('Create channel', '<label>Channel code<input name="code" required pattern="[a-z0-9][a-z0-9-]*"></label><label>Topic<input name="topic"></label>', async node => { const f=new FormData(node.querySelector('form')); try { await api.post('/api/channels', {code:f.get('code'),topic:f.get('topic')}); openChannel(f.get('code')); } catch (error) { toast(error.message || 'Could not create channel'); } });
  }
  function viewArchiveChannel(code) { loadConversation(code, 'trio#' + code, 'Archived channel — read only', true, false); }
  function viewArchiveDm(dm) { openDm(dm, true); }
  async function showArchives() {
    try {
      const [channels, dms] = await Promise.all([api.get('/api/channels?archived=1'), api.get('/api/dms?archived=1')]);
      const lines = [...(channels.channels || []).map(c => `<li>${esc(c.code)} <button data-kind="channel" data-key="${esc(c.code)}" data-action="view">View</button> <button data-kind="channel" data-key="${esc(c.code)}" data-action="restore">Restore</button></li>`), ...(dms.your_dms || []).map(d => `<li>${esc(d.name || d.key)} <button data-kind="dm" data-key="${esc(d.key)}" data-action="view">View</button> <button data-kind="dm" data-key="${esc(d.key)}" data-action="restore">Restore</button></li>`)].join('') || '<li>Nothing archived.</li>';
      let panel = $('trio-archives'); if (!panel) { panel = document.createElement('dialog'); panel.id = 'trio-archives'; document.body.append(panel); }
      panel.innerHTML = `<form method="dialog"><button class="modal-close">×</button><h2>Archives</h2><ul>${lines}</ul></form>`;
      panel.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.action === 'view') b.dataset.kind === 'channel' ? viewArchiveChannel(b.dataset.key) : viewArchiveDm(dms.your_dms?.find(d => d.key === b.dataset.key) || { key: b.dataset.key, channel: state.channel });
        else archive(b.dataset.kind, b.dataset.key, false);
      }));
      panel.showModal();
    } catch (error) { toast(error.message || 'Could not load archives'); }
  }
  async function archiveCurrent() {
    if (state.dmKey) { await archive('dm', state.dmKey, !state.readOnly); state.readOnly = !state.readOnly; }
    else if (state.channel) { await archive('channel', state.channel, !state.readOnly); state.readOnly = !state.readOnly; }
  }
  async function refresh() {
    try {
      const query = state.channel ? '?channel=' + encodeURIComponent(state.channel) : '';
      const [channels, dms, meta, tasks, approvals] = await Promise.all([api.get('/api/channels'), api.get('/api/dms'), api.get('/api/meta' + query), api.get('/api/tasks' + query).catch(() => ({tasks:[]})), api.get('/api/approvals').catch(() => ({approvals:[]}))]);
      state.channels = channels.channels || []; state.dms = dms; state.meta = {...state.meta, ...meta}; state.tasks=tasks.tasks||[]; state.approvals=approvals.approvals||[]; renderRail();
      Trio.events.dispatchEvent(new CustomEvent('workspace:updated', {detail: state}));
    } catch (error) { console.warn('workspace refresh failed', error); }
  }
  Trio.workspace = {init() { refresh(); setInterval(refresh, 15000); }, render: renderRail, refresh, archive, archiveCurrent, openDm, openDmByKey, refreshDm, groupNavigation, attentionCount, showView, modal, toast};
})();
