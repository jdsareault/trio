(() => {
  'use strict';
  const Trio = window.Trio = window.Trio || {};
  const events = Trio.events = Trio.events || new EventTarget();
  let stream;
  let lastId = null;
  let state = 'connecting';
  function setConnection(text, failed = false) {
    const el = document.getElementById('h-conn');
    if (el) { el.textContent = `● ${text}`; el.classList.toggle('bad', failed); }
  }
  function notify(newState, detail = {}) {
    state = newState;
    events.dispatchEvent(new CustomEvent('connection', { detail: { state, ...detail } }));
  }
  function dispatch(payload) {
    if (payload == null) return;
    const type = payload.type || 'message';
    if (type === 'roster' && Array.isArray(payload.members)) {
      Trio.state.members = new Map(payload.members.map(member => [member.id, member]));
    }
    events.dispatchEvent(new CustomEvent(type, { detail: payload }));
    if (payload.id != null && (type === 'message' || type === 'message_update')) { lastId = payload.id; }
  }
  function onMessage(event) {
    try {
      const payload = JSON.parse(event.data);
      if (Array.isArray(payload)) { payload.forEach(dispatch); }
      else if (Array.isArray(payload.messages)) { payload.messages.forEach(dispatch); }
      else { dispatch(payload); }
    } catch (error) { console.warn('invalid Trio event', error); }
  }
  function startEvents(channel = null) {
    if (!channel) { notify('offline', { reason: 'no channel' }); return; }
    stream?.close();
    notify('connecting');
    stream = new EventSource(Trio.api.url('/api/events'));
    stream.onopen = () => { setConnection('live'); notify('live'); };
    stream.onmessage = onMessage;
    stream.onerror = () => { setConnection('reconnecting…', true); notify('reconnecting'); };
  }
  let workspaceStream;
  function startWorkspaceEvents() {
    workspaceStream?.close();
    notify('workspace:connecting');
    workspaceStream = new EventSource('/api/workspace/events');
    workspaceStream.onopen = () => { notify('workspace:live'); };
    workspaceStream.onmessage = onMessage;
    workspaceStream.onerror = () => { notify('workspace:reconnecting'); };
  }
  function stopWorkspaceEvents() { workspaceStream?.close(); workspaceStream = null; notify('workspace:offline'); }
  function stopEvents() { stream?.close(); stream = null; notify('offline', { reason: 'stopped' }); }
  Trio.startEvents = startEvents;
  Trio.stopEvents = stopEvents;
  Trio.startWorkspaceEvents = startWorkspaceEvents;
  Trio.stopWorkspaceEvents = stopWorkspaceEvents;
  Trio.events = events;
})();
