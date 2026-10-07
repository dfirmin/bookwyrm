"""Speaking engines behind one small interface, so the call pipeline doesn't care which one talks.

    kokoro                 Kokoro-82M through sherpa-onnx. Fast on any CPU, always installed. Flat.
    chatterbox-turbo-mlx   Chatterbox-Turbo (350M) on an Apple Silicon Mac's GPU, through mlx-audio.
    chatterbox-turbo       Chatterbox-Turbo through PyTorch on an NVIDIA GPU.
    chatterbox-nano        Chatterbox-Nano (110M) through PyTorch on the CPU.

Chatterbox is the natural one: trained on conversational speech, with sound tags like ``[chuckle]``
and ``[sigh]``. It speaks in its own default voice, or copies a voice from a short recording you
drop into ``~/.bookwyrm/voices`` (5 to 15 seconds of clear speech, .wav, .flac or .mp3).

The heavy libraries (mlx-audio, torch, chatterbox) are optional installs and only imported when the
engine that needs them is chosen. ``load_speaker`` never leaves Bookwyrm mute: if the chosen engine
can't load, or is too slow on this machine to keep up with a conversation, it falls back to Kokoro
and says why.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from loguru import logger

from . import hardware
from .models import CHATTERBOX_MLX, CHATTERBOX_NANO, CHATTERBOX_TURBO, S3TOKENIZER_MLX, TTS_MODEL, ensure_model, \
    engine_present, model_path

ENGINE_LABELS = {
    hardware.KOKORO: "Standard",
    hardware.TURBO_MLX: "Natural (Mac GPU)",
    hardware.TURBO_CUDA: "Natural (NVIDIA GPU)",
    hardware.NANO_CPU: "Natural (CPU)",
}

# Chatterbox's sound tags that suit a phone call. The model knows more ([angry], [whispering], ...)
# but on a work call those read as odd, so the prompt only offers these.
CALL_TAGS = ("[chuckle]", "[laugh]", "[sigh]", "[clear throat]")
# Every tag Chatterbox-Turbo's tokenizer has (its added_tokens.json). Only these are stripped for
# Kokoro, so ordinary bracketed words are left alone.
ALL_TAGS = ("advertisement", "angry", "chuckle", "clear throat", "cough", "crying", "dramatic", "fear", "gasp",
            "groan", "happy", "laugh", "narration", "sarcastic", "shush", "sigh", "sniff", "surprised", "whispering")
_TAG = re.compile(r"\s*\[(?:" + "|".join(re.escape(t) for t in ALL_TAGS) + r")\]", re.IGNORECASE)

DEFAULT_VOICE = "default"
CLIP_TYPES = (".wav", ".flac", ".mp3")

# A natural voice slower than this (seconds of work per second of speech) would leave gaps
# mid-answer, so Bookwyrm falls back to Kokoro rather than stutter.
MAX_REAL_TIME_FACTOR = 0.8
WARMUP = "Okay, so... there's one thing in quarantine, and two gaps are still open."


def strip_tags(text: str) -> str:
    """'calling you back [chuckle], have you' -> 'calling you back, have you'."""
    return re.sub(r"\s{2,}", " ", _TAG.sub("", text)).strip()


def has_tags(text: str) -> bool:
    return bool(_TAG.search(text))


@dataclass
class Audio:
    samples: np.ndarray  # float32, mono, -1..1
    sample_rate: int

    @property
    def seconds(self) -> float:
        return len(self.samples) / self.sample_rate if self.sample_rate else 0.0


class Speaker:
    engine: str = ""
    tags: bool = False           # understands [chuckle] and friends
    speed_control: bool = False  # honours the speaking-speed slider
    voice: str = ""

    @property
    def label(self) -> str:
        return ENGINE_LABELS.get(self.engine, self.engine)

    def voices(self) -> list[dict]:
        raise NotImplementedError

    def has_voice(self, voice: str) -> bool:
        return any(v["id"] == voice for v in self.voices())

    def set_voice(self, voice: str) -> None:
        raise NotImplementedError

    def speak(self, text: str, speed: float = 1.0, voice: str | None = None) -> Audio:
        raise NotImplementedError


# ---- Kokoro ------------------------------------------------------------------------------------------

class KokoroSpeaker(Speaker):
    engine = hardware.KOKORO
    speed_control = True

    def __init__(self, models_dir: Path, voice: str = "af_heart"):
        from .tts import Kokoro

        tts_dir = ensure_model(models_dir, TTS_MODEL)
        try:
            self.kokoro = Kokoro(tts_dir, voice)
        except ValueError:  # a voice name this model doesn't have (a Chatterbox one, say)
            self.kokoro = Kokoro(tts_dir, "af_heart")

    @property
    def voice(self) -> str:  # type: ignore[override]
        return self.kokoro.voice

    @property
    def ids(self) -> dict[str, int]:
        return self.kokoro.ids

    def voices(self) -> list[dict]:
        from .tts import english_voices

        return english_voices(self.kokoro.ids)

    def has_voice(self, voice: str) -> bool:
        return voice in self.kokoro.ids

    def set_voice(self, voice: str) -> None:
        self.kokoro.set_voice(voice)

    def speak(self, text: str, speed: float = 1.0, voice: str | None = None) -> Audio:
        audio = self.kokoro.generate(strip_tags(text), speed, voice)
        return Audio(np.asarray(audio.samples, dtype=np.float32), audio.sample_rate)


# ---- Chatterbox (shared by the MLX and PyTorch builds) -----------------------------------------------

def _offline() -> None:
    """Everything is already on disk (models.py fetched it): never let a library reach for
    Hugging Face mid-call, and keep its per-sentence progress bars out of the log."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("TQDM_DISABLE", "1")
    try:
        import huggingface_hub.constants as hf_constants

        hf_constants.HF_HUB_OFFLINE = True  # read at call time; the env var only at import
    except ImportError:
        pass


