"""The call pipeline: microphone -> words -> Bookwyrm (Hermes) -> voice -> speaker.

    transport.input()            caller's audio (WebRTC from the companion app, or a test file)
    ParakeetSTTService           one transcript per utterance
    EchoGuard                    drops "caller" transcripts that are really Bookwyrm's own voice
    user aggregator              Silero voice activity starts a turn (and interrupts Bookwyrm);
                                 smart-turn v3 decides when the caller has actually finished
    HermesRunsLLMService         the Bookwyrm profile answers, streaming
    SpeakerTTSService            spoken sentence by sentence (Kokoro, or Chatterbox: see speakers.py)
    transport.output()           to the caller
    assistant aggregator         records what was actually said, cut short where interrupted
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.transports.base_transport import BaseTransport
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter

from .config import Settings
from .echo import EchoGuard, SpokenLog
from .hermes_llm import HermesRunsLLMService
from .models import STT_MODEL, ensure_model
from .speakers import CALL_TAGS, KokoroSpeaker, Loaded, Speaker, load_speaker
from .stt import ParakeetSTTService, load_recognizer
from .tts import SpeakerTTSService

# Silero's defaults, slightly less eager to start a turn on a cough or a keyboard click.
VAD = VADParams(confidence=0.7, start_secs=0.25, stop_secs=0.2, min_volume=0.6)


# Added to the call prompt when the voice can make sounds (Chatterbox).
SOUNDS_PROMPT = (
    "\n\nYour voice can make a few real sounds: " + ", ".join(CALL_TAGS) + ". Write one inline, exactly "
    "like that, where a person on the phone would actually make it: a [chuckle] at something mildly funny, "
    "a [sigh] before admitting a problem. At most one in an answer; most answers need none."
)


class Engines:
    """Speech models are slow to load, so load once per process and share across calls."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.stt_dir = ensure_model(settings.models_dir, STT_MODEL)
        self.recognizer = load_recognizer(self.stt_dir)
        self._lock = threading.Lock()
        self._kokoro: KokoroSpeaker | None = None
        self.loaded: Loaded = self._load(settings)

    def _load(self, settings: Settings) -> Loaded:
        loaded = load_speaker(settings.voice_engine, settings.models_dir, settings.voices_dir,
                              kokoro_voice=settings.voice, natural_voice=settings.natural_voice)
        if isinstance(loaded.speaker, KokoroSpeaker):
            self._kokoro = loaded.speaker
        return loaded

    @property
    def speaker(self) -> Speaker:
        return self.loaded.speaker

    def kokoro(self) -> KokoroSpeaker:
        """Kokoro, loaded on first need when a natural voice is speaking (it's the fallback)."""
        with self._lock:
            if self._kokoro is None:
                self._kokoro = KokoroSpeaker(self.settings.models_dir, self.settings.voice)
            return self._kokoro

    def apply(self, settings: Settings) -> None:
        """New settings: reload the speaking engine if it changed, else just switch voice.
        Blocking (loading Chatterbox takes a while); calls already in progress keep their voice."""
        engine_changed = settings.voice_engine != self.settings.voice_engine
        self.settings = settings
        if engine_changed:  # (a fallback isn't retried on every settings change; Restart retries it)
            self.loaded = self._load(settings)
            return
        voice = settings.voice if isinstance(self.speaker, KokoroSpeaker) else settings.natural_voice
        self.speaker.set_voice(voice)
        if self._kokoro is not None and self._kokoro is not self.speaker:
            self._kokoro.set_voice(settings.voice)

    def status(self) -> dict:
        return {"engine": self.loaded.engine, "wanted": self.loaded.wanted, "label": self.speaker.label,
                "note": self.loaded.note, "real_time_factor": self.loaded.real_time_factor,
                "tags": self.speaker.tags, "speed_control": self.speaker.speed_control}

    def stt(self) -> ParakeetSTTService:
        return ParakeetSTTService(recognizer=self.recognizer)

    def tts(self, spoken_log: SpokenLog | None = None) -> SpeakerTTSService:
        return SpeakerTTSService(
            speaker=self.speaker, speed=self.settings.voice_speed,
            spoken_log=spoken_log, fallback=self.kokoro,
            text_filters=[MarkdownTextFilter()],  # belt and braces: the prompt already says no markdown
        )


@dataclass
class Call:
    task: PipelineTask
    llm: HermesRunsLLMService
    context: LLMContext


def build_call(transport: BaseTransport, settings: Settings, engines: Engines, *, greet: bool = True,
               session_id: str | None = None, instructions_extra: str = "") -> Call:
    """``greet=True`` says hello as soon as the pipeline starts (the headless tests); the server
    passes False and greets when the app's audio is actually connected."""
    llm = HermesRunsLLMService(
        base_url=settings.hermes_url, api_key=settings.hermes_key,
        instructions=settings.instructions + (SOUNDS_PROMPT if engines.speaker.tags else "") + instructions_extra,
        session_id=session_id,
    )
    spoken = SpokenLog()
    context = LLMContext()
    aggregators = LLMContextAggregatorPair(
        context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer(params=VAD)),
    )
    pipeline = Pipeline([
        transport.input(),
        engines.stt(),
        EchoGuard(spoken),
        aggregators.user(),
        llm,
        engines.tts(spoken),
        transport.output(),
        aggregators.assistant(),
    ])
    task = PipelineTask(
        pipeline,
        params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000, enable_metrics=True),
    )
    if greet and settings.greeting:
        # Picking up the phone: say hello straight away, no model round-trip.
        _queue_greeting(task, settings.greeting)
    return Call(task=task, llm=llm, context=context)


def _queue_greeting(task: PipelineTask, text: str):
    @task.event_handler("on_pipeline_started")
    async def _greet(task, frame):  # noqa: ARG001
        await task.queue_frame(TTSSpeakFrame(text))


async def greet(call: Call, text: str):
    await call.task.queue_frame(TTSSpeakFrame(text))
