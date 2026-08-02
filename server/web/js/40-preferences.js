(() => {
  'use strict';
  const Trio = window.Trio;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const KEY = 'trio.preferences.v1';
  // Each preset is a self-contained design — background family AND accent —
  // so there's nothing left to pick independently. Light presets stay near
  // white/off-white (color lives in the accent, not a full-page tint); dark
  // presets can lean into a moodier color cast.
  const themes = [
    { id: 'light-bone', mode: 'light', label: 'Bone' },
    { id: 'light-cloud', mode: 'light', label: 'Cloud' },
    { id: 'light-birch', mode: 'light', label: 'Birch' },
    { id: 'light-mist', mode: 'light', label: 'Mist' },
    { id: 'light-dune', mode: 'light', label: 'Dune' },
    { id: 'dark-graphite', mode: 'dark', label: 'Graphite' },
    { id: 'dark-midnight', mode: 'dark', label: 'Midnight' },
    { id: 'dark-slate', mode: 'dark', label: 'Slate' },
    { id: 'dark-espresso', mode: 'dark', label: 'Espresso' },
    { id: 'dark-moss', mode: 'dark', label: 'Moss' },
  ];
  const lightThemes = themes.filter(theme => theme.mode === 'light');
  const darkThemes = themes.filter(theme => theme.mode === 'dark');
  const themeIds = themes.map(theme => theme.id);
  const lightThemeIds = lightThemes.map(theme => theme.id);
  const darkThemeIds = darkThemes.map(theme => theme.id);
  const defaults = { theme: 'light-bone', lightTheme: 'light-bone', darkTheme: 'dark-graphite', font: 'default', compact: false, messageNumbers: false, notifications: true, chime: false, dictation: true };
  const schema = { theme: themeIds, lightTheme: lightThemeIds, darkTheme: darkThemeIds, font: ['default','serif','mono'], compact: 'boolean', messageNumbers: 'boolean', notifications: 'boolean', chime: 'boolean', dictation: 'boolean' };
  function cast(key, value) {
    if (schema[key] === 'boolean') return !!value;
    if (Array.isArray(schema[key])) return schema[key].includes(value) ? value : defaults[key];
    return value ?? defaults[key];
  }
  function readFromStorage() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      const legacyTheme = raw.theme === 'dark' ? defaults.darkTheme : raw.theme === 'light' ? defaults.lightTheme : null;
      const next = { ...defaults, ...raw };
      if (legacyTheme) next.theme = legacyTheme;
      if (!raw.lightTheme) next.lightTheme = raw.theme && raw.theme.startsWith('light-') ? raw.theme : defaults.lightTheme;
      if (!raw.darkTheme) next.darkTheme = raw.theme && raw.theme.startsWith('dark-') ? raw.theme : defaults.darkTheme;
      for (const k of Object.keys(schema)) next[k] = cast(k, next[k]);
      return next;
    } catch { return { ...defaults }; }
  }
  function read() { return Trio.store ? Trio.store.get('preferences') : (Trio.state.preferences || readFromStorage()); }
  function requestNotifications() { if (typeof Notification !== 'undefined' && Notification.permission === 'default') { Notification.requestPermission().then(p => { if (p !== 'granted') save({ notifications: false }); }); } }
  function apply(next = readFromStorage()) {
    const root = document.documentElement;
    root.dataset.theme = next.theme;
    root.dataset.font = next.font;
    document.body?.classList.toggle('compact', !!next.compact);
    document.body?.classList.toggle('message-numbers', !!next.messageNumbers);
    if (next.notifications) requestNotifications();
    if (Trio.store) Trio.store.set('preferences', next);
    else Trio.state.preferences = next;
    return next;
  }
  function save(change) {
    const current = read(); const next = { ...current };
    for (const k of Object.keys(schema)) if (change[k] !== undefined) next[k] = cast(k, change[k]);
    localStorage.setItem(KEY, JSON.stringify(next));
    apply(next);
    Trio.events.dispatchEvent(new CustomEvent('preferences:changed', { detail: next }));
    return next;
  }
  function selectTheme(theme) {
    const selected = themes.find(option => option.id === theme);
    if (!selected) return read();
    return save(selected.mode === 'light' ? { theme, lightTheme: theme } : { theme, darkTheme: theme });
  }
  function toggle() {
    const current = read();
    const currentTheme = themes.find(theme => theme.id === current.theme);
    return save({ theme: currentTheme?.mode === 'dark' ? current.lightTheme : current.darkTheme });
  }
  function reset() {
    localStorage.removeItem(KEY);
    const next = { ...defaults };
    apply(next);
    // Mirror save(): apply() alone doesn't notify listeners (composer
    // dictation visibility, notification wiring), so a reset left them stale
    // until the next save(). Dispatch the same event so they react immediately.
    Trio.events.dispatchEvent(new CustomEvent('preferences:changed', { detail: next }));
    return next;
  }
  function diagnostics() { const note = typeof Notification !== 'undefined' ? Notification.permission : 'unavailable'; return { online: navigator.onLine ? 'yes' : 'no', channel: (Trio.store ? Trio.store.get('session.channel') : Trio.state.channel) || '', theme: readFromStorage().theme, agents: ((Trio.store ? Trio.store.get('agents.list') : Trio.state.agents) || []).length, notifications: note, stt: Trio.state.sttHealth || 'checking' }; }
  async function checkStt() {
    try { const h = await Trio.api.get('/api/stt/health'); Trio.state.sttHealth = h && h.ok ? 'ready' : 'unavailable'; }
    catch { Trio.state.sttHealth = 'unavailable'; }
  }
  function renderPage(panel) {
    panel.replaceChildren();
    const p = read();
    const hero = document.createElement('div'); hero.className = 'view-hero'; hero.innerHTML = '<h2>Settings & diagnostics</h2><p>Shape how Atrium looks, sounds, and keeps you informed.</p>';
    const appearance = document.createElement('section'); appearance.className = 'pref-group'; appearance.innerHTML = '<h3>Appearance</h3>';
    const themeRow = document.createElement('div'); themeRow.className = 'pref-row pref-row-themes'; themeRow.innerHTML = '<div class="pr-txt"><div class="l">Theme presets</div><div class="d">Choose the light and dark themes used by the toggle. Each preset sets its own accent.</div></div>';
    const themeChoices = document.createElement('div'); themeChoices.className = 'theme-choice';
    [['lightTheme', 'Light default', lightThemes], ['darkTheme', 'Dark default', darkThemes]].forEach(([key, label, options]) => {
      const group = document.createElement('div'); group.className = 'theme-choice-group';
      group.innerHTML = `<div class="theme-group-label">${label}</div>`;
      const choices = document.createElement('div'); choices.className = 'theme-choice';
      options.forEach(option => { const b = document.createElement('button'); b.type = 'button'; b.className = 'theme-opt' + (p[key] === option.id ? ' on' : ''); b.setAttribute('aria-pressed', p[key] === option.id ? 'true' : 'false'); b.innerHTML = `<span class="swatch" data-theme="${option.id}"><span class="a"></span><span class="b"></span></span><span class="tl">${option.label}</span>`; b.addEventListener('click', () => { selectTheme(option.id); renderPage(panel); }); choices.append(b); });
      group.append(choices); themeChoices.append(group);
    });
    themeRow.append(themeChoices); appearance.append(themeRow);
    const behavior = document.createElement('section'); behavior.className = 'pref-group'; behavior.innerHTML = '<h3>Workspace behavior</h3>';
    const behaviors = [['compact','Compact messages','Tighter spacing for dense, high-volume channels.'],['messageNumbers','Message numbers','Show message IDs beside timestamps.'],['notifications','Desktop notifications','Notify me when an agent mentions me or finishes a task.'],['chime','Notification chime','Play a short sound with desktop notifications.'],['dictation','Dictation','Keep the microphone control available in the composer.']];
    behaviors.forEach(([key,label,description]) => { const row = document.createElement('div'); row.className = 'pref-row'; const text = document.createElement('div'); text.className = 'pr-txt'; text.innerHTML = `<div class="l">${esc(label)}</div><div class="d">${esc(description)}</div>`; const toggle = document.createElement('label'); toggle.className = 'switch'; toggle.innerHTML = `<input type="checkbox" ${p[key] ? 'checked' : ''} aria-label="${esc(label)}"><span class="track"></span><span class="knob"></span>`; toggle.querySelector('input').addEventListener('change', event => save({[key]:event.target.checked})); row.append(text, toggle); behavior.append(row); });
    const diagnosticsGroup = document.createElement('section'); diagnosticsGroup.className = 'pref-group'; diagnosticsGroup.innerHTML = '<h3>Diagnostics</h3>';
    const diagnostic = diagnostics(); Object.entries(diagnostic).forEach(([key,value]) => { const row = document.createElement('div'); row.className = 'diag-card'; row.innerHTML = `<span class="di ${key === 'online' || key === 'stt' ? 'ok' : 'off'}">●</span><div class="dtxt"><div class="dl">${esc(key.replace(/([A-Z])/g,' $1'))}<span class="stat-chip-sm ${key === 'online' ? 'ok' : 'off'}">${esc(String(value))}</span></div></div>`; diagnosticsGroup.append(row); });
    const resetButton = document.createElement('button'); resetButton.type = 'button'; resetButton.className = 'reset-prefs'; resetButton.textContent = 'Reset to defaults'; resetButton.addEventListener('click', () => { reset(); renderPage(panel); }); diagnosticsGroup.append(resetButton);
    panel.append(hero, appearance, behavior, diagnosticsGroup);
  }
  function init() { apply(); }
  function mount() { init(); }
  function unmount() {}
  Trio.preferences = { init, mount, unmount, apply, save, selectTheme, toggle, reset, read, diagnostics, renderPage, themes, lightThemes, darkThemes };
})();
