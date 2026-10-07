"""Speech models: where they live and how they get there.

The listening model and Kokoro come from the sherpa-onnx GitHub releases rather than Hugging Face,
which corporate networks often block. They're always installed. The natural voice (Chatterbox) is
only published on Hugging Face, so it's an optional extra: if Hugging Face is blocked, Bookwyrm
keeps speaking with Kokoro. Every model is downloaded once into ``models_dir`` and reused, from a
pinned revision, so an upstream change never alters a working install.

The installer runs this module directly to download with a progress bar:

    python -m bookwyrm_voice.models --progress [--dir DIR] [--engine ENGINE]

which prints one machine-readable line per event on stdout:

    PROGRESS <model> <bytes_done> <bytes_total>     (bytes_total is 0 if the server didn't say)
    UNPACK <model>
    DONE <model>
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from loguru import logger

_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

STT_MODEL = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"  # ~640 MB unpacked, English
TTS_MODEL = "kokoro-multi-lang-v1_0"                      # ~350 MB, 50+ voices
ALL_MODELS = (STT_MODEL, TTS_MODEL)

_URLS = {
    STT_MODEL: f"{_RELEASES}/asr-models/{STT_MODEL}.tar.bz2",
    TTS_MODEL: f"{_RELEASES}/tts-models/{TTS_MODEL}.tar.bz2",
}

# A file that must exist once a model is unpacked.
_MARKER = {STT_MODEL: "tokens.txt", TTS_MODEL: "voices.bin"}


# ---- natural voice: Chatterbox, from Hugging Face ----------------------------------------------------

_HF = "https://huggingface.co"
_HF_DONE = ".bookwyrm-complete"  # written once every file is in place

# Tokenizer files every Chatterbox build reads.
_TOKENIZER = (("added_tokens.json", 418), ("merges.txt", 456318), ("special_tokens_map.json", 470),
              ("tokenizer_config.json", 3878), ("vocab.json", 999186))


@dataclass(frozen=True)
class HfModel:
    repo: str
    revision: str                       # a commit, never a branch
    files: tuple[tuple[str, int], ...]  # (path, size in bytes); only what Bookwyrm loads

    @property
    def size(self) -> int:
        return sum(n for _, n in self.files)


CHATTERBOX_MLX = "chatterbox-turbo-8bit-mlx"
S3TOKENIZER_MLX = "s3tokenizer-v2-mlx"
CHATTERBOX_TURBO = "chatterbox-turbo"
CHATTERBOX_NANO = "chatterbox-nano"

HF_MODELS: dict[str, HfModel] = {
    # Turbo converted for Apple's MLX, 8-bit: about 0.7 GB.
    CHATTERBOX_MLX: HfModel("mlx-community/chatterbox-turbo-8bit", "2f2e21a03863f86a1274d1060dcc188e7cde77e1", (
        ("config.json", 2565), ("model.safetensors", 706233417), ("model.safetensors.index.json", 252012),
        ("conds.safetensors", 164884), *_TOKENIZER)),
    # Only needed to copy a voice from your own recording on a Mac (0.5 GB), so fetched on first use.
    S3TOKENIZER_MLX: HfModel("mlx-community/S3TokenizerV2", "e0c9886f0e1c35ae85b1f27277416fb19fc72bec", (
        ("config.json", 126), ("model.safetensors", 494868984))),
    # PyTorch builds (Windows and Linux). The repos also hold an unused 1 GB decoder; it's skipped.
    CHATTERBOX_TURBO: HfModel("ResembleAI/chatterbox-turbo", "749d1c1a46eb10492095d68fbcf55691ccf137cd", (
        ("t3_turbo_v1.safetensors", 1915480052), ("s3gen_meanflow.safetensors", 1064875036),
        ("ve.safetensors", 5695784), ("conds.pt", 169454), *_TOKENIZER)),
    CHATTERBOX_NANO: HfModel("ResembleAI/chatterbox-nano", "71ccd1d0081b430592cea481f4307e764e07bc64", (
        ("t3_nano_v1.safetensors", 869899204), ("s3gen_meanflow.safetensors", 1064875036),
        ("ve.safetensors", 5695784), ("conds.pt", 169454), *_TOKENIZER)),
}

# What each speaking engine needs on disk, beyond the listening model.
ENGINE_MODELS: dict[str, tuple[str, ...]] = {
    "kokoro": (TTS_MODEL,),
    "chatterbox-turbo-mlx": (CHATTERBOX_MLX,),
    "chatterbox-turbo": (CHATTERBOX_TURBO,),
    "chatterbox-nano": (CHATTERBOX_NANO,),
}

# progress(event, model, done, total); event is "download", "unpack" or "done".
Progress = Callable[[str, str, int, int], None]


def default_models_dir() -> Path:
    return Path(os.environ.get("BOOKWYRM_MODELS_DIR") or Path.home() / ".bookwyrm" / "models").expanduser()


def model_path(models_dir: Path, name: str) -> Path:
    return models_dir / name


def is_present(models_dir: Path, name: str) -> bool:
    if name in HF_MODELS:
        return (model_path(models_dir, name) / _HF_DONE).exists()
    return (model_path(models_dir, name) / _MARKER[name]).exists()


def engine_present(models_dir: Path, engine: str) -> bool:
    return engine in ENGINE_MODELS and all(is_present(models_dir, m) for m in ENGINE_MODELS[engine])


def download_size(models_dir: Path, engine: str) -> int:
    """Bytes still to download for ``engine`` (0 once it's all here)."""
    return sum(HF_MODELS[m].size for m in ENGINE_MODELS.get(engine, ())
               if m in HF_MODELS and not is_present(models_dir, m))


def _ensure_hf(models_dir: Path, name: str, progress: Progress | None) -> Path:
    model = HF_MODELS[name]
    target = model_path(models_dir, name)
    target.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": "bookwyrm-voice"}
    if os.environ.get("HF_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['HF_TOKEN']}"
    total = model.size
    done = sum(size for f, size in model.files if (target / f).is_file() and (target / f).stat().st_size == size)
    logger.info(f"Downloading {name} (one time) from {_HF}/{model.repo}")
    last = 0.0
    for fname, size in model.files:
        dest = target / fname
        if dest.is_file() and dest.stat().st_size == size:
            continue  # finished on an earlier run
        part = dest.with_name(dest.name + ".part")
        url = f"{_HF}/{model.repo}/resolve/{model.revision}/{fname}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as resp, open(part, "wb") as out:  # noqa: S310 - fixed host
            while chunk := resp.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                now = time.monotonic()
                if progress and now - last >= 0.25:
                    progress("download", name, done, total)
                    last = now
        if part.stat().st_size != size:
            got = part.stat().st_size
            part.unlink()
            raise RuntimeError(f"{name}/{fname}: expected {size} bytes, got {got}")
        part.replace(dest)
    if progress:
        progress("download", name, total, total)
    (target / _HF_DONE).write_text(model.revision + "\n", encoding="utf-8")
    if progress:
        progress("done", name, 0, 0)
    return target


def ensure_model(models_dir: Path, name: str, progress: Progress | None = None) -> Path:
    """Return the model's directory, downloading and unpacking it first if needed."""
    target = model_path(models_dir, name)
    if name in HF_MODELS:
        if is_present(models_dir, name):
            if progress:
                progress("done", name, 0, 0)
            return target
        return _ensure_hf(models_dir, name, progress)
    if is_present(models_dir, name):
        if progress:
            progress("done", name, 0, 0)
        return target
    models_dir.mkdir(parents=True, exist_ok=True)
    url = _URLS[name]
    logger.info(f"Downloading {name} (one time) from {url}")
    with tempfile.TemporaryDirectory(dir=models_dir) as tmp:
        archive = Path(tmp) / f"{name}.tar.bz2"
        with urllib.request.urlopen(url) as resp, open(archive, "wb") as out:  # noqa: S310 - fixed URL
            total = int(resp.headers.get("Content-Length") or 0)
            done, last = 0, 0.0
            while chunk := resp.read(1 << 20):
                out.write(chunk)
                done += len(chunk)
                now = time.monotonic()
                if progress and (now - last >= 0.25 or done == total):
                    progress("download", name, done, total)
                    last = now
        if progress:
            progress("download", name, done, total or done)
            progress("unpack", name, 0, 0)
        with tarfile.open(archive, "r:bz2") as tf:
            tf.extractall(tmp, filter="data")
        if target.exists():  # a half-unpacked earlier attempt
            shutil.rmtree(target)
        shutil.move(str(Path(tmp) / name), target)
    if not is_present(models_dir, name):
        raise RuntimeError(f"{name}: unpacked, but {_MARKER[name]} is missing in {target}")
    if progress:
        progress("done", name, 0, 0)
    return target


def ensure_all(models_dir: Path, progress: Progress | None = None, engine: str | None = None) -> None:
    """The base models, plus whatever ``engine`` needs (Kokoro is always kept as the fallback)."""
    names = list(ALL_MODELS)
    for m in ENGINE_MODELS.get(engine or "kokoro", ()):
        if m not in names:
            names.append(m)
    for name in names:
        ensure_model(models_dir, name, progress)


def _print_progress(event: str, name: str, done: int, total: int) -> None:
    if event == "download":
        print(f"PROGRESS {name} {done} {total}", flush=True)
    elif event == "unpack":
        print(f"UNPACK {name}", flush=True)
    else:
        print(f"DONE {name}", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m bookwyrm_voice.models",
                                     description="Download Bookwyrm's speech models (once).")
    parser.add_argument("--dir", type=Path, default=None, help="models directory (default ~/.bookwyrm/models)")
    parser.add_argument("--progress", action="store_true", help="print machine-readable progress lines")
    parser.add_argument("--check", action="store_true", help="only report whether the models are present")
    parser.add_argument("--engine", choices=sorted(ENGINE_MODELS), default=None,
                        help="also fetch this speaking engine's model (default: Kokoro only)")
    args = parser.parse_args(argv)
    models_dir = (args.dir or default_models_dir()).expanduser()
    wanted = list(ALL_MODELS) + [m for m in ENGINE_MODELS.get(args.engine or "kokoro", ()) if m not in ALL_MODELS]
    if args.check:
        missing = [m for m in wanted if not is_present(models_dir, m)]
        for m in missing:
            print(f"MISSING {m}")
        return 1 if missing else 0
    if args.progress:
        logger.remove()  # keep stdout to the protocol; errors still reach stderr below
    try:
        ensure_all(models_dir, _print_progress if args.progress else None, args.engine)
    except Exception as exc:  # noqa: BLE001 - report any failure plainly to the installer
        print(f"ERROR {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
