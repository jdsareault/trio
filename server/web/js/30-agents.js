(() => {
  'use strict';
  const Trio = window.Trio;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = Trio.state;
  state.agentFilter = state.agentFilter || 'all';
  state.agentsSearch = state.agentsSearch || '';
  state.providers = state.providers || ['codex', 'claude'];
  state.agentModels = state.agentModels || { codex: ['o4-mini', 'gpt-4.1'], claude: ['claude-sonnet-4-20250801', 'claude-opus-4-20250801'] };
  state.discoveryLoading = false;
  const pendingAgentActions = new Set();
  const typeInfo = {
    plan: { label: 'Plan', cls: 'type-plan' },
    command: { label: 'Command', cls: 'type-command' },
    tool: { label: 'Tool', cls: 'type-tool' },
    diff: { label: 'Diff', cls: 'type-diff' },
    file: { label: 'File', cls: 'type-file' },
    approval: { label: 'Approval', cls: 'type-approval' },
    warning: { label: 'Warning', cls: 'type-warning' },
    error: { label: 'Error', cls: 'type-error' },
  };
  function host() { let n = $('trio-agents'); if (!n) { n = document.createElement('aside'); n.id = 'trio-agents'; n.className = 'agent-drawer'; document.body.append(n); } n.hidden = true; return n; }
  function viewModel(agent = {}) {
    const lifecycle = agent.state || (agent.live ? (agent.busy ? 'working' : 'idle') : 'offline');
    return {
      id: agent.id,
      name: agent.name || agent.id,
      provider: agent.provider || 'unknown',
      model: agent.model || '',
      effort: agent.effort || '',
      kind: agent.kind || 'agent',
      lifecycle,
      statusText: agent.status_text || '',
      lastActive: agent.last_active || agent.heartbeat,
      busy: !!agent.busy,
      live: !!agent.live,
      error: agent.error || '',
      placements: Array.isArray(agent.channels) ? agent.channels : (Array.isArray(agent.placements) ? agent.placements : []),
      wakePolicy: agent.filter_mode || agent.wake_policy || 'all',
      cwd: agent.cwd || '',
      permissions: agent.permissions || '',
      needsAttention: lifecycle === 'blocked' || lifecycle === 'errored' || lifecycle === 'error' || !!agent.error,
    };
  }
  function actionCaps(vm) {
    const caps = [];
    if (vm.lifecycle === 'working' || vm.lifecycle === 'active') caps.push('stop');
    if (vm.lifecycle === 'idle' || vm.lifecycle === 'sleeping' || vm.lifecycle === 'stopped' || vm.lifecycle === 'offline' || vm.lifecycle === 'stale') caps.push('wake');
    if (vm.lifecycle === 'working' || vm.lifecycle === 'active') caps.push('interrupt');
    if (vm.lifecycle === 'working' || vm.lifecycle === 'active' || vm.lifecycle === 'idle') caps.push('hibernate');
    if (!['errored','blocked'].includes(vm.lifecycle)) caps.push('clear');
    caps.push('delete');
    return caps;
  }
  function statusIcon(vm) {
    if (vm.needsAttention) return '!';
    if (vm.busy) return '●';
    if (vm.live) return '•';
    return '○';
  }
  async function action(id, action, body = {}) {
    const key = id + ':' + action;
    if (pendingAgentActions.has(key)) return;
    pendingAgentActions.add(key);
    try { await Trio.api.post(`/api/agents/${encodeURIComponent(id)}/${action}`, body); await refresh(); }
    catch (e) { Trio.ui.toast(e.message || 'Agent action failed'); }
    finally { pendingAgentActions.delete(key); }
  }
  function agentCard(vm) {
    const article = document.createElement('article'); article.className = 'agent-card' + (vm.needsAttention ? ' needs-attention' : '');
    article.innerHTML = `<b>${esc(vm.name)} ${esc(statusIcon(vm))}</b><small>${esc(vm.provider)}${vm.model ? ' · ' + esc(vm.model) : ''} · ${esc(vm.lifecycle)}</small><p>${esc((vm.placements || []).join(', ') || 'No public rooms')}</p>`;
    const row = document.createElement('div'); row.className = 'agent-actions';
    const detail = document.createElement('button'); detail.type = 'button'; detail.textContent = 'Details'; detail.addEventListener('click', () => showDetail(vm)); row.append(detail);
    for (const a of actionCaps(vm).slice(0, 4)) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = a; b.dataset.action = a; b.dataset.id = vm.id;
      if (a === 'delete' || a === 'clear') b.className = 'danger';
      b.addEventListener('click', () => (a === 'delete' || a === 'clear') && !window.confirm((a === 'delete' ? 'Permanently delete ' : 'Clear context for ') + vm.name + '?') ? null : action(vm.id, a));
      row.append(b);
    }
    const msg = document.createElement('button'); msg.type = 'button'; msg.textContent = 'Message'; msg.addEventListener('click', () => Trio.workspace?.openDmByKey?.(vm.id)); row.append(msg);
    article.append(row); article.append(row);
    return article;
  }
  function matches(vm) {
    const f = state.agentFilter;
    if (f === 'active') return vm.live;
    if (f === 'working') return vm.busy;
    if (f === 'resting') return !vm.busy && !vm.needsAttention;
    if (f === 'needs-attention') return vm.needsAttention;
    return true;
  }
  function render(agents = Trio.store.get('agents.list')) {
    const n = host();
    const list = (agents || []).map(a => viewModel(a)).filter(matches);
    if (state.agentsSearch) {
      const q = state.agentsSearch.toLowerCase();
      list = list.filter(vm => (vm.name + ' ' + vm.model + ' ' + vm.provider).toLowerCase().includes(q));
    }
    n.innerHTML = `<button class="modal-close" aria-label="Close">×</button><h2>Agent roster</h2><div class="agent-filters">${['all','active','working','resting','needs-attention'].map(f => `<button data-filter="${f}" class="${state.agentFilter === f ? 'active' : ''}">${f.replace(/-/g,' ')}</button>`).join('')}</div><input class="agent-search" placeholder="Search agents…" value="${esc(state.agentsSearch)}"><div class="agent-list">${list.length ? '' : '<p>No agents match.</p>'}</div>`;
    n.querySelector('.modal-close').onclick = () => n.hidden = true;
    const listNode = n.querySelector('.agent-list');
    list.forEach(vm => listNode.append(agentCard(vm)));
    n.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { state.agentFilter = b.dataset.filter; render(agents); });
    const input = n.querySelector('.agent-search');
    input.oninput = () => { state.agentsSearch = input.value; render(agents); };
  }
  function showDetail(vm) {
    const rows = [
      ['Name', vm.name], ['Provider', vm.provider], ['Model', vm.model], ['Lifecycle', vm.lifecycle],
      ['Wake policy', vm.wakePolicy], ['Cwd', vm.cwd], ['Permissions', vm.permissions], ['Placements', (vm.placements || []).join(', ') || 'none'],
      ['Last active', vm.lastActive || ''], ['Status', vm.statusText || ''], ['Error', vm.error || ''],
    ];
    const html = rows.map(([k, v]) => `<div class="detail-row"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('') +
      `<div class="agent-actions"><button data-edit="placements" type="button">Edit placements</button><button data-edit="wake" type="button">Edit wake policy</button></div>`;
    Trio.ui.modal('Agent details: ' + vm.name, html);
    setTimeout(() => {
      const panel = document.getElementById('trio-control-modal');
      if (!panel) return;
      panel.querySelector('[data-edit="placements"]')?.addEventListener('click', () => editPlacements(vm));
      panel.querySelector('[data-edit="wake"]')?.addEventListener('click', () => editWake(vm));
    }, 0);
  }
  function editPlacements(vm) {
    const channels = (state.channels || []).filter(c => !c.archived);
    const html = channels.map(c => `<label><input type="checkbox" name="placement" value="${esc(c.code)}" ${(vm.placements || []).includes(c.code) ? 'checked' : ''}> ${esc(c.code)}</label>`).join('');
    Trio.ui.modal('Placements for ' + vm.name, html || '<p>No channels available.</p>', node => {
      const selected = [...node.querySelectorAll('input[name="placement"]:checked')].map(cb => cb.value);
      action(vm.id, 'placements', { placements: selected });
    });
  }
  function editWake(vm) {
    const html = '<label>Wake policy <select name="wake"><option value="all" ' + (vm.wakePolicy === 'all' ? 'selected' : '') + '>all</option><option value="about" ' + (vm.wakePolicy === 'about' ? 'selected' : '') + '>about</option><option value="at" ' + (vm.wakePolicy === 'at' ? 'selected' : '') + '>at</option></select></label>';
    Trio.ui.modal('Wake policy for ' + vm.name, html, node => { const v = node.querySelector('[name="wake"]').value; action(vm.id, 'wake', { filter_mode: v }); });
  }
  async function loadDiscovery() {
    if (state.discoveryLoading) return;
    state.discoveryLoading = true;
    try {
      const [health, models] = await Promise.all([Trio.api.get('/api/health').catch(() => ({})), Trio.api.get('/api/agent-models').catch(() => ({}))]);
      if (Array.isArray(health.providers)) state.providers = health.providers;
      if (models && typeof models.models === 'object' && Object.keys(models.models).length) state.agentModels = models.models;
    } catch (e) { console.warn('discovery failed', e); }
    finally { state.discoveryLoading = false; }
  }
  async function refresh() { try { const data = await Trio.api.get('/api/agents'); state.agents = data.agents || []; Trio.store.set('agents.list', data.agents || []); Trio.store.set('agents.loading', false); render(data.agents); } catch (e) { console.warn(e); } }
  function renderActivityEvent(e) {
    const time = e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
    const t = (e.type || 'event').toLowerCase();
    const meta = typeInfo[t] || { label: t, cls: '' };
    const content = typeof e.content === 'string' ? e.content : (e.message || (e.content ? JSON.stringify(e.content, null, 2) : ''));
    const body = content ? `<pre class="activity-raw">${esc(String(content).slice(0, 800))}</pre>` : '';
    return `<article class="activity-event ${esc(meta.cls)}"><time>${esc(time)}</time><b>${esc(meta.label)}</b>${body}</article>`;
  }
  function showActivity(id, events = [], offset = 0) {
    let panel = $('trio-activity');
    if (!panel) { panel = document.createElement('dialog'); panel.id = 'trio-activity'; panel.className = 'activity-panel'; document.body.append(panel); }
    const pageSize = 20;
    const page = events.slice(offset, offset + pageSize);
    if (!offset) panel.innerHTML = '<form method="dialog"><button class="modal-close" aria-label="Close">×</button><h2>Agent activity</h2><div class="activity-list"></div></form>';
    const list = panel.querySelector('.activity-list');
    if (!page.length && !offset) { list.innerHTML = '<p class="home-empty">No activity.</p>'; }
    else { list.insertAdjacentHTML('beforeend', page.map(renderActivityEvent).join('')); }
    const existing = panel.querySelector('.activity-more');
    if (existing) existing.remove();
    if (offset + pageSize < events.length) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'activity-more'; more.textContent = 'Load more';
      more.addEventListener('click', () => showActivity(id, events, offset + pageSize));
      panel.querySelector('form').append(more);
    }
    panel.showModal();
  }
  async function activity(id) { try { const d = await Trio.api.get(`/api/agents/${encodeURIComponent(id)}/activity`); showActivity(id, d.events || []); } catch (e) { Trio.ui.toast(e.message); } }
  function init() { loadDiscovery(); refresh(); }
  function mount() { init(); }
  function unmount() {}
  async function create() {
    const providers = state.providers.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    const defaultProvider = state.providers[0] || 'codex';
    const models = (state.agentModels[defaultProvider] || []).map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    const html = `<label class="field">Name <input name="name" required pattern="[A-Za-z0-9_]{1,32}"></label><label class="field">Provider <select name="provider">${providers}</select></label><label class="field">Model <select name="model">${models}</select></label><label class="field">Working directory <input name="cwd" placeholder="/path/to/project"></label><label class="field">Permission profile <input name="permissions" placeholder="operator,guest"></label>`;
    Trio.ui.modal('Create agent', html, async node => {
      const f = new FormData(node.querySelector('form'));
      const name = (f.get('name') || '').trim();
      const provider = f.get('provider');
      const model = f.get('model');
      const cwd = (f.get('cwd') || '').trim();
      if (!name) { Trio.ui.toast('Name is required'); return; }
      if (!provider) { Trio.ui.toast('Provider is required'); return; }
      if (!model) { Trio.ui.toast('Model is required'); return; }
      const key = 'create:' + name;
      if (pendingAgentActions.has(key)) return;
      pendingAgentActions.add(key);
      Trio.ui.toast('Creating agent…');
      try {
        const result = await Trio.api.post('/api/agents', { name, provider, model, cwd, permissions: (f.get('permissions') || '').trim(), channels: [Trio.store.get('session.channel')].filter(Boolean) });
        await refresh();
        if (result?.agent?.id) Trio.workspace?.openDmByKey?.(result.agent.id);
      } catch (e) { Trio.ui.toast(e.message || 'Could not create agent'); }
      finally { pendingAgentActions.delete(key); }
    });
  }
  Trio.agents = { init, mount, unmount, render, refresh, loadDiscovery, viewModel, actionCaps, statusIcon, action };
})();
