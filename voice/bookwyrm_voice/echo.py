"""Second line of defence against Bookwyrm hearing itself through laptop speakers.

The app's WebRTC echo cancellation removes most of Bookwyrm's voice from the microphone. What
leaks through can still be transcribed and look like the caller speaking ("And there's no
marketing." — really Bookwyrm's own words). This filter sits between speech recognition and the
turn logic and drops transcripts that are mostly words Bookwyrm spoke in the last few seconds.
"""

from __future__ import annotations

import re
import time
from collections import deque

from loguru import logger
from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

_WORD = re.compile(r"[a-z0-9]+")


def words(text: str) -> list[str]:
    # "there's" -> "there s", "isn't" -> "isn t": contractions transcribe inconsistently
    return _WORD.findall(text.lower().replace("'", " ").replace("\u2019", " "))


def pairs(ws: list[str]) -> set[tuple[str, str]]:
    return set(zip(ws, ws[1:]))


class SpokenLog:
    """What Bookwyrm said recently; written by the TTS service, read by the guard."""

    def __init__(self, window: float = 12.0):
        self.window = window
        self._entries: deque[tuple[float, list[str]]] = deque()

    def add(self, text: str):
        self._entries.append((time.monotonic(), words(text)))
        self._trim()

    def recent_pairs(self) -> set[tuple[str, str]]:
        self._trim()
        return {p for _, ws in self._entries for p in pairs(ws)}

    def _trim(self):
        cutoff = time.monotonic() - self.window
        while self._entries and self._entries[0][0] < cutoff:
            self._entries.popleft()


class EchoGuard(FrameProcessor):
    def __init__(self, spoken: SpokenLog, overlap: float = 0.6, min_words: int = 3, **kwargs):
        super().__init__(**kwargs)
        self._spoken, self._overlap, self._min_words = spoken, overlap, min_words

    def is_echo(self, text: str) -> bool:
        if text.strip().endswith("?"):
            return False  # the caller asking about what Bookwyrm just said; echoes are statements
        heard = words(text)
        if len(heard) < self._min_words:
            return False
        said = self._spoken.recent_pairs()
        if not said:
            return False
        # Word *order* separates an echo (a stretch of Bookwyrm's own sentence) from a caller who
        # reuses a few of its words ("what about the phishing runbook?").
        heard_pairs = pairs(heard)
        return sum(p in said for p in heard_pairs) / len(heard_pairs) >= self._overlap

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and self.is_echo(frame.text):
            logger.info(f"Ignored own echo: {frame.text!r}")
            return
        await self.push_frame(frame, direction)
