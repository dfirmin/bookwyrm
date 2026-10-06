"""Speech to text: NVIDIA Parakeet TDT 0.6B v2 (English) through sherpa-onnx, fully local.

Pipecat's SegmentedSTTService hands us one utterance at a time — cut by voice activity
detection — as raw 16 kHz, 16-bit mono PCM.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from pathlib import Path

import numpy as np
import sherpa_onnx
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

SAMPLE_RATE = 16000


def _one(model_dir: Path, pattern: str) -> str:
    hits = sorted(model_dir.glob(pattern))
    if not hits:
        raise FileNotFoundError(f"{model_dir}: no file matching {pattern}")
    return str(hits[0])


def load_recognizer(model_dir: Path, threads: int = 2) -> sherpa_onnx.OfflineRecognizer:
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=_one(model_dir, "encoder*.onnx"),
        decoder=_one(model_dir, "decoder*.onnx"),
        joiner=_one(model_dir, "joiner*.onnx"),
        tokens=str(model_dir / "tokens.txt"),
        model_type="nemo_transducer",
        num_threads=threads,
    )


def transcribe(recognizer: sherpa_onnx.OfflineRecognizer, pcm16: bytes) -> str:
    samples = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
    stream = recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


class ParakeetSTTService(SegmentedSTTService):
    """One transcription per utterance; Parakeet adds punctuation and capitalisation itself."""

    def __init__(self, *, recognizer: sherpa_onnx.OfflineRecognizer, **kwargs):
        """``recognizer`` is loaded once per process (see pipeline.Engines) and shared by calls."""
        super().__init__(
            sample_rate=SAMPLE_RATE,
            settings=STTSettings(model="parakeet-tdt-0.6b-v2", language=Language.EN),
            **kwargs,
        )
        self._recognizer = recognizer

    @property
    def wants_wav_segments(self) -> bool:
        return False  # raw PCM, which is what sherpa reads

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        await self.start_processing_metrics()
        try:
            text = await asyncio.to_thread(transcribe, self._recognizer, audio)
        except Exception as e:  # pragma: no cover - surfaced as an ErrorFrame
            yield ErrorFrame(error=f"Speech recognition failed: {e}")
            return
        finally:
            await self.stop_processing_metrics()
        if text:
            logger.debug(f"Heard: {text!r}")
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.EN)
