"""Headless call simulator: a scripted caller talks to the real pipeline in real time.

The caller's lines are synthesized with a different Kokoro voice. A fake transport plays them
into the pipeline as 20 ms microphone frames, paces Bookwyrm's audio as a speaker would, and
records both sides. Optionally Bookwyrm's own voice leaks back into the "mic" (``--echo``) to
mimic a laptop's speakers with no echo cancellation: the worst case for self-interruption.

    python tests/call_sim.py --out call.wav [--echo 0.3]

Produces a stereo WAV (left: caller, right: Bookwyrm) and a timeline with response latencies
and how fast Bookwyrm stopped when interrupted.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loguru import logger  # noqa: E402
from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame, StartFrame  # noqa: E402
from pipecat.workers.runner import WorkerRunner  # noqa: E402
from pipecat.transports.base_input import BaseInputTransport  # noqa: E402
from pipecat.transports.base_output import BaseOutputTransport  # noqa: E402
from pipecat.transports.base_transport import BaseTransport, TransportParams  # noqa: E402

from bookwyrm_voice.config import load_settings  # noqa: E402
from bookwyrm_voice.pipeline import Engines, build_call  # noqa: E402
from bookwyrm_voice.tts import load_kokoro, voice_ids  # noqa: E402

IN_SR, OUT_SR, FRAME = 16000, 24000, 0.02  # 20 ms mic frames


def resample(x: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    if sr_from == sr_to or len(x) == 0:
        return x
    n = int(len(x) * sr_to / sr_from)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


@dataclass
class Tape:
    """Shared state: what each side said and when (seconds since the call started)."""
    t0: float = 0.0
    caller: list[np.ndarray] = field(default_factory=list)   # 16 kHz, one array per 20 ms frame
    bot: list[tuple[float, np.ndarray]] = field(default_factory=list)  # (start, 24 kHz samples)
    caller_turns: list[tuple[float, float, str]] = field(default_factory=list)
    bot_last_audio: float = -1.0
    bot_started: float = -1.0
    echo_q: list[np.ndarray] = field(default_factory=list)
    mic_starts: list[float] = field(default_factory=list)

    def now(self) -> float:
        return time.monotonic() - self.t0

    def bot_speaking(self) -> bool:
        return self.bot_last_audio >= 0 and self.now() - self.bot_last_audio < 0.25


class SimInput(BaseInputTransport):
    def __init__(self, tape: Tape, echo: float, params: TransportParams):
        super().__init__(params)
        self._tape, self._echo = tape, echo
        self._speech: np.ndarray | None = None
        self._pos = 0
        self._task: asyncio.Task | None = None

    def say(self, samples: np.ndarray):
        self._speech, self._pos = samples, 0
        self._tape.mic_starts.append(self._tape.now())
        logger.info(f"MIC speech begins at {self._tape.now():.2f}s ({len(samples)/IN_SR:.1f}s long)")

    @property
    def talking(self) -> bool:
        return self._speech is not None

    async def start(self, frame: StartFrame):
        await super().start(frame)
        await self.set_transport_ready(frame)
        self._tape.t0 = time.monotonic()
        self._task = asyncio.create_task(self._pump())

    async def _pump(self):
        n = int(IN_SR * FRAME)
        nxt = time.monotonic()
        while True:
            mic = np.zeros(n, dtype=np.float32)
            if self._speech is not None:
                chunk = self._speech[self._pos:self._pos + n]
                mic[:len(chunk)] += chunk
                self._pos += n
                if self._pos >= len(self._speech):
                    self._speech = None
            if self._echo and self._tape.echo_q:
                e = self._tape.echo_q.pop(0)[:n]
                mic[:len(e)] += self._echo * e
            self._tape.caller.append(mic.copy())
            lag = time.monotonic() - nxt
            if lag > 0.1:
                logger.warning(f"MIC pump running {lag:.2f}s late")
            pcm = (np.clip(mic, -1, 1) * 32767).astype(np.int16).tobytes()
            await self.push_audio_frame(InputAudioRawFrame(audio=pcm, sample_rate=IN_SR, num_channels=1))
            nxt += FRAME
            await asyncio.sleep(max(0.0, nxt - time.monotonic()))

    async def cleanup(self):
        if self._task:
            self._task.cancel()
        await super().cleanup()


class SimOutput(BaseOutputTransport):
    def __init__(self, tape: Tape, params: TransportParams):
        super().__init__(params)
        self._tape = tape

    async def start(self, frame: StartFrame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        x = np.frombuffer(frame.audio, dtype=np.int16).astype(np.float32) / 32768.0
        t = self._tape.now()
        self._tape.bot.append((t, x))
        if np.abs(x).max(initial=0) > 0.01:
            if not self._tape.bot_speaking():
                self._tape.bot_started = t
            self._tape.bot_last_audio = t
            # what the mic would pick up from the speakers, 20 ms later, in 20 ms pieces
            e16 = resample(x, frame.sample_rate, IN_SR)
            step = int(IN_SR * FRAME)
            self._tape.echo_q.extend(e16[i:i + step] for i in range(0, len(e16), step))
        await asyncio.sleep(len(x) / frame.sample_rate)  # a speaker takes real time to play it
        return True


class SimTransport(BaseTransport):
    def __init__(self, tape: Tape, echo: float):
        super().__init__()
        p = TransportParams(audio_in_enabled=True, audio_in_sample_rate=IN_SR,
                            audio_out_enabled=True, audio_out_sample_rate=OUT_SR)
        self._in, self._out = SimInput(tape, echo, p), SimOutput(tape, p)

    def input(self):
        return self._in

    def output(self):
        return self._out


class Caller:
    """Synthesizes the caller's lines (a different Kokoro voice) and speaks them into the call."""

    def __init__(self, engines: Engines, tape: Tape, mic: SimInput, voice: str = "am_michael"):
        self._tts = load_kokoro(engines.tts_dir, threads=2)
        self._sid = voice_ids(engines.tts_dir)[voice]
        self._tape, self._mic = tape, mic

    async def say(self, text: str):
        a = await asyncio.to_thread(self._tts.generate, text, sid=self._sid, speed=1.0)
        x = resample(np.asarray(a.samples, dtype=np.float32), a.sample_rate, IN_SR)
        start = self._tape.now()
        self._mic.say(x)
        while self._mic.talking:
            await asyncio.sleep(0.02)
        self._tape.caller_turns.append((start, self._tape.now(), text))
        logger.info(f"CALLER [{start:5.1f}s] {text}")

    async def wait_bot_done(self, quiet: float = 1.2, timeout: float = 90, after: float = 0.0):
        """Wait until Bookwyrm has spoken (after time `after`) and then been quiet for `quiet` seconds."""
        t_end = self._tape.now() + timeout
        while self._tape.now() < t_end:
            if self._tape.bot_last_audio > after and not self._tape.bot_speaking() and \
                    self._tape.now() - self._tape.bot_last_audio > quiet:
                return
            await asyncio.sleep(0.05)
        raise TimeoutError("Bookwyrm never finished talking")

    async def wait_bot_speaking_for(self, seconds: float, timeout: float = 60, after: float = 0.0):
        t_end = self._tape.now() + timeout
        while self._tape.now() < t_end:
            if self._tape.bot_speaking() and self._tape.bot_started > after and \
                    self._tape.now() - self._tape.bot_started > seconds:
                return
            await asyncio.sleep(0.02)
        raise TimeoutError("Bookwyrm never started a long enough answer")


