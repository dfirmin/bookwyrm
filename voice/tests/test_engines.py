"""The speech engines work on this machine: Kokoro says a sentence, Parakeet hears it back.

    python tests/test_engines.py        (needs the models: python -m bookwyrm_voice.models)
"""

import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bookwyrm_voice.config import load_settings  # noqa: E402
from bookwyrm_voice.pipeline import Engines  # noqa: E402
from bookwyrm_voice.stt import transcribe  # noqa: E402
from bookwyrm_voice.tts import english_voices  # noqa: E402

SENTENCE = "One draft is in quarantine, and two gaps are still open."


def main():
    t0 = time.monotonic()
    engines = Engines(load_settings())
    print(f"loaded both models in {time.monotonic() - t0:.1f}s")
    assert len(english_voices(engines.kokoro.ids)) >= 20, "Kokoro's English voices are missing"

    t0 = time.monotonic()
    audio = engines.kokoro.generate(SENTENCE, 1.0)
    samples = np.asarray(audio.samples, dtype=np.float32)
    print(f"spoke {len(samples) / audio.sample_rate:.1f}s of audio in {time.monotonic() - t0:.1f}s")

    # Parakeet listens at 16 kHz.
    n = int(len(samples) * 16000 / audio.sample_rate)
    at16k = np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples).astype(np.float32)
    t0 = time.monotonic()
    heard = transcribe(engines.recognizer, (np.clip(at16k, -1, 1) * 32767).astype(np.int16).tobytes())
    print(f"heard {heard!r} in {time.monotonic() - t0:.1f}s")

    said = set(SENTENCE.lower().replace(",", "").replace(".", "").split())
    got = set(heard.lower().replace(",", "").replace(".", "").split())
    assert len(said & got) / len(said) >= 0.8, f"round trip lost too much: {heard!r}"
    print("ok: speech round trip")


if __name__ == "__main__":
    main()