class _Chatterbox(Speaker):
    tags = True

    def __init__(self, voices_dir: Path, voice: str):
        self.voices_dir = voices_dir
        self._conds: dict[str, object] = {}
        self._lock = threading.Lock()
        self.voice = DEFAULT_VOICE
        try:
            self.set_voice(voice)
        except ValueError as e:
            logger.warning(f"{e}; using Chatterbox's default voice")

    # Subclasses: the model's conditionals (its idea of "who is speaking") and one generation.
    def _get_conds(self): raise NotImplementedError
    def _put_conds(self, conds) -> None: raise NotImplementedError
    def _conds_from_clip(self, clip: Path): raise NotImplementedError
    def _generate(self, text: str) -> np.ndarray: raise NotImplementedError
    sample_rate: int = 24000

    def _clips(self) -> dict[str, Path]:
        if not self.voices_dir.is_dir():
            return {}
        return {p.stem: p for p in sorted(self.voices_dir.iterdir()) if p.suffix.lower() in CLIP_TYPES}

    def voices(self) -> list[dict]:
        out = [{"id": DEFAULT_VOICE, "label": "Default", "detail": "Chatterbox's own voice"}]
        for name in self._clips():
            out.append({"id": name, "label": name.replace("_", " ").replace("-", " ").title(),
                        "detail": "copied from your recording"})
        return out

    def _conds_for(self, voice: str):
        if voice not in self._conds:
            clip = self._clips().get(voice)
            if clip is None:
                raise ValueError(f"No voice {voice!r}: put a recording called {voice}.wav in {self.voices_dir}")
            logger.info(f"Learning the voice in {clip.name} (one time per run)")
            self._conds[voice] = self._conds_from_clip(clip)
        return self._conds[voice]

    def set_voice(self, voice: str) -> None:
        if voice != DEFAULT_VOICE:
            with self._lock:
                self._conds_for(voice)
        self.voice = voice

    def speak(self, text: str, speed: float = 1.0, voice: str | None = None) -> Audio:  # noqa: ARG002 - no speed knob
        text = text.strip()
        with self._lock:
            conds = self._conds_for(voice or self.voice)
            self._put_conds(conds)
            samples = self._generate(text)
        return Audio(np.asarray(samples, dtype=np.float32).reshape(-1), self.sample_rate)


