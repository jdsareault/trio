(() => {
  'use strict';
  const Trio = window.Trio;
  async function boot() {
    if (!(await Trio.boot())) return;
    ['conversation', 'workspace', 'agents', 'preferences'].forEach(name => Trio[name]?.init?.());
    const app = document.getElementById('app');
    const nav = document.getElementById('nav-toggle');
    const scrim = document.getElementById('scrim-nav');
    const closeNav = () => { app?.classList.remove('nav-open'); if (scrim) scrim.hidden = true; };
    nav?.addEventListener('click', () => { app?.classList.add('nav-open'); if (scrim) scrim.hidden = false; });
    scrim?.addEventListener('click', closeNav);
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot, {once:true}) : boot();
})();
