"""Tests for local speech-to-text (Idea 1).

Covers the two pieces that back the /api/stt/* endpoints:

  1. Pure helpers in nth_web.py (_stt_ext_for, _stt_model_cached, SttWorker.health)
     — always run; no model or mic needed.
  2. The persistent nth_stt_worker.py sidecar + SttWorker manager — a real
     round-trip transcription of a `say`-generated clip. These SKIP (not fail)
     when mlx_whisper or macOS `say` is unavailable, so the file is safe on CI /
     non-Mac boxes.

Drives the REAL modules, not duplicated logic.

Usage: python tests/test-stt.py
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import nth_web as web  # noqa: E402

failures = []
skips = []


def check(name, cond):
    print(("PASS" if cond else "FAIL") + f": {name}")
    if not cond:
        failures.append(name)


def skip(name, why):
    print(f"SKIP: {name} ({why})")
    skips.append(name)


# ── 1. Pure helpers ──────────────────────────────────────────────────────────
check("ext: webm", web._stt_ext_for("audio/webm") == ".webm")
check("ext: webm+codecs", web._stt_ext_for("audio/webm;codecs=opus") == ".webm")
check("ext: wav", web._stt_ext_for("audio/wav") == ".wav")
check("ext: aiff", web._stt_ext_for("audio/x-aiff") == ".aiff")
check("ext: unknown -> webm", web._stt_ext_for("application/octet-stream") == ".webm")
check("ext: empty -> webm", web._stt_ext_for("") == ".webm")

check("model_cached returns bool", isinstance(web._stt_model_cached(web.STT_MODEL), bool))

h = web.STT.health()
check("health has required keys",
      {"available", "engine", "model", "warm", "detail"} <= set(h))
check("health engine is mlx_whisper", h["engine"] == "mlx_whisper")
check("health available is bool", isinstance(h["available"], bool))


# ── 2. Real transcription round-trip (skips if deps missing) ──────────────────
def mlx_available():
    try:
        r = subprocess.run([sys.executable, "-c", "import mlx_whisper"],
                           capture_output=True, timeout=15)
        return r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


if not shutil.which("say"):
    skip("worker round-trip", "macOS `say` not available")
elif not mlx_available():
    skip("worker round-trip", "mlx_whisper not importable")
else:
    tmpdir = tempfile.mkdtemp(prefix="nth_stt_test_")
    sample = str(Path(tmpdir) / "sample.aiff")
    subprocess.run(["say", "-o", sample,
                    "The quick brown fox jumps over the lazy dog."], check=True)

    worker = web.SttWorker(web.STT_MODEL, "en")
    try:
        r1 = worker.transcribe(sample)
        text = (r1.get("text") or "").lower()
        check("round-trip returns text", bool(text))
        check("round-trip transcribes the phrase",
              "quick brown fox" in text and "lazy dog" in text)
        check("round-trip reports seconds", isinstance(r1.get("seconds"), (int, float)))

        # Second call reuses the same warm worker (no respawn).
        r2 = worker.transcribe(sample)
        check("second call stays warm (still transcribes)",
              "quick brown fox" in (r2.get("text") or "").lower())

        # Silence must be flagged no_speech (Whisper skipped) — not hallucinated.
        import wave
        silent = str(Path(tmpdir) / "silence.wav")
        with wave.open(silent, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 32000)   # 2s of digital silence
        rs = worker.transcribe(silent)
        check("silence flagged no_speech", rs.get("no_speech") is True)
        check("silence yields no text", not (rs.get("text") or "").strip())

        # Real speech must NOT be flagged no_speech.
        check("speech not flagged no_speech", r1.get("no_speech") is False)

        # Bad audio path -> RuntimeError (surfaces as ok:false to the client).
        raised = False
        try:
            worker.transcribe(str(Path(tmpdir) / "nope.wav"))
        except RuntimeError:
            raised = True
        check("bad audio raises RuntimeError", raised)
    finally:
        worker._reset()
        shutil.rmtree(tmpdir, ignore_errors=True)


print()
print(f"{'FAILED' if failures else 'OK'} — "
      f"{len(failures)} failure(s), {len(skips)} skip(s)")
sys.exit(1 if failures else 0)
