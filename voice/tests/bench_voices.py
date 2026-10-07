"""Compare Bookwyrm's voices on this machine: speed, memory, and how they sound.

    voice/.venv/bin/python tests/bench_voices.py                 every engine this machine has ready
    voice/.venv/bin/python tests/bench_voices.py kokoro chatterbox-turbo-mlx

For each engine it loads the model, speaks the same short phone-call lines one sentence at a time
(as a call does), and reports:

    load      seconds to load (once per app start)
    first     seconds until the first sentence's audio is ready (what a caller waits through)
    RTF       seconds of work per second of speech; under ~0.8 keeps up with a conversation
    memory    extra memory the engine took

It also writes each engine's lines to ~/.bookwyrm/bench/<engine>.wav, so you can listen side by side.
Each engine runs in its own process so memory numbers don't mix.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

LINES = [
    "Hey Dee! What's up?",
    "So... there's one thing in quarantine right now.",
    "It's the social media guidelines draft [chuckle], and the engine couldn't place it.",
    "There's no Marketing team in the teams file yet. Want me to draft that change?",
]


def _rss_mb() -> float:
    try:
        import resource

        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return rss / 2**20 if sys.platform == "darwin" else rss / 2**10  # bytes on macOS, KB on Linux
    except ImportError:  # Windows
        return 0.0


def run_one(engine: str) -> dict:
    from bookwyrm_voice.config import load_settings
    from bookwyrm_voice.speakers import load_speaker

    s = load_settings()
    base = _rss_mb()
    t0 = time.monotonic()
    loaded = load_speaker(engine, s.models_dir, s.voices_dir, kokoro_voice=s.voice,
                          natural_voice=s.natural_voice, check_speed=False)
    load = time.monotonic() - t0
    if loaded.fell_back:
        return {"engine": engine, "error": loaded.note}
    sp = loaded.speaker
    sp.speak("Hello.")  # warm up, as the app does at start
    parts, first, work, said = [], None, 0.0, 0.0
    for line in LINES:
        t = time.monotonic()
        a = sp.speak(line)
        took = time.monotonic() - t
        first = took if first is None else first
        work += took
        said += a.seconds
        parts.append(a.samples)
        parts.append(np.zeros(int(0.4 * a.sample_rate), dtype=np.float32))
    mem = _rss_mb() - base
    try:
        import mlx.core as mx  # the Mac GPU's memory isn't in the process's RSS

        mem = max(mem, mx.get_peak_memory() / 2**20)
    except Exception:  # noqa: BLE001
        pass
    out = s.models_dir.parent / "bench"
    out.mkdir(parents=True, exist_ok=True)
    wav = out / f"{engine}.wav"
    pcm = (np.clip(np.concatenate(parts), -1, 1) * 32767).astype(np.int16)
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.sample_rate)
        w.writeframes(pcm.tobytes())
    return {"engine": engine, "load": load, "first": first, "rtf": work / said, "memory_mb": mem, "wav": str(wav)}


def main(argv: list[str]) -> int:
    if argv[:1] == ["--one"]:
        print(json.dumps(run_one(argv[1])))
        return 0
    from bookwyrm_voice import hardware
    from bookwyrm_voice.config import load_settings
    from bookwyrm_voice.models import engine_present

    s = load_settings()
    m = hardware.detect()
    engines = argv or [e for e in hardware.supported(m) if engine_present(s.models_dir, e)][::-1]
    print(f"{m.describe()}\n")
    print(f"{'engine':<22}{'load':>8}{'first':>8}{'RTF':>7}{'memory':>10}")
    for e in engines:
        r = subprocess.run([sys.executable, __file__, "--one", e], capture_output=True, text=True)
        try:
            d = json.loads(r.stdout.strip().splitlines()[-1])
        except (IndexError, ValueError):
            print(f"{e:<22}failed:\n{r.stderr[-1500:]}")
            continue
        if "error" in d:
            print(f"{e:<22}not usable: {d['error']}")
            continue
        print(f"{e:<22}{d['load']:>7.1f}s{d['first']:>7.2f}s{d['rtf']:>7.2f}{d['memory_mb']:>8.0f} MB   {d['wav']}")
    print("\nRTF under ~0.8 keeps up with a conversation. Listen to the .wav files to compare.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
