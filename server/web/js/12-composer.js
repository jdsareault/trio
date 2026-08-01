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
  function apiUrl(path) { return typeof api.url === 'function' ? api.url(path) : path; }
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
  function validate() { return !!renderedContent() || state.pendingAttachments.length > 0; }
  function updateSendState() { const send = byId('send'); if (send) send.disabled = !validate(); }

  async function upload(file) {
    if (!file) return;
    const form = new FormData(); form.append('file', file, file.name);
    const response = await fetch(apiUrl('/api/upload'), { method: 'POST', body: form });
    if (!response.ok) throw new Error('upload failed (' + response.status + ')');
    const attachment = await response.json(); state.pendingAttachments.push(attachment); renderAttachments(); updateSendState();
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
    const body = { content: renderedContent(), attachments: state.pendingAttachments, target_ids: [...state.selectedTargets] };
    try {
      const result = await api.post(apiUrl('/api/send'), body);
      input().value = ''; state.pendingAttachments = []; renderAttachments(); updateSendState();
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
    recorder.onstop = async () => { try { const form = new FormData(); form.append('audio', new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), 'dictation.webm'); const result = await fetch(apiUrl('/api/stt'), { method: 'POST', body: form }); const data = await result.json(); input().value = (input().value + ' ' + (data.text || '')).trim(); updateSendState(); } finally { stopTracks(); document.body.classList.remove('dictating'); } };
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
    renderTargets(); renderAttachments(); updateSendState();
  }
  Object.assign(actions, { sendMessage: send, setTargets, insertTarget, uploadImage: upload, toggleDictation, stopDictation });
  Trio.composer = { init, render: renderTargets, send, setTargets, insertTarget, upload, toggleDictation, stopDictation };
})();
