(() => {
  'use strict';
  const Trio = window.Trio;
  async function boot() {
    if (!(await Trio.boot())) return;
    ['conversation', 'workspace', 'agents', 'preferences', 'router'].forEach(name => Trio[name]?.init?.());
    const app = document.getElementById('app');
    const nav = document.getElementById('nav-toggle');
    const scrim = document.getElementById('scrim-nav');
    const closeNav = () => { app?.classList.remove('nav-open'); if (scrim) scrim.hidden = true; };
    nav?.addEventListener('click', () => { app?.classList.add('nav-open'); if (scrim) scrim.hidden = false; });
    scrim?.addEventListener('click', closeNav);
    const themeToggle = document.getElementById('theme-toggle');
    themeToggle?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      Trio.preferences?.save?.({ theme: next });
    });
    ['search-btn', 'details-btn'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.disabled = true; btn.title = (id === 'search-btn' ? 'Search' : 'Conversation details') + ' — not yet implemented'; }
    });
    const archiveBtn = document.getElementById('archive-btn');
    archiveBtn?.addEventListener('click', () => Trio.workspace?.archiveCurrent?.());
    if (Trio.state.conversation?.kind === 'dm' && Trio.workspace?.openDmByKey) {
      Trio.workspace.openDmByKey(Trio.state.conversation.key);
    }
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot, {once:true}) : boot();
})();
