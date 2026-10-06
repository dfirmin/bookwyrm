"""Text to speech: Kokoro-82M (Apache-2.0) through sherpa-onnx, fully local.

Pipecat splits the model's streaming text into sentences and calls ``run_tts`` once per
sentence, so Bookwyrm starts talking while the rest of the answer is still being written.
"""

from __future__ import annotations

import asyncio
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


class KokoroSherpaTTSService(TTSService):
    def __init__(self, *, model_dir: Path, voice: str = "af_heart", speed: float = 1.0, threads: int = 4,
                 spoken_log=None, **kwargs):
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            settings=TTSSettings(model="kokoro-82m-v1.0", voice=voice, language="en-us"),
            **kwargs,
        )
        ids = voice_ids(model_dir)
        if voice not in ids:
            raise ValueError(f"Kokoro has no voice {voice!r}; choose one of: {', '.join(sorted(ids))}")
        self._sid = ids[voice]
        self._speed = speed
        self._tts = load_kokoro(model_dir, threads)
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
            audio = await asyncio.to_thread(self._tts.generate, text, sid=self._sid, speed=self._speed)
            await self.stop_ttfb_metrics()
            pcm = (np.clip(np.asarray(audio.samples, dtype=np.float32), -1, 1) * 32767).astype(np.int16).tobytes()
            pcm = await self._resampler.resample(pcm, audio.sample_rate, self.sample_rate)
            yield TTSAudioRawFrame(audio=pcm, sample_rate=self.sample_rate, num_channels=1, context_id=context_id)
        except Exception as e:  # pragma: no cover - surfaced as an ErrorFrame
            yield ErrorFrame(error=f"Speech synthesis failed: {e}")
