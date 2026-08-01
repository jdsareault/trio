(() => {
  'use strict';
  const Trio = window.Trio;
  function boot() { ['conversation', 'workspace', 'agents', 'preferences'].forEach(name => Trio[name]?.init?.()); }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot, {once:true}) : boot();
})();
