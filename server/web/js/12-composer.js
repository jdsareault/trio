(() => {
  'use strict';
  const Trio = window.Trio;
  if (!Trio) throw new Error('Composer requires Trio core');
  const { state, api, events, actions } = Trio;
  state.selectedTargets = state.selectedTargets instanceof Set ? state.selectedTargets : new Set();
  state.pendingAttachments = Array.isArray(state.pendingAttachments) ? state.pendingAttachments : [];
  state.composerMode = state.composerMode || 'broadcast';
  state.sttMode = state.sttMode || 'local';
  state.drafts = state.drafts || {};
  let recognition = null, recorder = null, stream = null, chunks = [];
  const byId = id => document.getElementById(id);
  const input = () => byId('input');
  function inputValue(newValue) { const el = input(); if (!el) return ''; if (newValue !== undefined) el.value = newValue; return el.value; }

  function targetName(id) { return state.members?.get(id)?.name || id; }
  function conversationId() { return state.dmKey ? 'dm:' + state.dmKey : (state.channel || 'home'); }
  function saveDraft() { const el = input(); if (!el) return; state.drafts[conversationId()] = el.value; }
  function loadDraft() {
    const el = input(); if (!el) return;
    const key = conversationId();
    el.value = state.drafts[key] || '';
    updateSendState();
  }
  function apiUrl(path) {
    if (typeof api.url === 'function') return api.url(path);
    const channel = state.channel || '';
    return channel ? path + (path.includes('?') ? '&' : '?') + 'channel=' + encodeURIComponent(channel) : path;
  }
  function renderTargets() {
    const bar = byId('target-bar'); if (!bar) return;
    bar.replaceChildren();
    state.selectedTargets.forEach(id => {
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'target-chip';
      chip.textContent = '@' + targetName(id) + ' ×'; chip.title = 'Remove target';
      chip.onclick = () => { state.selectedTargets.delete(id); renderTargets(); };
      bar.append(chip);
    });
  }
  function setTargets(ids) { state.selectedTargets = new Set(ids || []); renderTargets(); }
  function insertTarget(id) { if (id) { state.selectedTargets.add(id); renderTargets(); input()?.focus(); } }
  function renderedContent() {
    const text = (input()?.value || '').trim();
    if (!text) return '';
    const names = [...state.selectedTargets].map(id => '@' + targetName(id));
    return (names.length ? names.join(' ') + ' ' : '') + text;
  }
  function validate() { if (state.readOnly) return false; return !!renderedContent() || state.pendingAttachments.length > 0; }
  function buildSendPayload() {
    const body = {
      content: renderedContent(),
      mentions: [...state.selectedTargets],
      attachment_ids: state.pendingAttachments.map(a => a.id).filter(id => Number.isInteger(id) && id > 0),
    };
    if (state.dmKey && state.dmMemberIds?.length) body.recipients = state.dmMemberIds.slice();
    else if (state.dmTargetId) body.recipients = [state.dmTargetId];
    if (state.composerReply?.id) {
      body.reply_to = state.composerReply.id;
      if (state.composerReply.selection) body.selection = state.composerReply.selection;
    }
    return body;
  }
  function updateSendState() { const send = byId('send'); if (send) send.disabled = !validate(); renderReach(); }

  async function upload(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type || '')) throw new Error('Choose a PNG, JPEG, GIF, or WebP image');
    if (file.size > 10 * 1024 * 1024) throw new Error('Image must be 10 MB or smaller');
    const response = await fetch(apiUrl('/api/upload'), {
      method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name || 'image') }, body: file,
    });
    if (!response.ok) throw new Error('upload failed (' + response.status + ')');
    const attachment = await response.json();
    if (!attachment.ok || !Number.isInteger(attachment.id)) throw new Error('Upload did not return an attachment id');
    state.pendingAttachments.push(attachment); renderAttachments(); updateSendState();
  }
  function renderAttachments() {
    const strip = byId('attachment-strip'); if (!strip) return;
    strip.replaceChildren();
    state.pendingAttachments.forEach((attachment, index) => {
      const pill = document.createElement('button'); pill.type = 'button'; pill.className = 'attachment-pill';
      pill.textContent = (attachment.name || attachment.filename || 'attachment') + ' ×';
      pill.onclick = () => { state.pendingAttachments.splice(index, 1); renderAttachments(); updateSendState(); };
      strip.append(pill);
    });
  }
  async function send() {
    if (!validate()) return false;
    const button = byId('send'); if (button) button.disabled = true;
    const body = buildSendPayload();
    if (!body.recipients?.length && state.confirmBroadcast && !window.confirm('Send this message to the channel?')) { updateSendState(); return false; }
    try {
      const result = await api.post(apiUrl('/api/send'), body);
      delete state.drafts[conversationId()];
      inputValue(''); state.pendingAttachments = []; state.composerReply = null; renderAttachments(); updateSendState();
      if (result?.message) Trio.conversation?.upsert(result.message);
      events.dispatchEvent(new CustomEvent('sent', { detail: result }));
      return true;
    } catch (error) {
      Trio.ui.toast('Message not sent: ' + error.message); return false;
    } finally { updateSendState(); }
  }
  function stopTracks() { stream?.getTracks?.().forEach(track => track.stop()); stream = null; }
  function stopDictation() {
    if (recognition) { recognition.stop(); recognition = null; }
    if (recorder?.state === 'recording') recorder.stop();
    stopTracks(); document.body.classList.remove('dictating');
  }
  async function browserDictation() {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) throw new Error('Browser speech recognition is unavailable');
    recognition = new Speech(); recognition.continuous = true; recognition.interimResults = true;
    let finalText = '';
    recognition.onresult = event => { let interim = ''; for (let i = event.resultIndex; i < event.results.length; i++) event.results[i].isFinal ? finalText += event.results[i][0].transcript : interim += event.results[i][0].transcript; inputValue((inputValue() + ' ' + finalText + interim).trim()); updateSendState(); };
    recognition.onend = () => { recognition = null; document.body.classList.remove('dictating'); };
    recognition.start(); document.body.classList.add('dictating');
  }
  async function localDictation() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true }); chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => { try { const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }); const result = await fetch(apiUrl('/api/stt/transcribe'), { method: 'POST', headers: { 'Content-Type': audio.type || 'audio/webm' }, body: audio }); const data = await result.json(); if (!result.ok || !data.ok) throw new Error(data.error || 'transcription failed'); inputValue((inputValue() + ' ' + (data.text || '')).trim()); updateSendState(); } catch (error) { if (window.SpeechRecognition || window.webkitSpeechRecognition) { Trio.ui.toast((error.message || 'Local transcription failed') + '. Falling back to browser speech recognition.'); browserDictation().catch(fallback => Trio.ui.toast(fallback.message)); } else Trio.ui.toast(error.message || 'Transcription failed'); } finally { stopTracks(); document.body.classList.remove('dictating'); } };
    recorder.start(); document.body.classList.add('dictating');
  }
  async function toggleDictation() { if (recognition || recorder?.state === 'recording') return stopDictation(); try { return state.sttMode === 'web' ? browserDictation() : localDictation(); } catch (error) { Trio.ui.toast(error.message); } }
  const domListeners = [];
  let unroute;
  let modeTabs = null;
  let reachPreview = null;
  let ac = null;
  let acIndex = -1;
  let acMatches = [];
  let acToken = null;
  function acEsc(s) { return Trio.markdown.escapeHtml(String(s ?? '')); }
  function acContainer() { return (input() || document.getElementById('input'))?.closest('.composer-shell') || document.body; }
  function closeAutocomplete() { if (ac) { ac.remove(); ac = null; } acIndex = -1; acMatches = []; acToken = null; }
  function findToken(value, caret) {
    let i = caret - 1;
    while (i >= 0 && /[^\s\n]/.test(value[i]) && !/[@#!]/.test(value[i])) i--;
    if (i < 0 || !/[@#!]/.test(value[i])) return null;
    const sigil = value[i];
    if (i > 0 && /[^\s\n]/.test(value[i - 1])) return null;
    return { sigil, start: i, query: value.slice(i + 1, caret) };
  }
  function openAutocomplete(token, matches) {
    closeAutocomplete();
    acToken = token; acMatches = matches; acIndex = 0;
    ac = document.createElement('div'); ac.className = 'ac-pop'; ac.setAttribute('role', 'listbox');
    ac.innerHTML = `<div class="ac-hd">${acEsc(token.sigil === '@' ? 'Mention' : token.sigil === '#' ? 'Reference' : 'Bang')}</div>` +
      matches.map((m, i) => `<button class="ac-opt ${i === 0 ? 'hi' : ''}" data-index="${i}" role="option" aria-selected="${i === 0}"><span class="sig">${acEsc(token.sigil)}</span><span class="nm">${acEsc(m.name)}</span><span class="rl">${acEsc(m.kind || 'agent')}</span></button>`).join('');
    ac.querySelectorAll('button').forEach(b => b.addEventListener('click', () => selectMatch(Number(b.dataset.index))));
    acContainer().append(ac);
  }
  function updateAutocomplete() {
    const el = input(); if (!el) return;
    const token = findToken(el.value, el.selectionStart);
    if (!token || token.query.includes(',')) { closeAutocomplete(); return; }
    const q = token.query.toLowerCase();
    const matches = [...(state.members?.values() || [])]
      .filter(m => m && (m.name || '').toLowerCase().startsWith(q) || (m.id || '').startsWith(q))
      .slice(0, 6)
      .map(m => ({ id: m.id, name: m.name || m.id, kind: m.kind || 'agent' }));
    if (matches.length) openAutocomplete(token, matches); else closeAutocomplete();
  }
  function selectMatch(index) {
    const match = acMatches[index]; const token = acToken; if (!match || !token) return;
    const el = input(); if (!el) return;
    const before = el.value.slice(0, token.start);
    const after = el.value.slice(el.selectionStart);
    if (token.sigil === '@') {
      state.selectedTargets.add(match.id);
      renderTargets();
      el.value = before + after;
      el.selectionStart = el.selectionEnd = token.start;
    } else {
      el.value = before + token.sigil + match.name + ' ' + after;
      el.selectionStart = el.selectionEnd = token.start + 1 + match.name.length + 1;
    }
    closeAutocomplete(); updateSendState(); saveDraft();
  }
  function moveAutocomplete(delta) {
    if (!ac || !acMatches.length) return;
    acIndex = (acIndex + delta + acMatches.length) % acMatches.length;
    const buttons = ac.querySelectorAll('.ac-opt');
    buttons.forEach((b, i) => { b.classList.toggle('hi', i === acIndex); b.setAttribute('aria-selected', String(i === acIndex)); });
  }
  function setMode(mode) {
    state.composerMode = ['broadcast', 'whisper', 'reply'].includes(mode) ? mode : 'broadcast';
    if (modeTabs) modeTabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.composerMode));
    if (state.composerMode !== 'whisper') state.selectedTargets = new Set();
    renderTargets(); updateSendState(); renderReach();
  }
  function renderReach() {
    if (!reachPreview) return;
    const targets = [...state.selectedTargets].map(id => targetName(id));
    if (state.composerMode === 'reply' && state.composerReply) { reachPreview.textContent = 'Replying to message #' + state.composerReply.id; }
    else if (state.composerMode === 'whisper' && targets.length) { reachPreview.textContent = 'Whisper to ' + targets.join(', '); }
    else { reachPreview.textContent = 'Broadcast to the channel'; }
  }
  function renderModeTabs(container) {
    if (!container || !container.querySelector) return;
    if (modeTabs) { modeTabs.remove(); modeTabs = null; }
    modeTabs = document.createElement('div'); modeTabs.className = 'mode-tabs';
    ['broadcast', 'whisper'].forEach(mode => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.mode = mode; b.textContent = mode;
      b.classList.toggle('on', mode === state.composerMode);
      b.addEventListener('click', () => setMode(mode));
      modeTabs.append(b);
    });
    container.insertBefore(modeTabs, container.firstChild);
    reachPreview = document.createElement('div'); reachPreview.className = 'reach-preview'; container.insertBefore(reachPreview, container.firstChild);
  }
  function setInputState(text) {
    if (!text) return;
    text.disabled = !!state.readOnly;
    text.placeholder = state.readOnly ? 'This conversation is archived.' : 'Message…';
  }
  function init() {
    const text = input(), sendButton = byId('send'), attach = byId('attach-btn');
    if (!text) return;
    setInputState(text);
    renderModeTabs(text.parentElement);
    renderTargets(); renderAttachments(); renderReach();
    const onInput = () => { updateSendState(); saveDraft(); updateAutocomplete(); };
    text.addEventListener('input', onInput); domListeners.push([text, 'input', onInput]);
    const onKey = event => {
      if (ac) {
        if (event.key === 'ArrowDown') { event.preventDefault(); moveAutocomplete(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); moveAutocomplete(-1); }
        else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); selectMatch(acIndex); }
        else if (event.key === 'Escape') { event.preventDefault(); closeAutocomplete(); }
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
    };
    text.addEventListener('keydown', onKey); domListeners.push([text, 'keydown', onKey]);
    const sendClick = () => send();
    sendButton?.addEventListener('click', sendClick); if (sendButton) domListeners.push([sendButton, 'click', sendClick]);
    const onAttach = () => { const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/*'; picker.onchange = () => upload(picker.files[0]).catch(error => Trio.ui.toast(error.message)); picker.click(); };
    attach?.addEventListener('click', onAttach); if (attach) domListeners.push([attach, 'click', onAttach]);
    const dictation = Trio.preferences?.read?.().dictation !== false;
    const dictateBtn = byId('dictate-btn');
    if (dictateBtn) { dictateBtn.hidden = !dictation; }
    const onDictate = () => toggleDictation().catch(error => Trio.ui.toast(error?.message || 'Dictation failed'));
    if (dictation && dictateBtn) { dictateBtn.addEventListener('click', onDictate); domListeners.push([dictateBtn, 'click', onDictate]); }
    unroute = Trio.router?.on?.(() => { loadDraft(); setInputState(text); });
    renderTargets(); renderAttachments(); loadDraft();
  }
  function unmount() { domListeners.forEach(([el, type, fn]) => el?.removeEventListener?.(type, fn)); domListeners.length = 0; if (unroute) { unroute(); unroute = null; } if (recorder && recorder.state !== 'inactive') stopDictation(); }
  function mount() { init(); }
  Object.assign(actions, { sendMessage: send, setTargets, insertTarget, uploadImage: upload, toggleDictation, stopDictation, buildSendPayload });
  Trio.composer = { init, mount, unmount, render: renderTargets, send, setTargets, insertTarget, upload, toggleDictation, stopDictation, buildSendPayload };
})();
