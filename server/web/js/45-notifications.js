(() => {
  'use strict';
  const Trio = window.Trio;
  if (!Trio) throw new Error('Notifications requires Trio core');
  const { state, events } = Trio;

  // ── Tier classification ──────────────────────────────────────────────
  // Highest priority first. A message is classified into the FIRST tier it
  // qualifies for — see 40-preferences.js's NOTIFICATION_TIERS comment for
  // the full rationale (DM > @/! > # > plain).
  function classify(msg, operatorId) {
    if (!msg || !operatorId) return null;
    if (msg.member_id === operatorId) return null; // never chime/notify on your own message
    if (Trio.markdown?.isSystemContent?.(msg.content || '')) return null;
    const recipients = msg.recipients || [];
    if (recipients.length && recipients.includes(operatorId)) return 'dm';
    const mentions = msg.mentions || [], bangs = msg.bangs || [], refs = msg.refs || [];
    if (mentions.includes(operatorId) || bangs.includes(operatorId)) return 'mention';
    if (refs.includes(operatorId)) return 'ref';
    return 'plain';
  }

  // ── Chime synthesis (WebAudio, no audio asset) ───────────────────────
  // Three presets instead of one fixed tone, so different tiers can sound
  // distinct (a DM shouldn't sound like an untargeted channel message).
  // Ported from the pre-modularization dashboard's playChime/alertBlocked
  // (git history: f4f0c27, 77b7b96) — same synthesis technique, split into
  // named presets instead of one hardcoded ping.
  const SOUNDS = {
    // Two-note ping, E6 -> A6 — the original default chime.
    ping: { wave: 'sine', decay: 0.40, notes: [[1318.51, 0], [1760.0, 0.09]] },
    // Urgent two-note fall, A5 -> D5, square wave — cuts through; was
    // previously reserved for a peer going 'blocked', reused here for the
    // highest-priority tiers (dm/mention).
    alert: { wave: 'square', decay: 0.55, notes: [[880.0, 0], [587.33, 0.16]] },
    // A single short, quiet tick for low-priority tiers.
    tick: { wave: 'sine', decay: 0.18, notes: [[660.0, 0]] },
  };
  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = AC ? new AC() : null;
    } catch { audioCtx = null; }
    return audioCtx;
  }
  function playPreset(name, volume) {
    const preset = SOUNDS[name] || SOUNDS.ping;
    const vol = Math.max(0, Math.min(1, Number(volume)));
    if (vol <= 0) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch { /* needs a user gesture first; next real chime after one will work */ } }
    try {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(vol, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + preset.decay);
      gain.connect(ctx.destination);
      preset.notes.forEach(([freq, t]) => {
        const osc = ctx.createOscillator();
        osc.type = preset.wave;
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(now + t);
        osc.stop(now + t + preset.decay);
      });
    } catch { /* best-effort — a chime failing must never break message delivery */ }
  }

  // ── Priming guard ─────────────────────────────────────────────────────
  // /api/events seeds each new SSE subscription with a burst of recent
  // history (nth_web.py EventHub.subscribe's "prime" payloads) through the
  // SAME queue as live messages — there's no field distinguishing the two.
  // Without a guard, opening a channel (or a reconnect) replays a chime/
  // popup for every recent message at once. Settle window mirrors the old
  // dashboard's scheduleInitialSettle() (git history: f4f0c27).
  const PRIME_SETTLE_MS = 800;
  let priming = true, settleTimer = null;
  function armPriming() {
    priming = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { priming = false; }, PRIME_SETTLE_MS);
  }
  events.addEventListener('connection', event => {
    const s = event.detail?.state;
    if (s === 'live' || s === 'workspace:live') armPriming();
  });

  // ── Desktop notification ─────────────────────────────────────────────
  function showDesktopNotification(msg, tier) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const title = tier === 'dm' ? `DM — ${msg.member_name || msg.member_id}` : `#${state.channel || ''} — ${msg.member_name || msg.member_id}`;
      const n = new Notification(title, {
        body: String(msg.content || '').slice(0, 140),
        tag: 'trio-' + msg.id,
        silent: true, // the chime (if enabled) already covers sound; avoid a second, uncontrolled OS ding
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* best-effort */ }
  }

  function onMessage(event) {
    const msg = event.detail;
    if (priming || !msg || msg.id == null) return;
    const operatorId = (state.operator || state.meta?.operator)?.id;
    const tier = classify(msg, operatorId);
    if (!tier) return;
    const prefs = Trio.preferences?.read?.();
    if (!prefs) return;
    const Tier = tier.charAt(0).toUpperCase() + tier.slice(1);
    if (prefs.chime && prefs['chimeTier' + Tier]) playPreset(prefs['chimeSound' + Tier], prefs.chimeVolume);
    // Desktop popups are only useful when you're not already looking at the
    // conversation — unlike the chime, which should still play so an
    // audible cue reaches you even with the tab focused elsewhere.
    if (prefs.notifications && prefs['notifyTier' + Tier] && document.hidden) showDesktopNotification(msg, tier);
  }
  events.addEventListener('message', onMessage);

  Trio.notifications = { classify, playPreset, SOUNDS, TIERS: ['dm', 'mention', 'ref', 'plain'] };
})();