class ChatterboxMLXSpeaker(_Chatterbox):
    engine = hardware.TURBO_MLX

    def __init__(self, models_dir: Path, voices_dir: Path, voice: str = DEFAULT_VOICE):
        _offline()
        from mlx_audio.tts.utils import load_model

        self.models_dir = models_dir
        self.model = load_model(model_path(models_dir, CHATTERBOX_MLX))
        self.sample_rate = int(self.model.sample_rate)
        self._s3_loaded = False
        super().__init__(voices_dir, voice)
        self._conds[DEFAULT_VOICE] = self.model._conds

    def _get_conds(self):
        return self.model._conds

    def _put_conds(self, conds) -> None:
        self.model._conds = conds

    def _conds_from_clip(self, clip: Path):
        if not self._s3_loaded:  # the speech tokenizer is only needed to copy a voice: fetch it now
            import mlx.core as mx

            path = ensure_model(self.models_dir, S3TOKENIZER_MLX) / "model.safetensors"
            weights = mx.load(str(path))
            if hasattr(self.model._s3tokenizer, "sanitize"):
                weights = self.model._s3tokenizer.sanitize(weights)
            self.model._s3tokenizer.load_weights(list(weights.items()), strict=False)
            mx.eval(self.model._s3tokenizer.parameters())
            self._s3_loaded = True
        from mlx_audio.utils import load_audio

        # Level the clip ourselves, in float32: the model's own step can promote it to float64,
        # which MLX can't run on the GPU.
        wav = np.asarray(load_audio(str(clip), sample_rate=self.sample_rate), dtype=np.float32)
        wav = np.asarray(self.model.norm_loudness(wav, self.sample_rate), dtype=np.float32)
        before = self.model._conds
        self.model.prepare_conditionals(wav, sample_rate=self.sample_rate, norm_loudness=False)
        conds, self.model._conds = self.model._conds, before
        return conds

    def _generate(self, text: str) -> np.ndarray:
        parts = [np.asarray(r.audio, dtype=np.float32).reshape(-1) for r in self.model.generate(text=text)]
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


class ChatterboxTorchSpeaker(_Chatterbox):
    def __init__(self, models_dir: Path, voices_dir: Path, voice: str = DEFAULT_VOICE, *, nano: bool):
        _offline()
        import torch
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        self.engine = hardware.NANO_CPU if nano else hardware.TURBO_CUDA
        device = "cuda" if (not nano and torch.cuda.is_available()) else "cpu"
        if not nano and device == "cpu":
            logger.warning("No CUDA GPU visible to PyTorch; Chatterbox Turbo will run on the CPU (slowly)")
        self.device = device
        self._torch = torch
        name = CHATTERBOX_NANO if nano else CHATTERBOX_TURBO
        self.model = ChatterboxTurboTTS.from_local(model_path(models_dir, name), device, nano=nano)
        self.sample_rate = int(self.model.sr)
        super().__init__(voices_dir, voice)
        self._conds[DEFAULT_VOICE] = self.model.conds

    def _get_conds(self):
        return self.model.conds

    def _put_conds(self, conds) -> None:
        self.model.conds = conds

    def _conds_from_clip(self, clip: Path):
        # Chatterbox's own loudness step turns the clip into float64 under NumPy 2 (it was written
        # for NumPy 1), which its tokenizer then rejects; so level the clip here, in float32.
        import tempfile

        import librosa
        import soundfile

        wav, sr = librosa.load(str(clip), sr=self.model.sr)
        wav = np.asarray(self.model.norm_loudness(wav, sr), dtype=np.float32)
        before = self.model.conds
        with tempfile.TemporaryDirectory() as tmp:
            leveled = Path(tmp) / "voice.wav"
            soundfile.write(str(leveled), wav, sr, subtype="FLOAT")
            self.model.prepare_conditionals(str(leveled), norm_loudness=False)
        conds, self.model.conds = self.model.conds, before
        return conds

    def _generate(self, text: str) -> np.ndarray:
        with self._torch.inference_mode():
            wav = self.model.generate(text)
        return wav.squeeze(0).detach().cpu().numpy()


