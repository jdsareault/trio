// The dictation fallback path — why a failing mic told the operator nothing.
//
// Two independent bugs made every browser-engine failure invisible, and both
// were found the slow way: dictation on a tailnet URL did nothing at all, and
// the visible message ("Falling back to browser speech recognition") described
// a recovery that never happened.
//
// 1. SpeechRecognition had NO onerror handler. The error event went unhandled
//    and onend fired straight after, quietly resetting the button to idle —
//    so a blocked mic, a refused insecure origin, and a dead network were
//    indistinguishable from "nothing happened". A message per failure state is
//    the fix; this pins the mapping, since an unmapped code silently degrades
//    back toward that same "no idea why" outcome.
//
// 2. hasBrowserDictation() tested only that the CONSTRUCTOR EXISTS. It exists
//    on an insecure origin too — it is start() that gets refused there. So the
//    composer promised a fallback it could not deliver, on exactly the http://
//    tailnet URL where the local engine was already dead for the same
//    secure-context reason. This is the check that has to know the difference.
//
// Both are exported as pure helpers rather than exercised through the live
// dictation flow: that flow needs a real MediaRecorder and SpeechRecognition,
// which dom-harness deliberately does not fake (see its header). Testing the
// decision instead of the plumbing is the pattern that header recommends.
//
// Usage: node tests/test-dictation-fallback.js
'use strict';

const { load } = require('./dom-harness');

const failures = [];
let passed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS: ' + name); }
  else { failures.push(name); console.log('FAIL: ' + name); }
}

const cx = load();
const Trio = cx.hooks.Trio;
if (cx.bootError) console.log('(note) boot ran with: ' + cx.bootError.message);

const C = Trio.composer;
const message = C.speechErrorMessage;

// ── 1. every failure state says something actionable ──
check('speechErrorMessage is exported', typeof message === 'function');

// The insecure-origin case, which is the one that started all of this. The
// message has to name https, because "service-not-allowed" is otherwise
// completely opaque and the fix is a different URL, not a browser setting.
const insecure = message('service-not-allowed');
check('service-not-allowed explains the https requirement',
      /https/.test(insecure));

// A blocked mic is a browser SETTING, not a page problem — pointing at the
// wrong one costs an afternoon.
check('not-allowed points at browser permissions',
      /(permission|allow|blocked)/i.test(message('not-allowed')));

// This engine transcribes on a remote server, so a working mic plus a dead
// network still fails. But `network` is ALSO the permanent verdict in every
// Chromium browser that is not Chrome — the speech service needs Google API
// keys only Chrome ships, so the engine looks present and never works. Found
// the hard way on Dia. Naming only the connection sends the operator off to
// debug a network that is fine, so the message must name the browser cause
// and point at the local engine, which has neither problem.
const network = message('network');
check('network names the server it could not reach',
      /server|reach/i.test(network));
check('network names the not-Chrome-Chromium cause',
      /chromium/i.test(network));
check('network points at the local engine as the way out',
      /local/i.test(network));

check('audio-capture names the missing microphone',
      /microphone/i.test(message('audio-capture')));
check('no-speech says nothing was heard',
      /speech/i.test(message('no-speech')));

// 'aborted' is what the user's own stop button produces. Toasting there would
// report every deliberate stop as an error.
check('aborted is deliberately silent', message('aborted') === '');

// An unmapped or absent code must still produce a real sentence: the whole
// defect was a failure that said nothing, and a new browser error string
// must not reopen that hole.
const unknown = message('some-future-code');
check('an unmapped code still yields a message',
      typeof unknown === 'string' && unknown.length > 0);
check('an unmapped code includes the raw code for diagnosis',
      unknown.includes('some-future-code'));
const missing = message(undefined);
check('a missing code still yields a message',
      typeof missing === 'string' && missing.length > 0);
check('a missing code does not print "undefined"',
      !/undefined/.test(missing));

// Nothing here may be a bare code echoed back at the operator.
const all = ['not-allowed', 'service-not-allowed', 'no-speech', 'audio-capture',
             'network', 'language-not-supported'];
check('no mapped state returns a bare error code',
      all.every(code => message(code) !== code && message(code).length > 10));

// ── 2. availability is secure-context aware ──
// This is the check that decides whether to PROMISE a fallback. On the
// insecure origin it used to say yes, which is how the composer came to
// announce a recovery it could not perform.
const win = cx.window;
const savedSecure = win.isSecureContext;
const savedSpeech = win.SpeechRecognition;
const savedWebkit = win.webkitSpeechRecognition;

