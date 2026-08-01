(() => {
  'use strict';
  const Trio = window.Trio;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = Trio.state;
  state.agentFilter = state.agentFilter || 'all';
  state.agentsSearch = state.agentsSearch || '';
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
  async function action(id, action, body = {}) { try { await Trio.api.post(`/api/agents/${encodeURIComponent(id)}/${action}`, body); await refresh(); } catch (e) { Trio.ui.toast(e.message || 'Agent action failed'); } }
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
    const html = rows.map(([k, v]) => `<div class="detail-row"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');
    Trio.ui.modal('Agent details: ' + vm.name, html);
  }
  async function refresh() { try { const data = await Trio.api.get('/api/agents'); state.agents = data.agents || []; Trio.store.set('agents.list', data.agents || []); Trio.store.set('agents.loading', false); render(data.agents); } catch (e) { console.warn(e); } }
  async function activity(id) { try { const d = await Trio.api.get(`/api/agents/${encodeURIComponent(id)}/activity`); const lines = (d.events || []).slice(0, 20).map(e => { const time = e.ts ? new Date(e.ts).toLocaleTimeString() : ''; const type = e.type || 'event'; const content = e.content || e.message || JSON.stringify(e); return `[${time}] ${type}: ${content}`; }).join('\n') || 'No activity'; Trio.ui.modal('Agent activity', `<pre>${esc(lines)}</pre>`); } catch (e) { Trio.ui.toast(e.message); } }
  async function create() { Trio.ui.modal('Create agent', '<label>Name<input name="name" required></label><label>Provider<select name="provider"><option>codex</option><option>claude</option></select></label><label>Model<input name="model"></label>', async node => { const f = new FormData(node.querySelector('form')); try { await Trio.api.post('/api/agents', { name: f.get('name'), provider: f.get('provider'), model: f.get('model'), channels: [Trio.store.get('session.channel')].filter(Boolean) }); await refresh(); } catch (e) { Trio.ui.toast(e.message || 'Could not create agent'); } }); }
  function init() { refresh(); }
  function mount() { init(); }
  function unmount() {}
  Trio.agents = { init, mount, unmount, render, refresh, viewModel, actionCaps, statusIcon, action };
})();
