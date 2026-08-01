(() => {
  'use strict';
  const root = window.Trio = window.Trio || {};
  root.state = root.state || { channel: null, messages: [], meta: null };
  root.events = root.events || new EventTarget();
  root.api = root.api || {
    async get(path) { const response = await fetch(path); if (!response.ok) throw new Error(`${response.status} ${path}`); return response.json(); },
    async post(path, body) { const response = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); if (!response.ok) throw new Error(`${response.status} ${path}`); return response.json(); },
  };
  root.actions = root.actions || {};
})();
