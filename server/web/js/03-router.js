(() => {
  'use strict';
  const Trio = window.Trio = window.Trio || {};
  const store = Trio.store;
  const state = Trio.state;
  const handlers = new Set();
  function parse(search) {
    const q = new URLSearchParams(search);
    const dm = q.get('dm') || '';
    const channel = q.get('channel') || '';
    const archived = q.get('archived') === '1';
    if (dm) return { name: archived ? 'audit' : 'dm', params: { key: dm }, title: 'DM ' + dm, readOnly: archived };
    if (channel) return { name: 'channel', params: { code: channel, archived }, title: 'trio#' + channel, readOnly: archived };
    return { name: 'home', params: {}, title: 'Atrium', readOnly: false };
  }
  function serialize(route) {
    if (route.name === 'dm') return '/?dm=' + encodeURIComponent(route.params.key);
    if (route.name === 'audit') return '/?dm=' + encodeURIComponent(route.params.key) + '&archived=1';
    if (route.name === 'channel') return '/?channel=' + encodeURIComponent(route.params.code);
    return '/';
  }
  function apply(route) {
    const current = store ? store.getState() : state;
    current.route = route;
    if (store) store.set('route', route);
    handlers.forEach(fn => { try { fn(route); } catch (e) { console.warn('router handler error', e); } });
  }
  function navigate(name, params = {}, { replace = false, title = '' } = {}) {
    const route = { name, params, title: title || name, readOnly: name === 'audit' || params.archived };
    apply(route);
    const url = serialize(route);
    if (replace) history.replaceState(route, '', url); else history.pushState(route, '', url);
  }
  let popHandler, clickHandler;
  function init() {
    const route = parse(location.search);
    apply(route);
    popHandler = event => { const r = event.state || parse(location.search); apply(r); };
    clickHandler = event => {
      const a = event.target.closest('a[data-route]');
      if (a) { event.preventDefault(); const [name, ...rest] = a.dataset.route.split(':'); const params = name === 'channel' ? { code: rest.join(':') } : { key: rest.join(':') }; navigate(name, params); }
    };
    addEventListener('popstate', popHandler);
    addEventListener('click', clickHandler);
  }
  function mount() { init(); }
  function unmount() { if (popHandler) removeEventListener('popstate', popHandler); if (clickHandler) removeEventListener('click', clickHandler); popHandler = clickHandler = null; }
  Trio.router = { init, mount, unmount, navigate, replace: (name, params) => navigate(name, params, { replace: true }), parse, serialize, on: (fn) => { handlers.add(fn); return () => handlers.delete(fn); }, current: () => (store ? store.getState().route : state.route) };
})();
