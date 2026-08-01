(() => {
  'use strict';
  const Trio = window.Trio;
  const KEY = 'trio.preferences.v1';
  const defaults = { theme: 'light', accent: 'eucalyptus', font: 'default', compact: false, messageNumbers: false, notifications: true, chime: false, dictation: true };
  function readFromStorage() { try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...defaults }; } }
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
    const next = { ...readFromStorage(), ...change };
    localStorage.setItem(KEY, JSON.stringify(next));
    apply(next);
    Trio.events.dispatchEvent(new CustomEvent('preferences:changed', { detail: next }));
    return next;
  }
  function diagnostics() { return { online: navigator.onLine, channel: (Trio.store ? Trio.store.get('session.channel') : Trio.state.channel) || '', theme: readFromStorage().theme, agents: ((Trio.store ? Trio.store.get('agents.list') : Trio.state.agents) || []).length }; }
  function panel() {
    let n = document.getElementById('trio-preferences');
    if (!n) { n = document.createElement('dialog'); n.id = 'trio-preferences'; document.body.append(n); }
    const p = read();
    n.innerHTML = `<form method="dialog"><button class="modal-close">×</button><h2>Settings & diagnostics</h2><label>Theme <select data-key="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Accent <select data-key="accent"><option>eucalyptus</option><option>indigo</option><option>plum</option></select></label>${['compact','messageNumbers','dictation'].map(k=>`<label><input type="checkbox" data-key="${k}" ${p[k]?'checked':''}> ${k.replace(/([A-Z])/g,' $1')}</label>`).join('')}<label title="Compact mode is not yet implemented" style="opacity:.6"><input type="checkbox" disabled ${p.compact?'checked':''}> compact (not yet implemented)</label><label title="Message numbers are not yet implemented" style="opacity:.6"><input type="checkbox" disabled ${p.messageNumbers?'checked':''}> message numbers (not yet implemented)</label><label title="Browser notifications are not yet implemented" style="opacity:.6"><input type="checkbox" disabled ${p.notifications?'checked':''}> notifications (not yet implemented)</label><label title="Audio chime is not yet implemented" style="opacity:.6"><input type="checkbox" disabled ${p.chime?'checked':''}> chime (not yet implemented)</label><pre>${JSON.stringify(diagnostics(),null,2)}</pre></form>`;
    n.querySelectorAll('[data-key]:not([disabled])').forEach(el => { el.value = el.type === 'checkbox' ? el.checked : p[el.dataset.key]; el.onchange = () => save({ [el.dataset.key]: el.type === 'checkbox' ? el.checked : el.value }); });
    n.showModal();
  }
  function init() { apply(); }
  function mount() { init(); }
  function unmount() {}
  Trio.preferences = { init, mount, unmount, apply, save, read, diagnostics, panel };
})();
