(() => {
  'use strict';
  const Trio = window.Trio;
  const KEY = 'trio.preferences.v1';
  const defaults = { theme: 'light', accent: 'eucalyptus', font: 'default', compact: false, messageNumbers: false, notifications: true, chime: false, dictation: true };
  const schema = { theme: ['light','dark'], accent: ['eucalyptus','indigo','plum'], font: ['default','serif','mono'], compact: 'boolean', messageNumbers: 'boolean', notifications: 'boolean', chime: 'boolean', dictation: 'boolean' };
  function cast(key, value) {
    if (schema[key] === 'boolean') return !!value;
    if (Array.isArray(schema[key])) return schema[key].includes(value) ? value : defaults[key];
    return value ?? defaults[key];
  }
  function readFromStorage() { try { const raw = JSON.parse(localStorage.getItem(KEY) || '{}'); const next = {}; for (const k of Object.keys(schema)) next[k] = cast(k, raw[k]); return { ...defaults, ...next }; } catch { return { ...defaults }; } }
  function read() { return Trio.store ? Trio.store.get('preferences') : (Trio.state.preferences || readFromStorage()); }
  function apply(next = readFromStorage()) {
    const root = document.documentElement;
    root.dataset.theme = next.theme;
    root.dataset.accent = next.accent;
    root.dataset.font = next.font;
    document.body?.classList.toggle('compact', !!next.compact);
    document.body?.classList.toggle('message-numbers', !!next.messageNumbers);
    if (Trio.store) Trio.store.set('preferences', next);
    else Trio.state.preferences = next;
    return next;
  }
  function save(change) {
    const current = readFromStorage(); const next = { ...current };
    for (const k of Object.keys(schema)) if (change[k] !== undefined) next[k] = cast(k, change[k]);
    localStorage.setItem(KEY, JSON.stringify(next));
    apply(next);
    Trio.events.dispatchEvent(new CustomEvent('preferences:changed', { detail: next }));
    return next;
  }
  function reset() { localStorage.removeItem(KEY); const next = { ...defaults }; apply(next); return next; }
  function diagnostics() { return { online: navigator.onLine, channel: (Trio.store ? Trio.store.get('session.channel') : Trio.state.channel) || '', theme: readFromStorage().theme, agents: ((Trio.store ? Trio.store.get('agents.list') : Trio.state.agents) || []).length }; }
  function panel() {
    let n = document.getElementById('trio-preferences');
    if (!n) { n = document.createElement('dialog'); n.id = 'trio-preferences'; document.body.append(n); }
    const p = read();
    n.innerHTML = `<form method="dialog"><button class="modal-close">×</button><h2>Settings & diagnostics</h2><label>Theme <select data-key="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Accent <select data-key="accent"><option>eucalyptus</option><option>indigo</option><option>plum</option></select></label><label>Font <select data-key="font"><option value="default">Default</option><option value="serif">Serif</option><option value="mono">Mono</option></select></label>${['compact','messageNumbers','notifications','chime','dictation'].map(k=>`<label><input type="checkbox" data-key="${k}" ${p[k]?'checked':''}> ${k.replace(/([A-Z])/g,' $1').toLowerCase()}</label>`).join('')}<pre>${JSON.stringify(diagnostics(),null,2)}</pre><button type="button" class="reset-prefs">Reset to defaults</button></form>`;
    n.querySelectorAll('[data-key]:not([disabled])').forEach(el => { if (el.type === 'checkbox') el.checked = !!p[el.dataset.key]; else el.value = p[el.dataset.key]; el.onchange = () => save({ [el.dataset.key]: el.type === 'checkbox' ? el.checked : el.value }); });
    n.querySelector('.reset-prefs')?.addEventListener('click', () => { reset(); panel(); });
    n.showModal();
  }
  function init() { apply(); }
  function mount() { init(); }
  function unmount() {}
  Trio.preferences = { init, mount, unmount, apply, save, reset, read, diagnostics, panel };
})();
