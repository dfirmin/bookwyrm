"""Speech models: where they live and how they get there.

Both come from the sherpa-onnx GitHub releases rather than Hugging Face, which corporate networks
often block. Each is downloaded once into ``models_dir`` and reused.
"""

from __future__ import annotations

import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from loguru import logger

_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

STT_MODEL = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"  # ~640 MB unpacked, English
TTS_MODEL = "kokoro-multi-lang-v1_0"                      # ~350 MB, 50+ voices

_URLS = {
    STT_MODEL: f"{_RELEASES}/asr-models/{STT_MODEL}.tar.bz2",
    TTS_MODEL: f"{_RELEASES}/tts-models/{TTS_MODEL}.tar.bz2",
}

# A file that must exist once a model is unpacked.
_MARKER = {STT_MODEL: "tokens.txt", TTS_MODEL: "voices.bin"}


def model_path(models_dir: Path, name: str) -> Path:
    return models_dir / name


def ensure_model(models_dir: Path, name: str) -> Path:
    """Return the model's directory, downloading and unpacking it first if needed."""
    target = model_path(models_dir, name)
    if (target / _MARKER[name]).exists():
        return target
    models_dir.mkdir(parents=True, exist_ok=True)
    url = _URLS[name]
    logger.info(f"Downloading {name} (one time) from {url}")
    with tempfile.TemporaryDirectory(dir=models_dir) as tmp:
        archive = Path(tmp) / f"{name}.tar.bz2"
        with urllib.request.urlopen(url) as resp, open(archive, "wb") as out:  # noqa: S310 - fixed URL
            shutil.copyfileobj(resp, out, length=1 << 20)
        with tarfile.open(archive, "r:bz2") as tf:
            tf.extractall(tmp, filter="data")
        shutil.move(str(Path(tmp) / name), target)
    if not (target / _MARKER[name]).exists():
        raise RuntimeError(f"{name}: unpacked, but {_MARKER[name]} is missing in {target}")
    return target


def ensure_all(models_dir: Path) -> None:
    for name in (STT_MODEL, TTS_MODEL):
        ensure_model(models_dir, name)
