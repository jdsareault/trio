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
  let discoveryPromise = null;
  const pendingAgentActions = new Set();
  const compactionPolls = new Map();
  const PERMISSION_PROFILES = [
    ['observe', 'Observe (read-only)'],
    ['balanced', 'Balanced'],
    ['autonomous', 'Autonomous'],
  ];
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
  function host() { let n = $('trio-agents'); if (!n) { n = document.createElement('aside'); n.id = 'trio-agents'; n.className = 'agent-drawer'; n.hidden = true; document.body.append(n); } return n; }
  function viewModel(agent = {}) {
    const lifecycle = agent.state === 'compacting' ? 'compacting' :
      (agent.live ? (agent.busy ? 'working' : 'idle') : (agent.state || 'offline'));
    return {
      id: agent.id,
      name: agent.name || agent.id,
      avatarUrl: agent.avatar_url || '',
      provider: agent.provider || 'unknown',
      model: agent.model || '',
      effort: agent.effort || '',
      kind: agent.kind || 'agent',
      lifecycle,
      statusText: agent.status_text || '',
      lastActive: agent.last_active || agent.last_active_at || agent.heartbeat,
      busy: !!agent.busy,
      live: !!agent.live,
      error: agent.error || '',
      placements: Array.isArray(agent.channels) ? agent.channels : (Array.isArray(agent.placements) ? agent.placements : []),
      wakePolicy: agent.wake_mode || agent.filter_mode || 'all',
      cwd: agent.cwd || '',
      permissions: agent.permission_profile || agent.permissions || '',
      compacting: lifecycle === 'compacting',
      archived: !!agent.archived || !!agent.archived_at,
      needsAttention: lifecycle === 'blocked' || lifecycle === 'errored' || lifecycle === 'error' || !!agent.error,
      contextPct: agent.context_pct == null ? null : Number(agent.context_pct),
    };
  }
  function actionCaps(vm) {
    const caps = [];
    if (vm.archived) return ['unarchive'];
    if (vm.lifecycle === 'compacting') return ['stop', 'archive'];
    if (vm.lifecycle === 'working' || vm.lifecycle === 'active') caps.push('stop');
    if (!vm.live && (vm.lifecycle === 'idle' || vm.lifecycle === 'sleeping' || vm.lifecycle === 'stopped' || vm.lifecycle === 'offline' || vm.lifecycle === 'stale')) caps.push('wake');
    if (vm.lifecycle === 'working' || vm.lifecycle === 'active') caps.push('interrupt');
    if (vm.lifecycle === 'working' || vm.lifecycle === 'active' || vm.lifecycle === 'idle') caps.push('hibernate');
    if (vm.lifecycle === 'idle') caps.push('compact');
    if (!['errored','blocked'].includes(vm.lifecycle)) caps.push('clear');
    caps.push('archive');
    return caps;
  }
  function actionLabel(action) {
    return ({
      stop: 'Stop',
      interrupt: 'Interrupt',
      hibernate: 'Hibernate',
      compact: 'Compact context',
      wake: 'Wake',
      clear: 'Clear context',
      archive: 'Archive agent',
      unarchive: 'Unarchive agent',
    })[action] || action;
  }
  function isDestructiveAction(action) { return action === 'clear' || action === 'archive'; }
  function confirmAction(vm, actionName) {
    if (!isDestructiveAction(actionName)) return true;
    if (actionName === 'archive') {
      let msg = 'Archive ' + vm.name + '? It stops the agent and hides it from the roster, but can be restored later.';
      if (vm.busy || vm.lifecycle === 'working' || vm.lifecycle === 'active')
        msg += '\n\nWarning: this agent is working — archiving will interrupt any work in progress.';
      else if (vm.lifecycle === 'compacting')
        msg += '\n\nWarning: this agent is compacting its context — archiving will interrupt it.';
      return window.confirm(msg);
    }
    return window.confirm('Clear context for ' + vm.name + '?');
  }
  function statusIcon(vm) {
    if (vm.needsAttention) return '!';
    if (vm.busy) return '●';
    if (vm.live) return '•';
    return '○';
  }
  function formatLastActive(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }
  async function action(id, action, body = {}) {
    const key = id + ':' + action;
    if (pendingAgentActions.has(key)) return;
    pendingAgentActions.add(key);
    try {
      await Trio.api.post(`/api/agents/${encodeURIComponent(id)}/${action}`, body);
      await refresh();
      if (action === 'compact') watchCompaction(id);
    }
    catch (e) { Trio.ui.toast(e.message || 'Agent action failed'); }
    finally { pendingAgentActions.delete(key); }
  }
  function watchCompaction(id) {
    clearTimeout(compactionPolls.get(id));
    const poll = async () => {
      await refresh();
      const agent = (state.agents || []).find(candidate => candidate.id === id);
      if (agent?.state === 'compacting') compactionPolls.set(id, setTimeout(poll, 1500));
      else compactionPolls.delete(id);
    };
    const agent = (state.agents || []).find(candidate => candidate.id === id);
    if (agent?.state === 'compacting') compactionPolls.set(id, setTimeout(poll, 1500));
  }
  function agentCard(vm) {
    const article = document.createElement('article'); article.className = 'agent-card' + (vm.needsAttention ? ' needs-attention' : '') + (vm.archived ? ' is-archived' : '');
    article.innerHTML = `<b>${esc(vm.name)} ${esc(statusIcon(vm))}</b><small>${esc(vm.provider)}${vm.model ? ' · ' + esc(vm.model) : ''} · ${esc(vm.archived ? 'archived' : vm.lifecycle)}</small><p>${esc((vm.placements || []).join(', ') || 'No public rooms')}</p>`;
    const row = document.createElement('div'); row.className = 'agent-actions';
    const detail = document.createElement('button'); detail.type = 'button'; detail.textContent = 'Details'; detail.addEventListener('click', () => showDetail(vm)); row.append(detail);
    for (const a of actionCaps(vm).slice(0, 4)) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = a; b.dataset.action = a; b.dataset.id = vm.id;
      if (isDestructiveAction(a)) b.className = 'danger';
      b.addEventListener('click', () => confirmAction(vm, a) && action(vm.id, a));
      row.append(b);
    }
    if (!vm.archived) {
      const msg = document.createElement('button'); msg.type = 'button'; msg.textContent = 'Message'; msg.addEventListener('click', () => Trio.workspace?.openDmByKey?.(vm.id)); row.append(msg);
    }
    article.append(row);
    return article;
  }
  function matches(vm) {
    const f = state.agentFilter;
    if (f === 'archived') return vm.archived;
    if (f === 'active') return vm.live;
    if (f === 'working') return vm.busy;
    if (f === 'resting') return !vm.busy && !vm.needsAttention;
    if (f === 'needs-attention') return vm.needsAttention;
    return true;
  }
  function directoryCard(vm) {
    const article = document.createElement('article'); article.className = 'agent-card agent-card-openable' + (vm.needsAttention ? ' needs-attention' : '') + (vm.archived ? ' is-archived' : '');
    article.tabIndex = 0;
    article.setAttribute('aria-label', 'Manage agent ' + vm.name);
    const openDetails = event => {
      if (event?.target?.closest?.('button')) return;
      showDetail(vm);
    };
    article.addEventListener('click', openDetails);
    article.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.target?.closest?.('button')) {
        event.preventDefault(); showDetail(vm);
      }
    });
    const initials = (vm.name || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
    const tone = vm.archived ? 'var(--ink-3)' : vm.needsAttention ? 'var(--danger)' : vm.busy ? 'var(--warn)' : vm.live ? 'var(--ok)' : 'var(--accent)';
    article.style.setProperty('--card-accent', tone);
    const avatar = vm.avatarUrl ? `<span class="directory-avatar avatar-svg"><img src="${esc(vm.avatarUrl)}" alt="" class="avatar-svg-image"></span>` : `<span class="directory-avatar">${esc(initials)}</span>`;
    const chipCls = vm.archived ? 'archived' : vm.needsAttention ? 'offline' : vm.compacting || vm.busy ? 'thinking' : vm.live ? 'online' : 'idle';
    const chipLabel = vm.archived ? 'Archived' : vm.needsAttention ? 'Needs attention' : vm.compacting ? 'Compacting context…' : vm.busy ? 'Working' : vm.live ? 'Active' : 'Resting';
    const contextTag = vm.contextPct == null ? '' :
      `<span class="context-badge ${Trio.workspace.usageTone(vm.contextPct)}" title="${esc(String(Math.round(vm.contextPct)))}% of context window used">${esc(String(Math.round(vm.contextPct)))}% full</span>`;
    article.innerHTML = `<div class="ac-top">${avatar}<span><div class="ac-name">${esc(vm.name)}</div><div class="ac-role">${esc(vm.provider)}${vm.model ? ' · ' + esc(vm.model) : ''}</div></span></div><div class="ac-bio">${esc(vm.statusText || (vm.archived ? 'Archived — restore to rejoin.' : vm.live ? 'Connected and ready.' : 'Not currently connected.'))}</div><div class="ac-foot"><span class="status-chip ${chipCls}"><span class="st-dot"></span>${esc(chipLabel)}</span>${contextTag}${(vm.placements || []).slice(0, 2).map(p => `<span class="tag">#${esc(p)}</span>`).join('')}</div>`;
    const actions = document.createElement('div'); actions.className = 'agent-actions';
    if (!vm.archived) {
      const message = document.createElement('button'); message.type = 'button'; message.textContent = 'Message'; message.addEventListener('click', () => Trio.workspace?.openDmByKey?.(vm.id)); actions.append(message);
    }
    article.append(actions); return article;
  }
  function renderPage(panel) {
    panel.replaceChildren();
    const hero = document.createElement('div'); hero.className = 'view-hero'; hero.innerHTML = '<h2>Agent roster</h2><p>Everyone working in this workspace</p>';
    const toolbar = document.createElement('div'); toolbar.className = 'roster-toolbar';
    const segment = document.createElement('div'); segment.className = 'seg';
    [['all','All'],['active','Active'],['working','Working'],['resting','Resting'],['needs-attention','Needs attention'],['archived','Archived']].forEach(([filter,label]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = state.agentFilter === filter ? 'on' : ''; b.addEventListener('click', () => { const crossing = (state.agentFilter === 'archived') !== (filter === 'archived'); state.agentFilter = filter; if (crossing) refresh(); else renderPage(panel); }); segment.append(b); });
    const search = document.createElement('input'); search.className = 'agent-page-search'; search.placeholder = 'Search agents…'; search.value = state.agentsSearch || ''; search.setAttribute('aria-label', 'Search agents'); search.addEventListener('input', () => { state.agentsSearch = search.value; renderPage(panel); });
    const createButton = document.createElement('button'); createButton.type = 'button'; createButton.className = 'btn primary'; createButton.textContent = 'New agent'; createButton.addEventListener('click', create);
    toolbar.append(segment, search, createButton);
    const grid = document.createElement('div'); grid.className = 'roster-grid';
    let list = (Trio.store.get('agents.list') || state.agents || []).map(viewModel).filter(matches);
    const query = (state.agentsSearch || '').trim().toLowerCase(); if (query) list = list.filter(vm => `${vm.name} ${vm.provider} ${vm.model}`.toLowerCase().includes(query));
    if (!list.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.innerHTML = '<div class="e-ic">✦</div><h3>No agents match</h3><p>Try another filter or invite someone new to the workspace.</p>'; grid.append(empty); }
    list.forEach(vm => grid.append(directoryCard(vm)));
    panel.append(hero, toolbar, grid);
  }
  function render(agents = Trio.store.get('agents.list')) {
    const n = host();
    let list = (agents || []).map(a => viewModel(a)).filter(matches);
    if (state.agentsSearch) {
      const q = state.agentsSearch.toLowerCase();
      list = list.filter(vm => (vm.name + ' ' + vm.model + ' ' + vm.provider).toLowerCase().includes(q));
    }
    n.innerHTML = `<button class="modal-close" aria-label="Close">×</button><h2>Agent roster</h2><div class="agent-filters">${['all','active','working','resting','needs-attention','archived'].map(f => `<button data-filter="${f}" class="${state.agentFilter === f ? 'active' : ''}">${f.replace(/-/g,' ')}</button>`).join('')}<button type="button" class="agent-new">New agent</button></div><input class="agent-search" placeholder="Search agents…" value="${esc(state.agentsSearch)}"><div class="agent-list">${list.length ? '' : '<p>No agents match.</p>'}</div>`;
    n.querySelector('.modal-close').onclick = () => n.hidden = true;
    n.querySelector('.agent-new').onclick = () => create();
    const listNode = n.querySelector('.agent-list');
    list.forEach(vm => listNode.append(agentCard(vm)));
    n.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { const crossing = (state.agentFilter === 'archived') !== (b.dataset.filter === 'archived'); state.agentFilter = b.dataset.filter; if (crossing) refresh(); else render(agents); });
    const input = n.querySelector('.agent-search');
    input.oninput = () => { state.agentsSearch = input.value; render(agents); };
  }
  function showDetail(vm) {
    const rows = [
      ['Name', vm.name], ['Provider', vm.provider], ['Model', vm.model], ['Lifecycle', vm.lifecycle],
      ['Reasoning effort', vm.effort || 'default'], ['Wake policy', vm.wakePolicy], ['Cwd', vm.cwd], ['Permissions', vm.permissions], ['Placements', (vm.placements || []).join(', ') || 'none'],
      ['Last active', formatLastActive(vm.lastActive)], ['Status', vm.statusText || ''], ['Error', vm.error || ''],
    ];
    const lifecycleActions = actionCaps(vm).map(actionName =>
      `<button data-agent-action="${esc(actionName)}" type="button"${isDestructiveAction(actionName) ? ' class="danger"' : ''}>${esc(actionLabel(actionName))}</button>`
    ).join('');
    const html = rows.map(([k, v]) => `<div class="detail-row"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('') +
      `<div class="agent-actions" aria-label="Agent lifecycle controls">${lifecycleActions}</div>` +
      `<div class="agent-actions"><button data-edit="placements" type="button">Edit placements</button><button data-edit="wake" type="button">Edit wake policy</button><button data-edit="effort" type="button">Edit reasoning effort</button></div>`;
    Trio.ui.modal('Manage agent: ' + vm.name, html, undefined, { submit: false, cancelLabel: 'Close' });
    setTimeout(() => {
      const panel = document.getElementById('trio-control-modal');
      if (!panel) return;
      panel.querySelectorAll('[data-agent-action]').forEach(button => button.addEventListener('click', () => {
        const actionName = button.dataset.agentAction;
        if (actionName === 'compact') {
          panel.close('cancel');
          setTimeout(() => showCompact(vm), 0);
        } else if (confirmAction(vm, actionName)) {
          panel.close('cancel');
          let toastMsg = actionLabel(actionName) + ' requested for ' + vm.name;
          if (actionName === 'unarchive') toastMsg += ' — Wake it to resume';
          Trio.ui.toast(toastMsg);
          action(vm.id, actionName);
        }
      }));
      panel.querySelector('[data-edit="placements"]')?.addEventListener('click', () => {
        panel.close('cancel'); setTimeout(() => editPlacements(vm), 0);
      });
      panel.querySelector('[data-edit="wake"]')?.addEventListener('click', () => {
        panel.close('cancel'); setTimeout(() => editWake(vm), 0);
      });
      panel.querySelector('[data-edit="effort"]')?.addEventListener('click', () => {
        panel.close('cancel'); setTimeout(() => editEffort(vm), 0);
      });
    }, 0);
  }
  function showCompact(vm) {
    const html = `<p>Summarize this agent's context to free room while retaining the important work.</p><label class="field">What should be preserved? <textarea name="compaction-message" maxlength="2000" placeholder="Optional: key decisions, constraints, or next steps to retain"></textarea></label>`;
    Trio.ui.modal('Compact context: ' + vm.name, html, node => {
      const message = (node.querySelector('[name="compaction-message"]')?.value || '').trim();
      action(vm.id, 'compact', { message });
    });
  }
  function editPlacements(vm) {
    const channels = (state.channels || []).filter(c => !c.archived);
    const html = channels.map(c => `<label><input type="checkbox" name="placement" value="${esc(c.code)}" ${(vm.placements || []).includes(c.code) ? 'checked' : ''}> ${esc(c.code)}</label>`).join('');
    Trio.ui.modal('Placements for ' + vm.name, html || '<p>No channels available.</p>', async node => {
      const selected = new Set([...node.querySelectorAll('input[name="placement"]:checked')].map(cb => cb.value));
      const before = new Set(vm.placements || []);
      const changed = channels.map(c => c.code).filter(code => selected.has(code) !== before.has(code));
      for (const channel of changed) await action(vm.id, 'placement', { channel, present: selected.has(channel) });
    });
  }
  function editWake(vm) {
    const html = '<label>Wake policy <select name="wake"><option value="all" ' + (vm.wakePolicy === 'all' ? 'selected' : '') + '>all</option><option value="about" ' + (vm.wakePolicy === 'about' ? 'selected' : '') + '>about</option><option value="at" ' + (vm.wakePolicy === 'at' ? 'selected' : '') + '>at</option></select></label>';
    Trio.ui.modal('Wake policy for ' + vm.name, html, node => { const v = node.querySelector('[name="wake"]').value; action(vm.id, 'wake-mode', { mode: v }); });
  }
  // Efforts are per-MODEL (a Sonnet agent and a Haiku agent don't support the
  // same set) — look the agent's own model up in the already-discovered
  // provider model list rather than offering a fixed global list.
  function effortModelEntry(provider, modelId) {
    return normalizeModels(state.agentModels[provider]).find(m => m.id === modelId);
  }
  function effortsForModel(provider, modelId) {
    const model = effortModelEntry(provider, modelId);
    return Array.isArray(model?.efforts) && model.efforts.length ? model.efforts : ['low', 'medium', 'high'];
  }
  // LOTC/Frodo: with no "use the model's own default" option, the browser
  // auto-selects the FIRST <option> whenever `selected` matches nothing —
  // which silently downgraded every unedited agent to the lowest effort
  // (both at creation and when merely opening-then-saving the edit dialog,
  // since an agent at its default has vm.effort === ''). A real, always-
  // present "Model default" option fixes both: it's what actually gets sent
  // when the user doesn't touch the control, matching what the backend
  // already does with an empty effort string.
  // `current` (if given and not already in `efforts`) is kept as an option
  // rather than dropped — an agent already running at "max" must not lose
  // that from the list just because live discovery came back stale/thin.
  function effortOptions(efforts, selected, { defaultLabel = 'Model default' } = {}) {
    const all = current => current && !efforts.includes(current) ? [...efforts, current] : efforts;
    const list = all(selected);
    const opts = list.map(e => `<option value="${esc(e)}"${e === selected ? ' selected' : ''}>${esc(e)}</option>`).join('');
    return `<option value=""${selected ? '' : ' selected'}>${esc(defaultLabel)}</option>` + opts;
  }
  async function editEffort(vm) {
    await loadDiscovery();
    const efforts = effortsForModel(vm.provider, vm.model);
    const model = effortModelEntry(vm.provider, vm.model);
    const defaultLabel = model?.default_effort ? `Model default (${model.default_effort})` : 'Model default';
    // Sauron: this claim differs by provider. Codex re-reads effort fresh on
    // EVERY turn (no restart involved) — Claude fixes it in the process argv
    // at spawn, so only Clear (a genuinely fresh session) is guaranteed to
    // pick up a change; Wake resumes the existing session and may not.
    const hint = vm.provider === 'codex'
      ? 'applies to this agent’s next message — no restart needed'
      : 'applies once this agent is Cleared (a fresh session) — Wake resumes the existing session and may not pick it up';
    const html = `<label class="field">Reasoning effort <span class="hint">${esc(hint)}</span><select name="effort">${effortOptions(efforts, vm.effort, { defaultLabel })}</select></label>`;
    Trio.ui.modal('Reasoning effort for ' + vm.name, html, async node => {
      const v = node.querySelector('[name="effort"]').value;
      await action(vm.id, 'effort', { effort: v });
      Trio.ui.toast(v ? `Reasoning effort set to ${v} — ${hint}` : `Reasoning effort reset to ${defaultLabel.toLowerCase()} — ${hint}`);
    });
  }
  function normalizeModels(models) {
    if (!Array.isArray(models)) return [];
    return models.map(model => {
      if (typeof model === 'string') return { id: model, name: model };
      if (!model || typeof model !== 'object') return null;
      const id = model.id || model.model;
      return id ? { ...model, id, name: model.name || model.displayName || id } : null;
    }).filter(Boolean);
  }
  function modelOptions(models) {
    return normalizeModels(models).map(model => `<option value="${esc(model.id)}">${esc(model.name)}</option>`).join('');
  }
  function permissionOptions(selected = 'balanced') {
    return `<select name="permission_profile">${PERMISSION_PROFILES.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
  }
  async function loadDiscovery() {
    if (discoveryPromise) return discoveryPromise;
    discoveryPromise = (async () => {
      state.discoveryLoading = true;
      try {
        const health = await Trio.api.get('/api/health').catch(() => ({}));
        const providers = Array.isArray(health.providers) ? health.providers : Object.keys(health.runtimes || {});
        if (providers.length) state.providers = [...new Set(providers.map(p => String(p).toLowerCase()))];
        const discovered = await Promise.all(state.providers.map(async provider => {
          const data = await Trio.api.get(`/api/agent-models?provider=${encodeURIComponent(provider)}`).catch(() => null);
          return data && Array.isArray(data.models) ? [provider, normalizeModels(data.models)] : null;
        }));
        const nextModels = { ...state.agentModels };
        discovered.filter(Boolean).forEach(([provider, models]) => { nextModels[provider] = models; });
        state.agentModels = nextModels;
      } catch (e) { console.warn('discovery failed', e); }
      finally {
        state.discoveryLoading = false;
        discoveryPromise = null;
      }
      return state.agentModels;
    })();
    return discoveryPromise;
  }
  async function refresh() {
    try {
      const archived = state.agentFilter === 'archived';
      const data = await Trio.api.get('/api/agents' + (archived ? '?archived=1' : ''));
      state.agents = data.agents || [];
      Trio.store.set('agents.list', data.agents || []);
      Trio.store.set('agents.loading', false);
      render(data.agents);
      if (state.view === 'roster') {
        const roster = document.getElementById('trio-roster-view');
        if (roster && !roster.hidden) renderPage(roster);
      }
    } catch (e) { console.warn(e); }
  }
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
    Trio.ui.configureDialog(panel);
    const pageSize = 20;
    const page = events.slice(offset, offset + pageSize);
    if (!offset) panel.innerHTML = '<form method="dialog"><button type="submit" formnovalidate class="modal-close" aria-label="Close">×</button><h2>Agent activity</h2><div class="activity-list"></div></form>';
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
  function unmount() { compactionPolls.forEach(timer => clearTimeout(timer)); compactionPolls.clear(); }
  async function create() {
    await loadDiscovery();
    const providers = state.providers.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    const defaultProvider = state.providers[0] || 'codex';
    const defaultModels = normalizeModels(state.agentModels[defaultProvider]);
    const models = modelOptions(state.agentModels[defaultProvider]);
    const defaultModelId = defaultModels[0]?.id || '';
    const channelOpts = (state.channels || []).filter(c => !c.archived)
      .map(c => `<label><input type="checkbox" name="placement" value="${esc(c.code)}"> ${esc(c.code)}</label>`).join('');
    const channelsField = channelOpts
      ? `<fieldset class="field"><legend>Channels <span class="hint">optional — place later if blank</span></legend>${channelOpts}</fieldset>`
      : '';
    const html = `<label class="field">Name <span class="hint">optional — assigned automatically if blank</span><input name="name" pattern="[A-Za-z0-9_]{1,32}" placeholder="Leave blank for a random character name"></label><label class="field">Provider <select name="provider">${providers}</select></label><label class="field">Model <select name="model">${models}</select></label><label class="field">Reasoning effort <select name="effort">${effortOptions(effortsForModel(defaultProvider, defaultModelId), '')}</select></label><label class="field">Working directory <input name="cwd" placeholder="/path/to/project"></label><label class="field">Permission profile ${permissionOptions()}</label>${channelsField}`;
    Trio.ui.modal('Create agent', html, async node => {
      const f = new FormData(node.querySelector('form'));
      const name = (f.get('name') || '').trim();
      const provider = f.get('provider');
      const model = f.get('model');
      const effort = f.get('effort') || '';
      const cwd = (f.get('cwd') || '').trim();
      const channels = [...node.querySelectorAll('input[name="placement"]:checked')].map(cb => cb.value);
      if (!provider) { Trio.ui.toast('Provider is required'); return; }
      if (!model) { Trio.ui.toast('Model is required'); return; }
      const key = 'create:' + name;
      if (pendingAgentActions.has(key)) return;
      pendingAgentActions.add(key);
      Trio.ui.toast('Creating agent…');
      try {
        const result = await Trio.api.post('/api/agents', { name, provider, model, effort, cwd, permission_profile: f.get('permission_profile') || 'balanced', channels });
        await refresh();
        if (result?.agent?.id) Trio.workspace?.openDmByKey?.(result.agent.id);
      } catch (e) { Trio.ui.toast(e.message || 'Could not create agent'); }
      finally { pendingAgentActions.delete(key); }
    });
    const panel = document.getElementById('trio-control-modal');
    const providerField = panel?.querySelector('select[name="provider"]');
    const modelField = panel?.querySelector('select[name="model"]');
    const effortField = panel?.querySelector('select[name="effort"]');
    const refreshEffortOptions = () => {
      if (!effortField) return;
      effortField.innerHTML = effortOptions(effortsForModel(providerField?.value, modelField?.value), '');
    };
    providerField?.addEventListener('change', () => {
      if (modelField) modelField.innerHTML = modelOptions(state.agentModels[providerField.value]);
      refreshEffortOptions();
    });
    modelField?.addEventListener('change', refreshEffortOptions);
  }
  Trio.agents = { init, mount, unmount, render, renderPage, refresh, loadDiscovery, normalizeModels, modelOptions, permissionOptions, viewModel, actionCaps, actionLabel, statusIcon, formatLastActive, action, create, effortsForModel, effortOptions };
})();
