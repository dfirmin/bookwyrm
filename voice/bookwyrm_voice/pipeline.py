"""The call pipeline: microphone -> words -> Bookwyrm (Hermes) -> voice -> speaker.

    transport.input()            caller's audio (WebRTC from the companion app, or a test file)
    ParakeetSTTService           one transcript per utterance
    EchoGuard                    drops "caller" transcripts that are really Bookwyrm's own voice
    user aggregator              Silero voice activity starts a turn (and interrupts Bookwyrm);
                                 smart-turn v3 decides when the caller has actually finished
    HermesRunsLLMService         the Bookwyrm profile answers, streaming
    KokoroSherpaTTSService       spoken sentence by sentence
    transport.output()           to the caller
    assistant aggregator         records what was actually said, cut short where interrupted
"""

from __future__ import annotations

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
from .models import STT_MODEL, TTS_MODEL, ensure_model
from .stt import ParakeetSTTService, load_recognizer
from .tts import Kokoro, KokoroSherpaTTSService

# Silero's defaults, slightly less eager to start a turn on a cough or a keyboard click.
VAD = VADParams(confidence=0.7, start_secs=0.25, stop_secs=0.2, min_volume=0.6)


class Engines:
    """Speech models are slow to load, so load once per process and share across calls."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.stt_dir = ensure_model(settings.models_dir, STT_MODEL)
        self.tts_dir = ensure_model(settings.models_dir, TTS_MODEL)
        self.recognizer = load_recognizer(self.stt_dir)
        self.kokoro = Kokoro(self.tts_dir, settings.voice)

    def stt(self) -> ParakeetSTTService:
        return ParakeetSTTService(recognizer=self.recognizer)

    def tts(self, spoken_log: SpokenLog | None = None) -> KokoroSherpaTTSService:
        return KokoroSherpaTTSService(
            kokoro=self.kokoro, speed=self.settings.voice_speed,
            spoken_log=spoken_log,
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
        instructions=settings.instructions + instructions_extra, session_id=session_id,
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
