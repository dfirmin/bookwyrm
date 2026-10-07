"""The speech engines work on this machine: the speaking engine says a sentence, Parakeet hears it
back; and when a natural voice can't be used, Bookwyrm still talks (with Kokoro).

    python tests/test_engines.py        (needs the models: python -m bookwyrm_voice.models)

Runs whichever engine settings choose (Kokoro unless setup installed a natural voice), so on a
machine with Chatterbox this checks Chatterbox too.
"""

import asyncio
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bookwyrm_voice import speakers  # noqa: E402
from bookwyrm_voice.config import load_settings  # noqa: E402
from bookwyrm_voice.pipeline import Engines  # noqa: E402
from bookwyrm_voice.stt import transcribe  # noqa: E402

SENTENCE = "One draft is in quarantine, and two gaps are still open."


def round_trip(engines: Engines):
    t0 = time.monotonic()
    audio = engines.speaker.speak(SENTENCE)
    took = time.monotonic() - t0
    print(f"{engines.speaker.engine} spoke {audio.seconds:.1f}s of audio in {took:.1f}s")

    # Parakeet listens at 16 kHz.
    samples = audio.samples
    n = int(len(samples) * 16000 / audio.sample_rate)
    at16k = np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples).astype(np.float32)
    t0 = time.monotonic()
    heard = transcribe(engines.recognizer, (np.clip(at16k, -1, 1) * 32767).astype(np.int16).tobytes())
    print(f"heard {heard!r} in {time.monotonic() - t0:.1f}s")

    said = set(SENTENCE.lower().replace(",", "").replace(".", "").split())
    got = set(heard.lower().replace(",", "").replace(".", "").split())
    assert len(said & got) / len(said) >= 0.8, f"round trip lost too much: {heard!r}"


class _Slow(speakers.Speaker):
    engine = "chatterbox-nano"

    def speak(self, text, speed=1.0, voice=None):
        time.sleep(0.05)
        return speakers.Audio(np.zeros(240, dtype=np.float32), 24000)  # 0.01 s of speech in 0.05 s


class _Broken(speakers.Speaker):
    engine = "chatterbox-turbo"
    voice = "default"

    def speak(self, text, speed=1.0, voice=None):
        raise RuntimeError("GPU went away")


def fallbacks(settings):
    # Not downloaded: Kokoro, saying why.
    loaded = speakers.load_speaker("chatterbox-nano", settings.models_dir / "nowhere", settings.voices_dir)
    assert loaded.engine == "kokoro" and loaded.fell_back and "downloaded" in loaded.note, loaded

    # Downloaded but too slow for this machine: Kokoro.
    real_build = speakers._build
    speakers._build = lambda *a, **k: _Slow()
    try:
        loaded = speakers.load_speaker("chatterbox-nano", settings.models_dir, settings.voices_dir)
    finally:
        speakers._build = real_build
    assert loaded.engine == "kokoro" and "too slow" in loaded.note, loaded

    # Fails mid-call: that sentence, and the rest of the call, in Kokoro.
    from bookwyrm_voice.tts import SpeakerTTSService

    kokoro = loaded.speaker
    svc = SpeakerTTSService(speaker=_Broken(), fallback=lambda: kokoro, sample_rate=24000)
    svc._sample_rate = 24000  # normally set when the pipeline starts

    async def say():
        return [f async for f in svc.run_tts("Still here [chuckle].", "ctx")]

    frames = asyncio.run(say())
    audio = [f for f in frames if type(f).__name__ == "TTSAudioRawFrame"]
    assert audio and len(audio[0].audio) > 24000, f"no fallback speech: {[type(f).__name__ for f in frames]}"
    assert svc._speaker is kokoro
    print("ok: falls back to Kokoro (not downloaded, too slow, failing mid-call)")


def main():
    settings = load_settings()
    t0 = time.monotonic()
    engines = Engines(settings)
    print(f"loaded models in {time.monotonic() - t0:.1f}s; speaking with {engines.status()}")
    if engines.speaker.engine == "kokoro":
        assert len(engines.speaker.voices()) >= 20, "Kokoro's English voices are missing"
    round_trip(engines)
    print("ok: speech round trip")
    fallbacks(settings)


if __name__ == "__main__":
    main()
