"""Hermes as the "LLM" of the voice pipeline.

Each user turn becomes one Hermes run on the Bookwyrm profile (``POST /v1/runs``):

- ``session_id`` is per call, so Hermes holds the whole conversation, its tool calls included,
  in its own session history; we only send what the caller just said.
- ``instructions`` carries the on-a-call speaking style.
- Text deltas stream straight into text-to-speech, sentence by sentence.
- When the caller talks over Bookwyrm, Pipecat cancels this task; we then ``POST .../stop`` so
  Hermes abandons the turn instead of finishing it (and its tool calls) in the background.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import httpx
from loguru import logger
from pipecat.frames.frames import (
    Frame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings

_TERMINAL = {"run.completed", "run.failed", "run.cancelled", "run.interrupted"}

# Said when the line has been quiet this long mid-answer (a slow model call or tool).
FILLER_AFTER = 4.0
FILLERS = ("Still looking.", "Bear with me, almost there.")

UNREACHABLE ="Sorry, I can't reach my notes right now. Is Hermes running on this machine?"
FAILED = "Hmm, something went wrong on my end. Can you say that again?"


def last_user_text(context: LLMContext) -> str:
    for msg in reversed(context.get_messages()):
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            return " ".join(p.get("text", "") for p in content if isinstance(p, dict)).strip()
    return ""


class HermesRunsLLMService(LLMService):
    def __init__(self, *, base_url: str, api_key: str, instructions: str, session_id: str | None = None,
                 timeout: float = 180.0, **kwargs):
        super().__init__(
            settings=LLMSettings(
                model="bookwyrm", system_instruction=None, temperature=None, max_tokens=None, top_p=None,
                top_k=None, frequency_penalty=None, presence_penalty=None, seed=None,
                filter_incomplete_user_turns=False, user_turn_completion_config=None,
            ),
            **kwargs,
        )
        self._base = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._instructions = instructions
        self.session_id = session_id or f"voice-{uuid.uuid4().hex[:12]}"
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=5.0))
        self._background: set[asyncio.Task] = set()
        self.last_run_id: str | None = None

    def can_generate_metrics(self) -> bool:
        return True

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            await self.push_frame(LLMFullResponseStartFrame())
            await self.start_processing_metrics()
            try:
                await self._answer(last_user_text(frame.context))
            finally:
                await self.stop_processing_metrics()
                await self.push_frame(LLMFullResponseEndFrame())
        else:
            await self.push_frame(frame, direction)

    async def _answer(self, text: str):
        if not text:
            return
        await self.start_ttfb_metrics()
        run_id = None
        reader: asyncio.Task | None = None
        try:
            r = await self._client.post(
                f"{self._base}/runs", headers=self._headers,
                json={"input": text, "session_id": self.session_id, "instructions": self._instructions},
            )
            r.raise_for_status()
            run_id = self.last_run_id = r.json()["run_id"]
            logger.info(f"Hermes run {run_id} for: {text!r}")
            events: asyncio.Queue = asyncio.Queue()
            reader = asyncio.create_task(self._read_events(run_id, events))
            await self._speak_events(run_id, events, reader)
        except asyncio.CancelledError:
            # Interrupted by the caller. Tell Hermes to stop, without blocking the cancellation.
            if run_id:
                task = asyncio.ensure_future(self._stop(run_id))
                self._background.add(task)
                task.add_done_callback(self._background.discard)
            raise
        except httpx.ConnectError:
            logger.error(f"Hermes unreachable at {self._base}")
            await self._push_llm_text(UNREACHABLE)
        except Exception as e:
            logger.exception(f"Hermes run failed: {e}")
            await self._push_llm_text(FAILED)
        finally:
            if reader and not reader.done():
                reader.cancel()

    async def _read_events(self, run_id: str, out: asyncio.Queue):
        try:
            async with self._client.stream("GET", f"{self._base}/runs/{run_id}/events", headers=self._headers) as s:
                async for line in s.aiter_lines():
                    if line.startswith("data:"):
                        try:
                            await out.put(json.loads(line[5:]))
                        except json.JSONDecodeError:
                            continue
        finally:
            await out.put(None)

    async def _speak_events(self, run_id: str, events: asyncio.Queue, reader: asyncio.Task):
        """Turn Hermes events into speech, keeping the line from going quiet.

        - Text deltas go to text-to-speech as they arrive.
        - When Hermes starts a tool, whatever it has said so far ("Let me check the repo.") is
          spoken now: Pipecat's sentence splitter would otherwise hold the last sentence until the
          next one starts, i.e. until the tool and the next model call have finished.
        - If nothing has been said for FILLER_AFTER seconds while Hermes is still working (a slow
          model call, a slow tool), say a short "still looking" line, at most twice per answer.
        """
        loop = asyncio.get_running_loop()
        last_said = loop.time()
        unspoken = False
        fillers = 0
        first = True
        while True:
            try:
                ev = await asyncio.wait_for(events.get(), timeout=0.5)
            except TimeoutError:
                if loop.time() - last_said > FILLER_AFTER and fillers < len(FILLERS):
                    if unspoken:
                        await self._end_segment()
                        unspoken = False
                    await self._push_llm_text(FILLERS[fillers])
                    await self._end_segment()
                    fillers += 1
                    last_said = loop.time()
                continue
            if ev is None:
                return
            kind = ev.get("event")
            if kind == "message.delta" and ev.get("delta"):
                if first:
                    logger.info(f"Hermes first words: {ev['delta']!r}")
                    first = False
                await self.stop_ttfb_metrics()
                await self._push_llm_text(ev["delta"])
                unspoken = True
                last_said = loop.time()
            elif kind == "tool.started":
                logger.debug(f"Hermes tool: {ev.get('tool')}")
                if unspoken:
                    await self._end_segment()
                    unspoken = False
                    last_said = loop.time()
            elif kind in _TERMINAL:
                if kind != "run.completed":
                    logger.warning(f"Hermes run {run_id} ended {kind}: {ev.get('error', '')}")
                return

    async def _end_segment(self):
        """Close the current stretch of speech so it is voiced now, and open the next one."""
        await self.push_frame(LLMFullResponseEndFrame())
        await self.push_frame(LLMFullResponseStartFrame())

    async def _stop(self, run_id: str):
        try:
            await self._client.post(f"{self._base}/runs/{run_id}/stop", headers=self._headers, timeout=5.0)
            logger.info(f"Stopped Hermes run {run_id} (caller interrupted)")
        except Exception as e:  # pragma: no cover
            logger.warning(f"Could not stop Hermes run {run_id}: {e}")

    async def warm_up(self):
        """Cheap request at ring time so the first real answer isn't a cold start."""
        try:
            await self._client.get(f"{self._base}/models", headers=self._headers, timeout=5.0)
        except Exception:
            pass

    async def cleanup(self):
        await super().cleanup()
        await self._client.aclose()