# ---- choosing and loading ----------------------------------------------------------------------------

@dataclass
class Loaded:
    speaker: Speaker
    wanted: str            # the engine settings asked for
    note: str = ""         # why we're not using it, when we aren't
    real_time_factor: float | None = None
    load_seconds: float = 0.0

    @property
    def engine(self) -> str:
        return self.speaker.engine

    @property
    def fell_back(self) -> bool:
        return self.engine != self.wanted


def _build(engine: str, models_dir: Path, voices_dir: Path, voice: str) -> Speaker:
    if not engine_present(models_dir, engine):
        raise RuntimeError(f"{engine}'s model isn't downloaded yet (run setup again, or "
                           f"python -m bookwyrm_voice.models --engine {engine})")
    if engine == hardware.TURBO_MLX:
        return ChatterboxMLXSpeaker(models_dir, voices_dir, voice)
    if engine in (hardware.TURBO_CUDA, hardware.NANO_CPU):
        return ChatterboxTorchSpeaker(models_dir, voices_dir, voice, nano=engine == hardware.NANO_CPU)
    raise RuntimeError(f"Unknown speaking engine {engine!r}")


def measure(speaker: Speaker, text: str = WARMUP) -> tuple[float, Audio]:
    """Seconds of work per second of speech (below 1 keeps up; lower is better)."""
    t0 = time.monotonic()
    audio = speaker.speak(text)
    took = time.monotonic() - t0
    return (took / audio.seconds if audio.seconds else float("inf")), audio


def load_speaker(engine: str, models_dir: Path, voices_dir: Path, *, kokoro_voice: str = "af_heart",
                 natural_voice: str = DEFAULT_VOICE, check_speed: bool = True) -> Loaded:
    """Load ``engine``; on any trouble, Kokoro instead, with a note saying why.

    Kokoro and Chatterbox have different voices, so each keeps its own setting.
    """
    t0 = time.monotonic()
    if engine == hardware.KOKORO:
        return Loaded(KokoroSpeaker(models_dir, kokoro_voice), engine, load_seconds=time.monotonic() - t0)
    try:
        speaker = _build(engine, models_dir, voices_dir, natural_voice)
        rtf = None
        if check_speed:
            measure(speaker, "Hello.")  # first run compiles kernels and fills caches; don't count it
            rtf, _ = measure(speaker)
            logger.info(f"{engine}: {rtf:.2f}s of work per second of speech")
            if rtf > MAX_REAL_TIME_FACTOR:
                del speaker
                raise RuntimeError(f"too slow on this machine ({rtf:.1f}s of work per second of speech), "
                                   "so answers would stutter")
        return Loaded(speaker, engine, real_time_factor=rtf, load_seconds=time.monotonic() - t0)
    except ImportError as e:
        note = (f"the natural voice's libraries aren't installed ({e.name or e}); run setup again "
                "to install them")
    except Exception as e:  # noqa: BLE001 - any failure: keep talking with Kokoro
        note = str(e) or type(e).__name__
    logger.warning(f"Using Kokoro instead of {engine}: {note}")
    return Loaded(KokoroSpeaker(models_dir, kokoro_voice), engine, note=note, load_seconds=time.monotonic() - t0)


def voices_dir_default() -> Path:
    from .config import data_dir

    return Path(os.environ.get("BOOKWYRM_VOICES_DIR") or data_dir() / "voices").expanduser()
