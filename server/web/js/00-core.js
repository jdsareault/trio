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
  let stream;
  function setConnection(text, failed = false) { const el = document.getElementById('h-conn'); if (el) { el.textContent = `● ${text}`; el.classList.toggle('bad', failed); } }
  function startEvents() {
    if (!root.state.channel) return;
    stream?.close(); stream = new EventSource(root.api.url('/api/events'));
    stream.onopen = () => setConnection('live');
    stream.onmessage = event => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'roster' && Array.isArray(payload.members)) root.state.members = new Map(payload.members.map(member => [member.id, member]));
        root.events.dispatchEvent(new CustomEvent(payload.type || 'message', {detail: payload}));
      } catch (error) { console.warn('invalid Trio event', error); }
    };
    stream.onerror = () => setConnection('reconnecting…', true);
  }
  root.startEvents = startEvents;
  root.boot = async function boot() {
    const meta = await root.api.get('/api/meta'); root.state.meta = meta;
    root.state.channel = root.state.channel || meta.default_channel || meta.channel || '';
    if (!root.state.channel && meta.multi) {
      const channels = await root.api.get('/api/channels', false);
      if (channels.channels?.[0]?.code) { location.replace('/?channel=' + encodeURIComponent(channels.channels[0].code)); return false; }
    }
    document.getElementById('h-channel').textContent = root.state.channel ? `trio#${root.state.channel}` : 'Atrium';
    document.getElementById('h-meta').textContent = root.state.channel ? 'Live agent workspace' : 'No channel selected';
    startEvents(); root.events.dispatchEvent(new CustomEvent('boot', {detail: meta})); return true;
  };
})();