def first_bot_audio_after(tape: Tape, t: float) -> float | None:
    for start, x in tape.bot:
        if start >= t and np.abs(x).max(initial=0) > 0.01:
            return start
    return None


def last_bot_audio_before(tape: Tape, t: float) -> float | None:
    """End of the last loud bot chunk that started before t."""
    last = None
    for start, x in tape.bot:
        if start > t:
            break
        if np.abs(x).max(initial=0) > 0.01:
            last = start + len(x) / OUT_SR
    return last


def write_stereo(tape: Tape, path: Path):
    total = max(len(tape.caller) * FRAME, max((s + len(x) / OUT_SR for s, x in tape.bot), default=0)) + 0.5
    n = int(total * OUT_SR)
    left, right = np.zeros(n, np.float32), np.zeros(n, np.float32)
    mic = resample(np.concatenate(tape.caller) if tape.caller else np.zeros(1, np.float32), IN_SR, OUT_SR)
    left[:len(mic)] = mic[:n]
    for start, x in tape.bot:
        i = int(start * OUT_SR)
        right[i:i + len(x)] += x[: max(0, n - i)]
    st = np.stack([left, right], axis=1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(OUT_SR)
        w.writeframes((np.clip(st, -1, 1) * 32767).astype(np.int16).tobytes())


async def main(out: Path, echo: float):
    settings = load_settings()
    engines = Engines(settings)
    tape = Tape()
    transport = SimTransport(tape, echo)
    call = build_call(transport, settings, engines)
    caller = Caller(engines, tape, transport.input())
    runner = WorkerRunner(handle_sigint=False)
    results: dict[str, object] = {}

    async def script():
        await caller.wait_bot_done(quiet=0.8)                       # the greeting
        results["greeting_at"] = round(tape.bot_started, 2)
        await caller.say("Hey. What's in quarantine right now?")
        q1_end = tape.now()
        await caller.wait_bot_done(quiet=4.5, after=q1_end)
        results["answer1_latency"] = round((first_bot_audio_after(tape, q1_end) or -1) - q1_end, 2)

        await caller.say("Okay. And can you walk me through all the open gaps?")
        q2_end = tape.now()
        await caller.wait_bot_speaking_for(2.5, after=q2_end)
        results["answer2_latency"] = round(tape.bot_started - q2_end, 2)
        runs_before = call.llm.last_run_id
        await caller.say("Sorry, actually, just the high priority one.")
        barge_at = tape.mic_starts[-1]
        stopped = last_bot_audio_before(tape, barge_at + 3.0)
        results["interrupt_started"] = round(barge_at, 2)
        results["bot_stopped_after_interrupt"] = round((stopped or barge_at) - barge_at, 2)
        results["interrupted_run"] = runs_before
        q3_end = tape.now()
        await caller.wait_bot_done(quiet=4.5, after=q3_end)
        results["answer3_latency"] = round((first_bot_audio_after(tape, q3_end) or -1) - q3_end, 2)
        await call.task.cancel()

    await asyncio.gather(runner.run(call.task), script())
    write_stereo(tape, out)
    import httpx
    if results.get("interrupted_run"):
        st = httpx.get(f"{settings.hermes_url}/runs/{results['interrupted_run']}",
                       headers={"Authorization": f"Bearer {settings.hermes_key}"}).json()
        results["interrupted_run_status"] = st.get("status")
    print("\nRESULTS", results)
    print("CONVERSATION")
    for m in call.context.get_messages():
        print(f"  {m.get('role')}: {m.get('content')}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("call.wav"))
    ap.add_argument("--echo", type=float, default=0.0, help="speaker-to-mic leak, 0 = headset")
    a = ap.parse_args()
    logger.remove()
    logger.add(sys.stderr, level="DEBUG")
    asyncio.run(main(a.out, a.echo))
