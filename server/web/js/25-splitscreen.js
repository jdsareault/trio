(() => {
  'use strict';
  const Trio = window.Trio;
  const state = Trio.state;
  const MAX_PANES = 6;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const themes = [['sage','Sage'],['sky','Sky'],['coral','Coral'],['violet','Violet']];
  const split = { active: false, panes: [], streams: new Map() };
  const $ = id => document.getElementById(id);
  const paneId = target => `${target.kind}:${target.key}`;
  const targets = () => {
    const channels = (state.channels || []).filter(c => !c.archived).map(c => ({kind:'channel',key:c.code,title:'#' + c.code,channel:c.code}));
    const dms = (state.dms?.your_dms || []).map(d => ({kind:'dm',key:d.key,title:'DM ' + (d.name || d.key),channel:d.channel || '',memberIds:d.member_ids || [],dm:d}));
    return channels.concat(dms);
  };
  function currentTarget() {
    if (state.dmKey) return {kind:'dm',key:state.dmKey,title:'DM ' + (state.dmName || state.dmKey),channel:state.channel || '',memberIds:state.dmMemberIds || []};
    if (state.channel) return {kind:'channel',key:state.channel,title:'#' + state.channel,channel:state.channel};
    return targets()[0] || {kind:'channel',key:'',title:'Choose a chat',channel:''};
  }
  function closeStream(id) { const stream = split.streams.get(id); if (stream) stream.close(); split.streams.delete(id); }
  function messageMatches(message, pane) {
    if (!message || message.id == null) return false;
    if (pane.target.kind === 'channel') return !message.recipients?.length && (!message.channel || message.channel === pane.target.channel);
    const recipients = new Set([...(message.recipients || []), message.member_id].filter(Boolean));
    const expected = new Set([...(pane.target.memberIds || []), state.operator?.id || state.meta?.operator?.id].filter(Boolean));
    return message.is_dm || (expected.size && [...expected].every(id => recipients.has(id)));
  }
  function renderMessage(message, pane) {
    const own = message.member_id && message.member_id === (state.operator?.id || state.meta?.operator?.id);
    const name = message.member_name || state.members?.get?.(message.member_id)?.name || message.member_id || 'Agent';
    const body = message.retracted_at ? '[deleted]' : (message.content || '');
    const article = document.createElement('article'); article.className = 'split-message' + (own ? ' mine' : '');
    article.innerHTML = `<span class="split-avatar">${esc(name.slice(0,2).toUpperCase())}</span><div class="split-bubble"><span class="split-meta">${esc(name)}${message.created_at ? ' · ' + esc(new Date(message.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})) : ''}</span><div>${Trio.markdown?.renderMarkdown ? Trio.markdown.renderMarkdown(body) : esc(body)}</div></div>`;
    return article;
  }
  function optionMarkup(selected) {
    return `<option value="">Choose chat…</option>` + targets().map(target => `<option value="${esc(paneId(target))}" ${paneId(target) === selected ? 'selected' : ''}>${esc(target.title)}</option>`).join('');
  }
  function renderPane(pane) {
    const wrap = document.createElement('article'); wrap.className = `split-pane theme-${pane.theme}`; wrap.dataset.paneId = pane.id;
    const title = document.createElement('h2'); title.textContent = pane.target.title;
    const head = document.createElement('header'); head.className = 'split-pane-head';
    const select = document.createElement('select'); select.setAttribute('aria-label', 'Choose conversation'); select.innerHTML = optionMarkup(pane.id);
    select.addEventListener('change', () => { const target = targets().find(t => paneId(t) === select.value); if (target) setTarget(pane, target); });
    const theme = document.createElement('select'); theme.setAttribute('aria-label', 'Pane theme'); theme.innerHTML = themes.map(([id,label]) => `<option value="${id}" ${id === pane.theme ? 'selected' : ''}>${label}</option>`).join('');
    theme.addEventListener('change', () => { pane.theme = theme.value; render(); });
    const close = document.createElement('button'); close.type = 'button'; close.className = 'split-pane-tool'; close.setAttribute('aria-label', 'Remove chat'); close.textContent = '×'; close.addEventListener('click', () => removePane(pane.id));
    head.append(title, select, theme, close); wrap.append(head);
    const list = document.createElement('div'); list.className = 'split-pane-messages';
    const messages = pane.messages.filter(message => messageMatches(message, pane)).sort((a,b) => Number(a.id) - Number(b.id)).slice(-200);
    if (!messages.length) { const empty = document.createElement('p'); empty.className = 'split-empty'; empty.textContent = pane.loading ? 'Loading messages…' : 'No messages yet.'; list.append(empty); }
    else messages.forEach(message => list.append(renderMessage(message, pane)));
    wrap.append(list);
    const composer = document.createElement('form'); composer.className = 'split-pane-compose'; composer.innerHTML = '<input aria-label="Message this chat" placeholder="Message…"><button type="submit">Send</button>';
    composer.addEventListener('submit', async event => { event.preventDefault(); const input = composer.querySelector('input'); const content = input.value.trim(); if (!content) return; const payload = {content}; if (pane.target.kind === 'channel') payload.channel = pane.target.channel; else { payload.recipients = pane.target.memberIds.slice(); if (pane.target.channel) payload.channel = pane.target.channel; } const sendUrl = pane.target.channel ? '/api/send?channel=' + encodeURIComponent(pane.target.channel) : '/api/send'; try { const result = await Trio.api.post(sendUrl, payload, false); if (result?.message) { pane.messages.push(result.message); render(); } input.value = ''; } catch (error) { Trio.ui?.toast?.(error.message || 'Could not send message'); } });
    wrap.append(composer); return wrap;
  }
  function setTarget(pane, target) { closeStream(pane.id); pane.id = paneId(target); pane.target = target; pane.messages = []; pane.loading = true; listen(pane); render(); }
  function listen(pane) {
    if (!pane.target.channel) { pane.loading = false; return; }
    const stream = new EventSource(`/api/events?channel=${encodeURIComponent(pane.target.channel)}`); split.streams.set(pane.id, stream);
    stream.onmessage = event => { try { const payload = JSON.parse(event.data); const incoming = Array.isArray(payload) ? payload : (payload.messages || [payload.message || payload]); incoming.filter(m => messageMatches(m, pane) && !pane.messages.some(old => old.id === m.id)).forEach(m => pane.messages.push(m)); pane.loading = false; render(); } catch (_) {} };
    stream.onerror = () => { pane.loading = false; render(); };
  }
  function addPane(target = targets()[0]) { if (!target || split.panes.length >= MAX_PANES || split.panes.some(p => p.id === paneId(target))) return; const pane = {id:paneId(target), target, theme:themes[split.panes.length % themes.length][0], messages:[], loading:true}; split.panes.push(pane); listen(pane); render(); }
  function removePane(id) { closeStream(id); split.panes = split.panes.filter(p => p.id !== id); if (!split.panes.length) close(); else render(); }
  function render() { const view = $('split-view'); if (!view || !split.active) return; view.replaceChildren(); const grid = document.createElement('div'); grid.className = 'split-grid'; split.panes.forEach(pane => grid.append(renderPane(pane))); view.append(grid); if (split.panes.length < MAX_PANES) { const add = document.createElement('button'); add.type = 'button'; add.className = 'split-add'; add.textContent = '+ Add another channel or DM'; add.addEventListener('click', () => addPane(targets().find(t => !split.panes.some(p => p.id === paneId(t))))); view.append(add); } }
  function open() { if (!split.active) { split.active = true; const target = currentTarget(); addPane(target); } const shell = document.querySelector('.conversation-shell'); shell?.classList.add('splitscreen-active'); $('split-view')?.removeAttribute('hidden'); render(); }
  function close() { split.active = false; split.panes.forEach(pane => closeStream(pane.id)); split.panes = []; document.querySelector('.conversation-shell')?.classList.remove('splitscreen-active'); $('split-view')?.setAttribute('hidden',''); }
  function toggle() { if (split.active) close(); else open(); }
  function mount() { Trio.splitscreen = {open, close, toggle, addPane, render}; }
  Trio.splitscreen = {open, close, toggle, addPane, render};
})();