function withWindow({ secure, speech }, fn) {
  win.isSecureContext = secure;
  win.SpeechRecognition = speech ? function () {} : undefined;
  win.webkitSpeechRecognition = undefined;
  try { return fn(); } finally {
    win.isSecureContext = savedSecure;
    win.SpeechRecognition = savedSpeech;
    win.webkitSpeechRecognition = savedWebkit;
  }
}

check('unavailable on an insecure origin even though the constructor exists',
      withWindow({ secure: false, speech: true }, () => C.hasBrowserDictation() === false));
check('available on a secure origin with the standard constructor',
      withWindow({ secure: true, speech: true }, () => C.hasBrowserDictation() === true));
check('unavailable on a secure origin with no engine at all',
      withWindow({ secure: true, speech: false }, () => C.hasBrowserDictation() === false));

// The prefixed constructor is the only one Safari and older Chrome expose;
// dropping it would disable dictation on exactly the mobile browsers this
// whole change exists to serve.
win.isSecureContext = true;
win.SpeechRecognition = undefined;
win.webkitSpeechRecognition = function () {};
check('the webkit-prefixed constructor counts', C.hasBrowserDictation() === true);
win.isSecureContext = savedSecure;
win.SpeechRecognition = savedSpeech;
win.webkitSpeechRecognition = savedWebkit;

// A browser that reports nothing about secure context (isSecureContext
// undefined) must not be treated as insecure — that would disable dictation
// for a browser whose only sin is being old.
win.isSecureContext = undefined;
win.SpeechRecognition = function () {};
check('an unknown secure-context state does not disable dictation',
      C.hasBrowserDictation() === true);
win.isSecureContext = savedSecure;
win.SpeechRecognition = savedSpeech;

// ── 3. the transcript accumulator ──
// Reported live: saying "Today is a beautiful sunny day" produced "today today
// is today is a today is a beautiful…". Each result event carries only the
// results from resultIndex onward, so the running final text must accumulate
// across events — but the BOX has to be rewritten from a fixed baseline, never
// appended to. The original read the box back and appended the running
// transcript to it, so every event re-added the whole sentence so far. Interim
// results fire on nearly every word, so output grew quadratically with speech.
const acc = Trio.composer.makeSpeechAccumulator;
check('makeSpeechAccumulator is exported', typeof acc === 'function');

// One word at a time, interim then final — how Chrome actually streams.
function res(transcript, isFinal) { return { 0: { transcript }, isFinal }; }

let absorb = acc('');
let out;
out = absorb([res('today', false)], 0);
check('first interim shows the word once', out === 'today');
out = absorb([res('today is', false)], 0);
check('a revised interim REPLACES, never appends', out === 'today is');
out = absorb([res('today is a beautiful sunny day', true)], 0);
check('the final result replaces the interim',
      out === 'today is a beautiful sunny day');

// The reported failure, reproduced as a sequence: a growing interim followed
// by a final. Anything that appends produces the doubled string.
absorb = acc('');
[['Today', false], ['Today is', false], ['Today is a beautiful', false],
 ['Today is a beautiful sunny day', true]].forEach(([t, f]) => {
  out = absorb([res(t, f)], 0);
});
check('a full dictation session yields the sentence exactly once',
      out === 'Today is a beautiful sunny day');
check('no word is duplicated', (out.match(/beautiful/g) || []).length === 1);

// Multi-utterance: two finals in a row must BOTH survive. Rewriting from
// baseline is the fix, but rewriting from baseline while forgetting to
// accumulate finals would silently drop the first sentence.
// `results` is cumulative across events and resultIndex points at the first
// NEW entry, so the second event sees a two-element list starting at 1.
absorb = acc('');
const utterances = [res('First sentence.', true), res(' Second sentence.', true)];
absorb(utterances.slice(0, 1), 0);
out = absorb(utterances, 1);
check('successive final results both accumulate',
      out === 'First sentence. Second sentence.');

// Text already typed must be preserved and dictation appended after it once.
absorb = acc('existing note');
out = absorb([res('dictated words', true)], 0);
check('pre-existing composer text is kept exactly once',
      out === 'existing note dictated words');

// A baseline that is empty must not leave a leading space.
absorb = acc('');
out = absorb([res('hello', true)], 0);
check('an empty baseline yields no leading whitespace', out === 'hello');

// resultIndex is what makes events incremental — a handler that ignores it
// and rescans from 0 re-adds every already-final result.
absorb = acc('');
const results = [res('one', true), res('two', true)];
absorb(results.slice(0, 1), 0);
out = absorb(results, 1);
check('resultIndex is honoured, not rescanned from zero', out === 'onetwo');

console.log('');
if (failures.length) {
  console.log(failures.length + ' FAILED: ' + failures.join(', '));
  process.exit(1);
}
console.log(passed + ' dictation fallback checks passed');
