(() => {
  'use strict';
  const Trio = window.Trio;
  if (!Trio) throw new Error('Composer requires Trio core');
  const { state, api, events, actions } = Trio;
  state.selectedTargets = state.selectedTargets instanceof Set ? state.selectedTargets : new Set();
  state.pendingAttachments = Array.isArray(state.pendingAttachments) ? state.pendingAttachments : [];
  state.composerMode = state.composerMode || 'broadcast';
  state.sttMode = state.sttMode || 'local';
  let recognition = null, recorder = null, stream = null, chunks = [];
  const byId = id => document.getElementById(id);
  const input = () => byId('input');

  function targetName(id) { return state.members?.get(id)?.name || id; }
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
  function updateSendState() { const send = byId('send'); if (send) send.disabled = !validate(); }

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
      input().value = ''; state.pendingAttachments = []; state.composerReply = null; renderAttachments(); updateSendState();
      if (state.dmKey) Trio.workspace?.refreshDm?.(state.dmKey);
      if (result?.message) Trio.conversation?.upsert(result.message);
      events.dispatchEvent(new CustomEvent('sent', { detail: result }));
      return true;
    } catch (error) {
      window.alert('Message not sent: ' + error.message); return false;
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
    recognition.onresult = event => { let interim = ''; for (let i = event.resultIndex; i < event.results.length; i++) event.results[i].isFinal ? finalText += event.results[i][0].transcript : interim += event.results[i][0].transcript; input().value = (input().value + ' ' + finalText + interim).trim(); updateSendState(); };
    recognition.onend = () => { recognition = null; document.body.classList.remove('dictating'); };
    recognition.start(); document.body.classList.add('dictating');
  }
  async function localDictation() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true }); chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => { try { const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }); const result = await fetch(apiUrl('/api/stt/transcribe'), { method: 'POST', headers: { 'Content-Type': audio.type || 'audio/webm' }, body: audio }); const data = await result.json(); if (!result.ok || !data.ok) throw new Error(data.error || 'transcription failed'); input().value = (input().value + ' ' + (data.text || '')).trim(); updateSendState(); } catch (error) { if (window.SpeechRecognition || window.webkitSpeechRecognition) { window.alert((error.message || 'Local transcription failed') + '. Falling back to browser speech recognition.'); browserDictation().catch(fallback => window.alert(fallback.message)); } else window.alert(error.message || 'Transcription failed'); } finally { stopTracks(); document.body.classList.remove('dictating'); } };
    recorder.start(); document.body.classList.add('dictating');
  }
  async function toggleDictation() { if (recognition || recorder?.state === 'recording') return stopDictation(); try { return state.sttMode === 'web' ? browserDictation() : localDictation(); } catch (error) { window.alert(error.message); } }
  function init() {
    const text = input(), sendButton = byId('send'), attach = byId('attach-btn');
    if (!text) return;
    text.addEventListener('input', updateSendState);
    text.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } });
    sendButton?.addEventListener('click', send);
    attach?.addEventListener('click', () => { const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/*'; picker.onchange = () => upload(picker.files[0]).catch(error => window.alert(error.message)); picker.click(); });
    const dictation = Trio.preferences?.read?.().dictation !== false;
    const dictateBtn = byId('dictate-btn');
    if (dictateBtn) { dictateBtn.hidden = !dictation; }
    if (dictation && dictateBtn) { dictateBtn.addEventListener('click', () => toggleDictation().catch(error => window.alert(error?.message || 'Dictation failed'))); }
    renderTargets(); renderAttachments(); updateSendState();
  }
  Object.assign(actions, { sendMessage: send, setTargets, insertTarget, uploadImage: upload, toggleDictation, stopDictation, buildSendPayload });
  Trio.composer = { init, render: renderTargets, send, setTargets, insertTarget, upload, toggleDictation, stopDictation, buildSendPayload };
})();
