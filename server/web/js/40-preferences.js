(() => {
  'use strict';
  const Trio = window.Trio;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const KEY = 'trio.preferences.v1';
  // Each preset pairs a background family with an accent that reads clearly
  // against it (cool bg -> warm accent, warm bg -> cool accent) instead of
  // leaving every theme stuck on whichever accent was picked last.
  const themes = [
    { id: 'light-porcelain', mode: 'light', label: 'Porcelain', accent: 'eucalyptus' },
    { id: 'light-meadow', mode: 'light', label: 'Meadow', accent: 'plum' },
    { id: 'light-sand', mode: 'light', label: 'Sand', accent: 'indigo' },
    { id: 'light-lilac', mode: 'light', label: 'Lilac', accent: 'eucalyptus' },
    { id: 'light-solar', mode: 'light', label: 'Solar', accent: 'indigo' },
    { id: 'dark-charcoal', mode: 'dark', label: 'Charcoal', accent: 'eucalyptus' },
    { id: 'dark-midnight', mode: 'dark', label: 'Midnight', accent: 'plum' },
    { id: 'dark-forest', mode: 'dark', label: 'Forest', accent: 'plum' },
    { id: 'dark-plum', mode: 'dark', label: 'Plum', accent: 'eucalyptus' },
    { id: 'dark-slate', mode: 'dark', label: 'Slate', accent: 'indigo' },
  ];
  const accents = [
    { id: 'eucalyptus', label: 'Eucalyptus' },
    { id: 'indigo', label: 'Indigo' },
    { id: 'plum', label: 'Plum' },
  ];
  const lightThemes = themes.filter(theme => theme.mode === 'light');
  const darkThemes = themes.filter(theme => theme.mode === 'dark');
  const themeIds = themes.map(theme => theme.id);
  const lightThemeIds = lightThemes.map(theme => theme.id);
  const darkThemeIds = darkThemes.map(theme => theme.id);
  const accentIds = accents.map(a => a.id);
  const defaults = { theme: 'light-porcelain', lightTheme: 'light-porcelain', darkTheme: 'dark-charcoal', accent: 'eucalyptus', lightAccent: 'eucalyptus', darkAccent: 'eucalyptus', font: 'default', compact: false, messageNumbers: false, notifications: true, chime: false, dictation: true };
  const schema = { theme: themeIds, lightTheme: lightThemeIds, darkTheme: darkThemeIds, accent: accentIds, lightAccent: accentIds, darkAccent: accentIds, font: ['default','serif','mono'], compact: 'boolean', messageNumbers: 'boolean', notifications: 'boolean', chime: 'boolean', dictation: 'boolean' };
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
      // Migrate prefs saved before per-theme accent pairing existed: give
      // each mode the accent its preset was designed with, not a stale
      // single global accent that may clash with the current theme.
      if (!raw.lightAccent) next.lightAccent = (themes.find(t => t.id === next.lightTheme) || {}).accent || defaults.lightAccent;
      if (!raw.darkAccent) next.darkAccent = (themes.find(t => t.id === next.darkTheme) || {}).accent || defaults.darkAccent;
      if (!raw.accent) next.accent = next.theme && next.theme.startsWith('dark-') ? next.darkAccent : next.lightAccent;
      for (const k of Object.keys(schema)) next[k] = cast(k, next[k]);
      return next;
    } catch { return { ...defaults }; }
  }
  function read() { return Trio.store ? Trio.store.get('preferences') : (Trio.state.preferences || readFromStorage()); }
  function requestNotifications() { if (typeof Notification !== 'undefined' && Notification.permission === 'default') { Notification.requestPermission().then(p => { if (p !== 'granted') save({ notifications: false }); }); } }
  function apply(next = readFromStorage()) {
    const root = document.documentElement;
    root.dataset.theme = next.theme;
    root.dataset.accent = next.accent;
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
    return save(selected.mode === 'light'
      ? { theme, lightTheme: theme, accent: selected.accent, lightAccent: selected.accent }
      : { theme, darkTheme: theme, accent: selected.accent, darkAccent: selected.accent });
  }
  function selectAccent(accent) {
    if (!accentIds.includes(accent)) return read();
    const current = read();
    const currentTheme = themes.find(theme => theme.id === current.theme);
    return save(currentTheme?.mode === 'dark' ? { accent, darkAccent: accent } : { accent, lightAccent: accent });
  }
  function toggle() {
    const current = read();
    const currentTheme = themes.find(theme => theme.id === current.theme);
    return save(currentTheme?.mode === 'dark'
      ? { theme: current.lightTheme, accent: current.lightAccent }
      : { theme: current.darkTheme, accent: current.darkAccent });
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
    const themeRow = document.createElement('div'); themeRow.className = 'pref-row pref-row-themes'; themeRow.innerHTML = '<div class="pr-txt"><div class="l">Theme presets</div><div class="d">Choose the light and dark themes used by the toggle.</div></div>';
    const themeChoices = document.createElement('div'); themeChoices.className = 'theme-choice';
    [['lightTheme', 'Light default', lightThemes], ['darkTheme', 'Dark default', darkThemes]].forEach(([key, label, options]) => {
      const group = document.createElement('div'); group.className = 'theme-choice-group';
      group.innerHTML = `<div class="theme-group-label">${label}</div>`;
      const choices = document.createElement('div'); choices.className = 'theme-choice';
      options.forEach(option => { const b = document.createElement('button'); b.type = 'button'; b.className = 'theme-opt' + (p[key] === option.id ? ' on' : ''); b.setAttribute('aria-pressed', p[key] === option.id ? 'true' : 'false'); b.innerHTML = `<span class="swatch" data-theme="${option.id}" data-accent="${option.accent}"><span class="a"></span><span class="b"></span></span><span class="tl">${option.label}</span>`; b.addEventListener('click', () => { selectTheme(option.id); renderPage(panel); }); choices.append(b); });
      group.append(choices); themeChoices.append(group);
    });
    themeRow.append(themeChoices); appearance.append(themeRow);
    const currentMode = (themes.find(theme => theme.id === p.theme) || {}).mode === 'dark' ? 'dark' : 'light';
    const accentRow = document.createElement('div'); accentRow.className = 'pref-row pref-row-accent'; accentRow.innerHTML = '<div class="pr-txt"><div class="l">Accent</div><div class="d">Overrides the accent that the current theme preset picked for you.</div></div>';
    const accentDots = document.createElement('div'); accentDots.className = 'accent-dots';
    accents.forEach(a => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'accent-dot' + (p.accent === a.id ? ' on' : ''); b.setAttribute('aria-pressed', p.accent === a.id ? 'true' : 'false'); b.setAttribute('aria-label', a.label); b.title = a.label;
      b.dataset.accent = a.id; if (currentMode === 'dark') b.dataset.theme = 'dark';
      b.innerHTML = '<span class="in"></span>';
      b.addEventListener('click', () => { selectAccent(a.id); renderPage(panel); });
      accentDots.append(b);
    });
    accentRow.append(accentDots); appearance.append(accentRow);
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
  Trio.preferences = { init, mount, unmount, apply, save, selectTheme, selectAccent, toggle, reset, read, diagnostics, renderPage, themes, lightThemes, darkThemes, accents };
})();
