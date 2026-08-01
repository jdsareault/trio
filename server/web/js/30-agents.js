(() => {
  'use strict';
  const Trio = window.Trio;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function host() { let n = $('trio-agents'); if (!n) { n = document.createElement('aside'); n.id = 'trio-agents'; n.className = 'agent-drawer'; document.body.append(n); } n.hidden = true; return n; }
  function label(agent) { return agent.live ? (agent.busy ? 'working' : 'online') : (agent.state || 'offline'); }
  async function action(id, action, body = {}) { try { await Trio.api.post(`/api/agents/${encodeURIComponent(id)}/${action}`, body); await refresh(); } catch (e) { Trio.ui.toast(e.message || 'Agent action failed'); } }
  function render(agents = Trio.store.get('agents.list')) { const n = host(); n.innerHTML = `<button class="modal-close" aria-label="Close">×</button><h2>Agent roster</h2><button class="new-agent">New agent</button><div class="agent-list">${(agents || []).map(a => `<article class="agent-card"><b>${esc(a.name)}</b><small>${esc(a.model || a.provider || 'agent')} · ${esc(label(a))}</small><p>${esc((a.channels || []).join(', ') || 'No public rooms')}</p><div><button data-action="wake" data-id="${esc(a.id)}">Wake</button><button data-action="hibernate" data-id="${esc(a.id)}">Hibernate</button><button data-action="activity" data-id="${esc(a.id)}">Activity</button></div></article>`).join('') || '<p>No agents.</p>'}</div>`; n.querySelector('.modal-close').onclick = () => n.hidden = true; n.querySelectorAll('[data-action]').forEach(b => b.onclick = () => b.dataset.action === 'activity' ? activity(b.dataset.id) : action(b.dataset.id, b.dataset.action)); n.querySelector('.new-agent').onclick = create; }
  async function refresh() { try { const data = await Trio.api.get('/api/agents'); Trio.store.set('agents.list', data.agents || []); Trio.store.set('agents.loading', false); render(); } catch (e) { console.warn(e); } }
  async function activity(id) { try { const d = await Trio.api.get(`/api/agents/${encodeURIComponent(id)}/activity`); const lines = (d.events || []).slice(0, 20).map(e => { const time = e.ts ? new Date(e.ts).toLocaleTimeString() : ''; const type = e.type || 'event'; const content = e.content || e.message || JSON.stringify(e); return `[${time}] ${type}: ${content}`; }).join('\n') || 'No activity'; Trio.ui.modal('Agent activity', `<pre>${esc(lines)}</pre>`); } catch (e) { Trio.ui.toast(e.message); } }
  async function create() { Trio.ui.modal('Create agent', '<label>Name<input name="name" required></label><label>Provider<select name="provider"><option>codex</option><option>claude</option></select></label><label>Model<input name="model"></label>', async node => { const f = new FormData(node.querySelector('form')); try { await Trio.api.post('/api/agents', { name: f.get('name'), provider: f.get('provider'), model: f.get('model'), channels: [Trio.store.get('session.channel')].filter(Boolean) }); await refresh(); } catch (e) { Trio.ui.toast(e.message || 'Could not create agent'); } }); }
  function init() { refresh(); }
  function mount() { init(); }
  function unmount() {}
  Trio.agents = { init, mount, unmount, render, refresh, label, action };
})();
