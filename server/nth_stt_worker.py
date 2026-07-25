#!/usr/bin/env python3
"""Persistent local speech-to-text worker for nth_web.py.

Loads an mlx-whisper model ONCE and keeps it warm, so each transcription costs
only inference (~0.8s) instead of a ~3s cold model load per subprocess. Speaks a
line-delimited JSON protocol over stdin/stdout:

  stdin   {"audio": "/path/to/file", "language": "en"}\\n
  stdout  {"ok": true, "text": "...", "seconds": 0.79}\\n
      or  {"ok": false, "error": "..."}\\n

On startup it prints exactly one line once the model is resident:
  {"ready": true, "model": "..."}      model loaded, requests may follow
  {"ready": false, "error": "..."}     import/load failed — parent should give up

The worker exits on stdin EOF, so when the parent web server dies the pipe
closes and this process cleans itself up (no orphan).

NOT stdlib-only: this imports mlx_whisper. It is an OPTIONAL sidecar spawned by
nth_web.py only when local transcription is used; the core web server stays
dependency-free and merely pipes audio paths to this process.
"""
import json
import os
import sys
import tempfile
import time
import wave

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


def _emit(obj) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _silent_wav() -> str:
    """A 0.1s silent 16kHz mono WAV used to force the model to load before we
    report ready — so 'ready' means genuinely warm, not merely importable."""
    fd, path = tempfile.mkstemp(prefix="nth_stt_warm_", suffix=".wav")
    os.close(fd)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 1600)
    return path


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL

    try:
        import mlx_whisper
    except Exception as e:  # noqa: BLE001
        _emit({"ready": False, "error": f"mlx_whisper import failed: {e}"})
        return 1

    # Warm the model (downloads on first ever use, then cached on disk).
    warm = None
    try:
        warm = _silent_wav()
        mlx_whisper.transcribe(warm, path_or_hf_repo=model)
    except Exception as e:  # noqa: BLE001
        _emit({"ready": False, "error": f"model load failed: {e}"})
        return 1
    finally:
        if warm:
            try:
                os.unlink(warm)
            except OSError:
                pass

    _emit({"ready": True, "model": model})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            _emit({"ok": False, "error": "bad request json"})
            continue
        audio = req.get("audio")
        lang = req.get("language") or None
        if not audio:
            _emit({"ok": False, "error": "no audio path"})
            continue
        t0 = time.time()
        try:
            if lang:
                result = mlx_whisper.transcribe(audio, path_or_hf_repo=model, language=lang)
            else:
                result = mlx_whisper.transcribe(audio, path_or_hf_repo=model)
            text = str(result.get("text") or "").strip()
            _emit({"ok": True, "text": text, "seconds": round(time.time() - t0, 2)})
        except Exception as e:  # noqa: BLE001
            _emit({"ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
