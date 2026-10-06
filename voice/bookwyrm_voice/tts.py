"""Text to speech: Kokoro-82M (Apache-2.0) through sherpa-onnx, fully local.

Pipecat splits the model's streaming text into sentences and calls ``run_tts`` once per
sentence, so Bookwyrm starts talking while the rest of the answer is still being written.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncGenerator
from pathlib import Path

import numpy as np
import onnxruntime as ort
import sherpa_onnx
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService


def voice_ids(model_dir: Path) -> dict[str, int]:
    """Kokoro voice name -> speaker id, read from the model's own metadata."""
    meta = ort.InferenceSession(str(model_dir / "model.onnx"), providers=["CPUExecutionProvider"])
    names = meta.get_modelmeta().custom_metadata_map.get("speaker_names", "")
    return {name: i for i, name in enumerate(n.strip() for n in names.split(",") if n.strip())}


def load_kokoro(model_dir: Path, threads: int = 4) -> sherpa_onnx.OfflineTts:
    return sherpa_onnx.OfflineTts(
        sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(model_dir / "model.onnx"),
                    voices=str(model_dir / "voices.bin"),
                    tokens=str(model_dir / "tokens.txt"),
                    data_dir=str(model_dir / "espeak-ng-data"),
                    lexicon=str(model_dir / "lexicon-us-en.txt"),
                ),
                num_threads=threads,
            )
        )
    )


class Kokoro:
    """The loaded Kokoro model, shared by every call in the process (loading takes seconds)."""

    def __init__(self, model_dir: Path, voice: str = "af_heart", threads: int = 4):
        self.ids = voice_ids(model_dir)
        self.set_voice(voice)
        self.engine = load_kokoro(model_dir, threads)
        self._lock = threading.Lock()

    def set_voice(self, voice: str):
        """Switch voice for the next sentence (same model; nothing to reload)."""
        if voice not in self.ids:
            raise ValueError(f"Kokoro has no voice {voice!r}; choose one of: {', '.join(sorted(self.ids))}")
        self.voice, self.sid = voice, self.ids[voice]

    def generate(self, text: str, speed: float, voice: str | None = None):
        sid = self.ids[voice] if voice else self.sid
        with self._lock:
            return self.engine.generate(text, sid=sid, speed=speed)


# Kokoro's English voices: prefix a = American, b = British; f/m = female/male.
_ACCENT = {"a": "American", "b": "British"}
_GENDER = {"f": "female", "m": "male"}


def english_voices(ids: dict[str, int]) -> list[dict]:
    out = []
    for name in sorted(ids):
        prefix, _, given = name.partition("_")
        if len(prefix) == 2 and prefix[0] in _ACCENT and prefix[1] in _GENDER and given:
            out.append({"id": name, "label": given.capitalize(),
                        "detail": f"{_ACCENT[prefix[0]]}, {_GENDER[prefix[1]]}"})
    return out


class KokoroSherpaTTSService(TTSService):
    def __init__(self, *, kokoro: Kokoro, speed: float = 1.0, spoken_log=None, **kwargs):
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            settings=TTSSettings(model="kokoro-82m-v1.0", voice=kokoro.voice, language="en-us"),
            **kwargs,
        )
        self._kokoro = kokoro
        self._speed = speed
        self._resampler = create_stream_resampler()
        self._spoken_log = spoken_log

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        text = text.strip()
        if not text:
            return
        if self._spoken_log is not None:
            self._spoken_log.add(text)
        try:
            await self.start_tts_usage_metrics(text)
            audio = await asyncio.to_thread(self._kokoro.generate, text, self._speed)
            await self.stop_ttfb_metrics()
            pcm = (np.clip(np.asarray(audio.samples, dtype=np.float32), -1, 1) * 32767).astype(np.int16).tobytes()
            pcm = await self._resampler.resample(pcm, audio.sample_rate, self.sample_rate)
            yield TTSAudioRawFrame(audio=pcm, sample_rate=self.sample_rate, num_channels=1, context_id=context_id)
        except Exception as e:  # pragma: no cover - surfaced as an ErrorFrame
            yield ErrorFrame(error=f"Speech synthesis failed: {e}")
