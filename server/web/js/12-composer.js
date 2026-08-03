(() => {
  'use strict';
  const Trio = window.Trio;
  if (!Trio) throw new Error('Composer requires Trio core');
  const { state, api, events, actions } = Trio;
  state.selectedTargets = state.selectedTargets instanceof Set ? state.selectedTargets : new Set();
  state.pendingAttachments = Array.isArray(state.pendingAttachments) ? state.pendingAttachments : [];
  state.drafts = state.drafts || {};
  let recognition = null, recorder = null, stream = null, chunks = [];
  // Metering is a SEPARATE stream from the one MediaRecorder/SpeechRecognition
  // consumes — SpeechRecognition never exposes its underlying audio, so a
  // level meter needs its own getUserMedia grab regardless of engine, and
  // local mode keeps its recorder stream independent for a cleaner teardown.
  let meterStream = null, audioCtx = null, analyser = null, meterRaf = null;
  // LOTC/Sauron+Uruk-Hai: toggleDictation()'s "already active" guard only
  // sees `recognition`/`recorder`, both still null during localDictation()'s
  // getUserMedia await — a double-click in that window ran two concurrent
  // localDictation() calls, each overwriting the SAME module vars, leaking
  // the first stream/recorder/AudioContext with nothing left able to stop
  // them (and corrupting `chunks`, shared across both). `starting` closes
  // that window; `dictationGen` (bumped on every stop) lets an in-flight
  // async callback (e.g. browserDictation's metering getUserMedia) detect
  // it's stale — see LOTC/Aragorn's unmount-race finding below.
  let starting = false, dictationGen = 0;
  const byId = id => document.getElementById(id);
  const input = () => byId('input');
  function inputValue(newValue) { const el = input(); if (!el) return ''; if (newValue !== undefined) el.value = newValue; return el.value; }
  function resize() { const el = input(); if (!el) return; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

  function targetName(id) { return state.members?.get(id)?.name || id; }
  function conversationId() { return state.dmKey ? 'dm:' + state.dmKey : (state.channel || 'home'); }
  function saveDraft() { const el = input(); if (!el) return; state.drafts[conversationId()] = el.value; }
  function loadDraft() {
    const el = input(); if (!el) return;
    stopDictation();
    const key = conversationId();
    el.value = state.drafts[key] || '';
    resize(); updateSendState();
  }
  function apiUrl(path) {
    if (typeof api.url === 'function') return api.url(path);
    const channel = state.channel || '';
    return channel ? path + (path.includes('?') ? '&' : '?') + 'channel=' + encodeURIComponent(channel) : path;
  }
  function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function revokePreview(att) { if (att && att.url && att.url.startsWith('blob:')) { URL.revokeObjectURL(att.url); att.url = ''; } }
  function showLightbox(url, alt) {
    let dialog = document.getElementById('trio-lightbox');
    if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'trio-lightbox'; dialog.className = 'lightbox'; document.body.append(dialog); }
    Trio.ui.configureDialog(dialog);
    dialog.innerHTML = `<form method="dialog"><button type="submit" formnovalidate class="modal-close" aria-label="Close">×</button><img src="${escHtml(url)}" alt="${escHtml(alt || '')}" loading="lazy"></form>`;
    dialog.showModal();
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
  function validate() {
    if (state.readOnly) return false;
    // An in-flight upload's placeholder has id:0 and gets silently dropped by
    // buildSendPayload's `id > 0` filter — sending mid-upload used to eat the
    // attachment with no warning (LOTC/Frodo). Block send until every pending
    // attachment has resolved (succeeded or been removed).
    if (state.pendingAttachments.some(a => a.loading)) return false;
    return !!renderedContent() || state.pendingAttachments.length > 0;
  }
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
    const preview = URL.createObjectURL(file);
    const placeholder = { id: 0, filename: file.name || 'image', loading: true, url: preview };
    state.pendingAttachments.push(placeholder); renderAttachments(); updateSendState();
    try {
      const response = await fetch(apiUrl('/api/upload'), {
        method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name || 'image') }, body: file,
      });
      if (!response.ok) throw new Error('upload failed (' + response.status + ')');
      const attachment = await response.json();
      if (!attachment.ok || !Number.isInteger(attachment.id)) throw new Error('Upload did not return an attachment id');
      revokePreview(placeholder);
      Object.assign(placeholder, attachment, { name: attachment.filename, loading: false, url: apiUrl(attachment.url) });
    } catch (error) {
      revokePreview(placeholder);
      const index = state.pendingAttachments.indexOf(placeholder);
      if (index >= 0) { state.pendingAttachments.splice(index, 1); }
      throw error;
    } finally {
      // Must run on the error path too — otherwise a failed upload leaves
      // validate()'s loading-guard with nothing left to clear and the send
      // button stays stuck disabled (every caller re-throws past this point
      // to a bare .catch(toast), never re-calling updateSendState itself).
      renderAttachments(); updateSendState();
    }
  }
  function renderAttachments() {
    const strip = byId('attachment-strip'); if (!strip) return;
    strip.replaceChildren();
    state.pendingAttachments.forEach((attachment, index) => {
      const thumb = document.createElement('div');
      thumb.className = 'attachment-thumb';
      thumb.title = attachment.filename || 'attachment';
      const img = document.createElement('img');
      img.src = attachment.url || '';
      img.alt = attachment.filename || 'attachment';
      img.loading = 'lazy';
      // A bare onclick <img> is unreachable by keyboard/screen-reader users
      // (LOTC/Frodo) — the remove button next to it already does this right.
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.setAttribute('aria-label', 'View full image: ' + img.alt);
      const openLightbox = () => showLightbox(img.src, img.alt);
      img.onclick = openLightbox;
      img.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(); } };
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'rm'; rm.title = 'remove';
      rm.setAttribute('aria-label', 'remove attachment');
      rm.textContent = '×';
      rm.disabled = attachment.loading;
      rm.onclick = () => { revokePreview(attachment); state.pendingAttachments.splice(index, 1); renderAttachments(); updateSendState(); };
      thumb.append(img, rm);
      if (attachment.loading) {
        const mask = document.createElement('div');
        mask.className = 'loading-mask';
        mask.textContent = '…';
        thumb.append(mask);
      }
      strip.append(thumb);
    });
  }
  async function send() {
    if (!validate()) return false;
    const button = byId('send'); if (button) button.disabled = true;
    const body = buildSendPayload();
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
  function hasBrowserDictation() { return typeof window.SpeechRecognition === 'function' || typeof window.webkitSpeechRecognition === 'function'; }
  function hasLocalDictation() { return !!window.navigator?.mediaDevices?.getUserMedia && typeof window.MediaRecorder === 'function'; }
  // Simple 5-bar level meter driven by an AnalyserNode — enough to show
  // "yes, your voice is registering" without a full waveform canvas. Reuses
  // whatever MediaStream the caller already opened; browser-engine mode has
  // no stream of its own (SpeechRecognition doesn't expose one) so it opens
  // a metering-only one that captures nothing but the level display.
  function startMeter(meterStreamSource) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioCtx = new AudioContext();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 32;
      audioCtx.createMediaStreamSource(meterStreamSource).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const bars = byId('dictate-meter')?.querySelectorAll('.bar');
      const meter = byId('dictate-meter');
      if (meter) meter.hidden = false;
      const tick = () => {
        analyser.getByteFrequencyData(data);
        if (bars) {
          const step = Math.max(1, Math.floor(data.length / bars.length));
          bars.forEach((bar, i) => {
            const level = data[i * step] / 255; // 0..1
            bar.style.setProperty('--level', String(0.15 + level * 0.85));
          });
        }
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* metering is a nice-to-have; dictation itself still works */ }
  }
  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = null;
    analyser = null;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    meterStream?.getTracks?.().forEach(track => track.stop());
    meterStream = null;
    const meter = byId('dictate-meter');
    if (meter) meter.hidden = true;
  }
  // active: recording/listening (red stop icon + meter). processing: local
  // mode's post-stop transcription request (button disabled, status text
  // names the engine so it's clear this isn't the browser's own STT).
  //
  // button.dataset.unavailable (set once at mount(), see below) tracks the
  // "no mic support in this browser" disablement, which is independent of
  // and must survive the active/processing toggling done here.
  function setDictationButtonState(active, { processing = false, statusText = '' } = {}) {
    const button = byId('dictate-btn');
    const status = byId('dictate-status');
    if (button) {
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('recording', active);
      button.classList.toggle('processing', processing);
      button.disabled = processing || button.dataset.unavailable === 'true';
      button.querySelector('.mic-icon')?.toggleAttribute('hidden', active);
      button.querySelector('.stop-icon')?.toggleAttribute('hidden', !active);
      const label = processing ? (statusText || 'Transcribing…')
        : active ? 'Stop dictation' : (button.disabled ? 'Dictation is unavailable in this browser' : 'Dictate');
      button.title = label;
      // LOTC/Frodo: aria-label was static ("Dictate") regardless of state, so
      // a screen reader's announced name never matched the visible tooltip.
      button.setAttribute('aria-label', label);
    }
    if (status) {
      status.hidden = !statusText;
      status.textContent = statusText;
    }
    // LOTC/Frodo: the visible status text was removed for the recording-start
    // case (redundant with the red button + waveform for sighted users), but
    // that text was a screen reader's only chance at a state announcement.
    // #trio-aria-live already exists for exactly this — announce here
    // without reinstating any visible clutter. Idle state clears it.
    Trio.ui?.setLive?.(processing ? (statusText || 'Transcribing') : active ? 'Recording' : '');
  }
  function stopDictation() {
    dictationGen++; // invalidate any in-flight async callback from this session (LOTC/Aragorn)
    if (recognition) { recognition.stop(); recognition = null; }
    if (recorder?.state === 'recording') recorder.stop();
    stopTracks(); stopMeter(); document.body.classList.remove('dictating'); setDictationButtonState(false);
  }
  async function browserDictation() {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) throw new Error('Browser speech recognition is unavailable');
    const myGen = dictationGen; // captured now — stopDictation()/unmount() bump this
    recognition = new Speech(); recognition.continuous = true; recognition.interimResults = true;
    let finalText = '';
    recognition.onresult = event => { let interim = ''; for (let i = event.resultIndex; i < event.results.length; i++) event.results[i].isFinal ? finalText += event.results[i][0].transcript : interim += event.results[i][0].transcript; inputValue((inputValue() + ' ' + finalText + interim).trim()); updateSendState(); };
    recognition.onend = () => { recognition = null; stopMeter(); document.body.classList.remove('dictating'); setDictationButtonState(false); };
    // LOTC/Aragorn: request the metering stream only once `onstart` confirms
    // SpeechRecognition's OWN mic permission already resolved, instead of
    // firing a second concurrent getUserMedia() request right away — on a
    // first-ever grant that raced two simultaneous browser permission
    // prompts for what looks like one user action.
    recognition.onstart = () => {
      window.navigator.mediaDevices?.getUserMedia?.({ audio: true }).then(s => {
        // Stale by the time this resolved (stopped/unmounted, or a newer
        // dictation session started) — don't leak a mic stream + AudioContext
        // with nothing left able to close them (LOTC/Aragorn, critical).
        if (dictationGen !== myGen) { s.getTracks().forEach(t => t.stop()); return; }
        meterStream = s; startMeter(s);
      }).catch(() => {});
    };
    // No statusText here — the level meter already shows "I'm recording";
    // a redundant "Listening…" label next to a red pulsing button and a
    // waveform is one signal too many (jdsareault).
    recognition.start(); document.body.classList.add('dictating'); setDictationButtonState(true);
  }
  async function localDictation() {
    if (!hasLocalDictation()) throw new Error('Local dictation is unavailable in this browser');
    // LOTC/Sauron+Uruk-Hai: `toggleDictation`'s "already active" guard checks
    // `recognition`/`recorder`, both still null during the getUserMedia
    // await below — a rapid double-click ran two of these concurrently,
    // each overwriting the SAME module vars (stream/recorder/chunks/
    // audioCtx/analyser/meterRaf), leaking the first stream+AudioContext
    // with nothing left able to stop them, and corrupting the shared
    // `chunks` array between two live recorders.
    if (starting) return;
    starting = true;
    try {
      stream = await window.navigator.mediaDevices.getUserMedia({ audio: true }); chunks = [];
    } finally { starting = false; }
    recorder = new window.MediaRecorder(stream);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      setDictationButtonState(false, { processing: true, statusText: 'Transcribing (local Whisper)…' });
      // LOTC/Sauron: the fallback below starts a NEW dictation session
      // (browserDictation) without awaiting it, so this handler's own
      // `finally` used to run right after and unconditionally strip the
      // 'dictating' class / reset the button — wiping out the state the
      // fallback had just set, even though its mic (`recognition`) was
      // still live and listening. `fellBack` skips that stomp.
      let fellBack = false;
      try {
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const result = await fetch(apiUrl('/api/stt/transcribe'), { method: 'POST', headers: { 'Content-Type': audio.type || 'audio/webm' }, body: audio });
        const data = await result.json();
        if (!result.ok || !data.ok) throw new Error(data.error || 'transcription failed');
        inputValue((inputValue() + ' ' + (data.text || '')).trim()); updateSendState();
      } catch (error) {
        if (window.SpeechRecognition || window.webkitSpeechRecognition) {
          fellBack = true;
          Trio.ui.toast((error.message || 'Local transcription failed') + '. Falling back to browser speech recognition.');
          // Not awaited — this function's own `finally` below runs first
          // (synchronously, before this promise settles) and already skips
          // its teardown because `fellBack` is true; if the fallback itself
          // then fails, its OWN teardown has to happen here instead.
          browserDictation().catch(fallback => { Trio.ui.toast(fallback.message); document.body.classList.remove('dictating'); setDictationButtonState(false); });
        }
        else Trio.ui.toast(error.message || 'Transcription failed');
      } finally {
        stopTracks();
        if (!fellBack) { document.body.classList.remove('dictating'); setDictationButtonState(false); }
      }
    };
    // No statusText while actively recording (see browserDictation) — the
    // "Transcribing (local Whisper)…" text right after IS still useful,
    // since that's invisible processing time the waveform can't represent.
    recorder.start(); document.body.classList.add('dictating'); setDictationButtonState(true);
    startMeter(stream);
  }
  async function toggleDictation() {
    // Mid-getUserMedia-await: neither recorder nor stream exists yet, so
    // there's nothing for stopDictation() to stop — just ignore the extra
    // click rather than tearing down a session that hasn't started.
    if (starting) return;
    if (recognition || recorder?.state === 'recording') return stopDictation();
    const mode = Trio.preferences?.read?.().sttMode || 'local';
    if (mode === 'web') return browserDictation();
    try { return await localDictation(); }
    catch (error) {
      if (!hasBrowserDictation()) throw error;
      Trio.ui.toast((error.message || 'Local dictation failed') + '. Falling back to browser speech recognition.');
      return browserDictation();
    }
  }
  const domListeners = [];
  let unroute;
  let ac = null;
  let isComposing = false;
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
    if (isComposing) return;
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
  function setInputState(text) {
    if (!text) return;
    text.disabled = !!state.readOnly;
    text.placeholder = state.readOnly ? 'This conversation is archived.' : 'Message…';
  }
  function syncReadOnly() { setInputState(input()); updateSendState(); }
  function init() {
    const text = input(), sendButton = byId('send'), attach = byId('attach-btn');
    if (!text) return;
    setInputState(text);
    renderTargets(); renderAttachments();
    const onInput = () => { updateSendState(); saveDraft(); updateAutocomplete(); resize(); };
    const onCompositionStart = () => { isComposing = true; };
    const onCompositionEnd = () => { isComposing = false; updateAutocomplete(); resize(); };
    text.addEventListener('compositionstart', onCompositionStart); domListeners.push([text, 'compositionstart', onCompositionStart]);
    text.addEventListener('compositionend', onCompositionEnd); domListeners.push([text, 'compositionend', onCompositionEnd]);
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
    const onPaste = async (event) => {
      const clip = event.clipboardData || window.clipboardData;
      const images = [];
      if (clip.files && clip.files.length) {
        for (const f of clip.files) { if (/^image\//.test(f.type)) images.push(f); }
      } else if (clip.items) {
        for (const it of clip.items) {
          if (it.kind === 'file' && /^image\//.test(it.type)) {
            const f = it.getAsFile(); if (f) images.push(f);
          }
        }
      }
      if (!images.length) return;
      event.preventDefault();
      for (const f of images) await upload(f).catch(error => Trio.ui.toast(error.message));
    };
    text.addEventListener('paste', onPaste); if (text) domListeners.push([text, 'paste', onPaste]);
    const dictation = Trio.preferences?.read?.().dictation !== false;
    const dictateBtn = byId('dictate-btn');
    const dictationAvailable = hasLocalDictation() || hasBrowserDictation();
    if (dictateBtn) {
      dictateBtn.hidden = !dictation;
      dictateBtn.dataset.unavailable = String(dictation && !dictationAvailable);
      dictateBtn.disabled = dictation && !dictationAvailable;
      if (!dictationAvailable) dictateBtn.title = 'Dictation is unavailable in this browser';
    }
    const onDictate = () => toggleDictation().catch(error => Trio.ui.toast(error?.message || 'Dictation failed'));
    if (dictation && dictationAvailable && dictateBtn) { dictateBtn.addEventListener('click', onDictate); domListeners.push([dictateBtn, 'click', onDictate]); }
    unroute = Trio.router?.on?.(() => { loadDraft(); setInputState(text); });
    renderTargets(); renderAttachments(); loadDraft();
  }
  function unmount() {
    domListeners.forEach(([el, type, fn]) => el?.removeEventListener?.(type, fn)); domListeners.length = 0;
    if (unroute) { unroute(); unroute = null; }
    // Browser-engine (web) mode only ever set `recognition`, never `recorder`
    // — the old check here missed it entirely, leaking an open mic stream
    // (recognition's own capture, plus this file's metering stream) past
    // navigation away from the composer.
    if (recognition || (recorder && recorder.state !== 'inactive')) stopDictation();
  }
  function mount() { init(); }
  Object.assign(actions, { sendMessage: send, setTargets, insertTarget, uploadImage: upload, toggleDictation, stopDictation, buildSendPayload });
  Trio.composer = { init, mount, unmount, render: renderTargets, send, setTargets, insertTarget, upload, toggleDictation, stopDictation, buildSendPayload, syncReadOnly, setDictationButtonState };
})();
