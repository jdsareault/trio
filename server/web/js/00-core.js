(() => {
  'use strict';
  const root = window.Trio = window.Trio || {};
  // Keep the core usable in the intentionally tiny Node DOM harness too;
  // browsers have URLSearchParams, but the runtime only needs this one value.
  const qs = (globalThis.location?.search) || '';
  const parseParam = name => { const m = qs.match(new RegExp('[?&]' + name + '=([^&]+)')); return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; };
  const initialChannel = parseParam('channel');
  const initialDm = parseParam('dm');
  function validDmKey(key) { return typeof key === 'string' && key.length > 0 && key.length <= 512 && /^[A-Za-z0-9_,:-]+$/.test(key); }
  const conversationKind = initialDm ? (validDmKey(initialDm) ? 'dm' : 'unknown') : (initialChannel ? 'channel' : 'unknown');
  const conversationKey = initialDm ? (validDmKey(initialDm) ? initialDm : '') : initialChannel;
  root.state = root.state || { channel: '', messages: new Map(), meta: null, members: new Map() };
  root.state.channel = initialChannel;
  root.state.conversation = { kind: conversationKind, key: conversationKey };
  root.events = root.events || new EventTarget();
  root.api = root.api || {
    url(path, channelScoped = true) {
      if (!channelScoped || !root.state.channel) return path;
      return path + (path.includes('?') ? '&' : '?') + 'channel=' + encodeURIComponent(root.state.channel);
    },
    async get(path, channelScoped = true) { const response = await fetch(this.url(path, channelScoped)); if (!response.ok) throw new Error(`${response.status} ${path}`); return response.json(); },
    async post(path, body, channelScoped = true) { const response = await fetch(this.url(path, channelScoped), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); if (!response.ok) throw new Error(`${response.status} ${path}`); return response.json(); },
  };
  root.actions = root.actions || {};
  root.boot = async function boot(mountFeatures) {
    const meta = await root.api.get('/api/meta'); root.state.meta = meta;
    root.state.operator = meta.operator || null;
    root.state.channel = root.state.channel || meta.default_channel || meta.channel || '';
    if (root.store) { root.store.set('session.operator', root.state.operator); root.store.set('session.channel', root.state.channel); }
    // No channel selected on load; stay on the workspace home view instead of
    // forcing the first channel open.
    document.getElementById('h-channel').textContent = root.state.channel ? `#${root.state.channel}` : 'Atrium';
    document.getElementById('h-meta').textContent = root.state.channel ? 'Live agent workspace' : 'No channel selected';
    mountFeatures?.();
    if (root.startEvents) root.startEvents(root.state.channel);
    // Cross-channel notifications (chime/desktop popup for a channel you're
    // NOT currently viewing) need the workspace-wide SSE stream — but
    // /api/workspace/events is operator-only server-side (403 for anyone
    // else), so only the authenticated operator (loopback/tailscale — the
    // same is_all_seeing check the server itself applies) opens it. A
    // guest/pending viewer opening it anyway would just retry against a
    // permanent 403 forever.
    const isOperator = root.state.operator?.source === 'loopback' || root.state.operator?.source === 'tailscale';
    if (isOperator && root.startWorkspaceEvents) root.startWorkspaceEvents();
    root.events.dispatchEvent(new CustomEvent('boot', {detail: meta})); return true;
  };
})();
