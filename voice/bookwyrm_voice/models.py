"""Speech models: where they live and how they get there.

Both come from the sherpa-onnx GitHub releases rather than Hugging Face, which corporate networks
often block. Each is downloaded once into ``models_dir`` and reused.

The installer runs this module directly to download with a progress bar:

    python -m bookwyrm_voice.models --progress [--dir DIR]

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

# progress(event, model, done, total); event is "download", "unpack" or "done".
Progress = Callable[[str, str, int, int], None]


def default_models_dir() -> Path:
    return Path(os.environ.get("BOOKWYRM_MODELS_DIR") or Path.home() / ".bookwyrm" / "models").expanduser()


def model_path(models_dir: Path, name: str) -> Path:
    return models_dir / name


def is_present(models_dir: Path, name: str) -> bool:
    return (model_path(models_dir, name) / _MARKER[name]).exists()


def ensure_model(models_dir: Path, name: str, progress: Progress | None = None) -> Path:
    """Return the model's directory, downloading and unpacking it first if needed."""
    target = model_path(models_dir, name)
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


def ensure_all(models_dir: Path, progress: Progress | None = None) -> None:
    for name in ALL_MODELS:
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
    args = parser.parse_args(argv)
    models_dir = (args.dir or default_models_dir()).expanduser()
    if args.check:
        missing = [m for m in ALL_MODELS if not is_present(models_dir, m)]
        for m in missing:
            print(f"MISSING {m}")
        return 1 if missing else 0
    if args.progress:
        logger.remove()  # keep stdout to the protocol; errors still reach stderr below
    try:
        ensure_all(models_dir, _print_progress if args.progress else None)
    except Exception as exc:  # noqa: BLE001 - report any failure plainly to the installer
        print(f"ERROR {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
