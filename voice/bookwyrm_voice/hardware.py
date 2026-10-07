"""What this machine can run, and which speaking engine to give it.

Bookwyrm ships one fast, robotic-ish voice that runs anywhere (Kokoro) and a more natural one
(Chatterbox) in three builds, each matched to a kind of machine:

    chatterbox-turbo-mlx   Apple Silicon Macs (M1 and later, macOS 14+), on the Mac's GPU via MLX
    chatterbox-turbo       Windows or Linux with an NVIDIA GPU, via PyTorch + CUDA
    chatterbox-nano        Windows or Linux without one, on the CPU via PyTorch (needs a fast CPU)
    kokoro                 everything else, and always installed as the fallback

The installer runs this module to decide what to download:

    python -m bookwyrm_voice.hardware            human-readable summary
    python -m bookwyrm_voice.hardware --json     {"machine": {...}, "recommended": "...", "supported": [...]}

Nothing here needs PyTorch or MLX installed: it only looks at the machine.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass

KOKORO = "kokoro"
TURBO_MLX = "chatterbox-turbo-mlx"
TURBO_CUDA = "chatterbox-turbo"
NANO_CPU = "chatterbox-nano"

# Best first. "Natural" engines are everything except Kokoro.
ENGINES = (TURBO_MLX, TURBO_CUDA, NANO_CPU, KOKORO)
NATURAL = frozenset(ENGINES) - {KOKORO}

# How setup installs each one: the pyproject extra, packages installed without their own
# requirements, and uv's --torch-backend ("auto" finds the NVIDIA driver's CUDA version).
CHATTERBOX_SOURCE = ("chatterbox-tts @ https://github.com/resemble-ai/chatterbox/archive/"
                     "5de7a54aa4e5e2baadb0182dde554908b48b85c2.zip")  # main, July 2026: Nano support
INSTALL: dict[str, dict | None] = {
    KOKORO: None,
    TURBO_MLX: {"extra": "mlx", "no_deps": [], "torch_backend": None, "libraries_gb": 0.3},
    TURBO_CUDA: {"extra": "torch", "no_deps": [CHATTERBOX_SOURCE], "torch_backend": "auto", "libraries_gb": 3.0},
    NANO_CPU: {"extra": "torch", "no_deps": [CHATTERBOX_SOURCE], "torch_backend": "cpu", "libraries_gb": 0.6},
}

# Thresholds. Chatterbox needs a few GB of memory during a call on top of the listening model and
# the app; Nano is about 3x faster than real time on 8 CPU cores, so fewer cores risks choppy speech.
MIN_RAM_GB = 8.0
_RAM_SLACK_GB = 0.75  # an "8 GB" PC reports about 7.7 GB once firmware and graphics take their share
NANO_MIN_CORES = 8
CUDA_MIN_VRAM_GB = 4.0
MLX_MIN_MACOS = (14, 0)


@dataclass(frozen=True)
class Machine:
    system: str          # "Darwin", "Windows", "Linux"
    arch: str            # "arm64", "x86_64", ...
    cores: int           # logical CPUs
    ram_gb: float        # 0 when unknown
    nvidia_vram_gb: float  # largest NVIDIA GPU's memory; 0 when there is none
    macos: tuple[int, int] | None = None

    @property
    def apple_silicon(self) -> bool:
        return self.system == "Darwin" and self.arch == "arm64"

    def describe(self) -> str:
        bits = [{"Darwin": "Mac", "Windows": "Windows PC", "Linux": "Linux PC"}.get(self.system, self.system)]
        if self.apple_silicon:
            bits[0] = "Apple Silicon Mac"
        elif self.system == "Darwin":
            bits[0] = "Intel Mac"
        bits.append(f"{self.cores} CPU threads")
        if self.ram_gb:
            bits.append(f"{self.ram_gb:.0f} GB memory")
        if self.nvidia_vram_gb:
            bits.append(f"NVIDIA GPU with {self.nvidia_vram_gb:.0f} GB")
        return ", ".join(bits)


def _arch() -> str:
    m = platform.machine().lower()
    if m in ("arm64", "aarch64"):
        return "arm64"
    if m in ("x86_64", "amd64"):
        return "x86_64"
    return m


def _ram_gb() -> float:
    try:
        if sys.platform == "darwin":
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout
            return int(out.strip()) / 2**30
        if sys.platform == "win32":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            status = MemoryStatus()
            status.dwLength = ctypes.sizeof(MemoryStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))  # type: ignore[attr-defined]
            return status.ullTotalPhys / 2**30
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) / 2**20
    except Exception:  # noqa: BLE001 - unknown is fine; the caller treats 0 as "don't know"
        pass
    return 0.0


def _nvidia_vram_gb() -> float:
    smi = shutil.which("nvidia-smi")
    if not smi:
        return 0.0
    try:
        out = subprocess.run([smi, "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        sizes = [float(x) for x in out.split() if x.replace(".", "", 1).isdigit()]
        return max(sizes) / 1024 if sizes else 0.0
    except Exception:  # noqa: BLE001
        return 0.0


def _macos() -> tuple[int, int] | None:
    if sys.platform != "darwin":
        return None
    parts = (platform.mac_ver()[0] or "0.0").split(".")
    try:
        return int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
    except ValueError:
        return None


def detect() -> Machine:
    return Machine(system=platform.system(), arch=_arch(), cores=os.cpu_count() or 1,
                   ram_gb=round(_ram_gb(), 1), nvidia_vram_gb=round(_nvidia_vram_gb(), 1), macos=_macos())


def why_not(engine: str, m: Machine) -> str | None:
    """None if this machine can run ``engine``; otherwise a plain-language reason it can't."""
    if engine == KOKORO:
        return None
    if engine == TURBO_MLX:
        if not m.apple_silicon:
            return "needs an Apple Silicon Mac (M1 or later)"
        if m.macos and m.macos < MLX_MIN_MACOS:
            return "needs macOS 14 (Sonoma) or later"
    elif engine == TURBO_CUDA:
        if m.system == "Darwin":
            return "needs an NVIDIA GPU (on a Mac, use the Mac GPU version)"
        if m.nvidia_vram_gb < CUDA_MIN_VRAM_GB:
            return f"needs an NVIDIA GPU with at least {CUDA_MIN_VRAM_GB:.0f} GB of memory"
    elif engine == NANO_CPU:
        if m.system == "Darwin" and not m.apple_silicon:
            return "PyTorch no longer supports Intel Macs"
        if m.arch not in ("x86_64", "arm64"):
            return f"PyTorch has no build for {m.arch}"
        if m.cores < NANO_MIN_CORES:
            return f"needs {NANO_MIN_CORES} or more CPU threads to keep up with speech (this machine has {m.cores})"
    else:
        return f"unknown engine {engine!r}"
    if m.ram_gb and m.ram_gb < MIN_RAM_GB - _RAM_SLACK_GB:
        return f"needs at least {MIN_RAM_GB:.0f} GB of memory (this machine has {m.ram_gb:.0f} GB)"
    return None


def supported(m: Machine) -> list[str]:
    return [e for e in ENGINES if why_not(e, m) is None]


def recommend(m: Machine) -> str:
    """The best engine this machine can run; Kokoro when nothing better fits."""
    return supported(m)[0]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m bookwyrm_voice.hardware",
                                     description="Which of Bookwyrm's voices this machine can run.")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)
    m = detect()
    rec = recommend(m)
    if args.json:
        from .models import ENGINE_MODELS, HF_MODELS

        sizes = {e: round(sum(HF_MODELS[n].size for n in ENGINE_MODELS[e] if n in HF_MODELS) / 1e9
                          + (INSTALL[e] or {}).get("libraries_gb", 0), 1) for e in ENGINES}
        print(json.dumps({"machine": {**asdict(m), "apple_silicon": m.apple_silicon, "summary": m.describe()},
                          "recommended": rec, "supported": supported(m),
                          "unsupported": {e: why_not(e, m) for e in ENGINES if why_not(e, m)},
                          "install": INSTALL, "download_gb": sizes}))
        return 0
    print(m.describe())
    for e in ENGINES:
        reason = why_not(e, m)
        mark = "*" if e == rec else ("ok" if reason is None else "--")
        print(f"  {mark:>2} {e:<22} {reason or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
