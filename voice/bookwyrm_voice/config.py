"""Settings for the voice service, read from environment variables (and an optional .env file).

Everything has a default that works on one Mac running Hermes' gateway locally.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
VOICE_DIR = PACKAGE_DIR.parent


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader; existing environment variables win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.is_file():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip() or default


@dataclass(frozen=True)
class Settings:
    # Hermes: the brain. The bookwyrm profile served by the host gateway (multiplexed profiles).
    hermes_url: str = "http://127.0.0.1:8642/p/bookwyrm/v1"
    hermes_key: str = ""
    # Who is on the other end of the call. The desktop app runs on the owner's machine, so the
    # caller is the owner; this saves "who am I talking to?" at the start of every call.
    caller: str = ""
    greeting: str = ""

    # Speech in: Parakeet (NVIDIA, CC-BY-4.0) via sherpa-onnx. Speech out: Kokoro (Apache-2.0).
    models_dir: Path = field(default_factory=lambda: Path.home() / ".bookwyrm" / "models")
    voice: str = "af_heart"
    voice_speed: float = 1.0

    # Local server the companion app talks to.
    host: str = "127.0.0.1"
    port: int = 7865

    prompt_path: Path = VOICE_DIR / "prompts" / "on-a-call.md"

    # Opt-in "Bookwyrm calls you" (switched on from the app). Read-only access is enough.
    watch_repo: str = ""
    watch_token: str = ""
    watch_minutes: float = 5.0

    @property
    def instructions(self) -> str:
        text = self.prompt_path.read_text(encoding="utf-8")
        if self.caller:
            text += (
                f"\n\nYou're talking with {self.caller}. The Bookwyrm desktop app on their own machine "
                "placed this call, so you know who they are; don't ask. Use their first name now and then."
            )
        return text


def load_settings(env_file: str | os.PathLike | None = None) -> Settings:
    _load_dotenv(Path(env_file) if env_file else VOICE_DIR / ".env")
    # Secrets stay where Hermes keeps them: read the Bookwyrm profile's own .env rather than
    # copying its API key or GitHub token into a second file.
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()
    profile_env = _read_env_file(Path(_env("BOOKWYRM_PROFILE_ENV", str(hermes_home / "profiles" / "bookwyrm" / ".env"))))
    caller = _env("BOOKWYRM_CALLER", "")
    first = caller.split()[0] if caller else ""
    return Settings(
        hermes_url=_env("BOOKWYRM_HERMES_URL", Settings.hermes_url).rstrip("/"),
        hermes_key=os.environ.get("BOOKWYRM_HERMES_KEY") or profile_env.get("API_SERVER_KEY", ""),
        caller=caller,
        greeting=_env("BOOKWYRM_GREETING", f"Hey {first}! What's up?" if first else "Hey! What's up?"),
        models_dir=Path(_env("BOOKWYRM_MODELS_DIR", str(Path.home() / ".bookwyrm" / "models"))).expanduser(),
        voice=_env("BOOKWYRM_VOICE", Settings.voice),
        voice_speed=float(_env("BOOKWYRM_VOICE_SPEED", str(Settings.voice_speed))),
        host=_env("BOOKWYRM_HOST", Settings.host),
        port=int(_env("BOOKWYRM_PORT", str(Settings.port))),
        watch_repo=_env("BOOKWYRM_REPO", ""),
        watch_token=os.environ.get("BOOKWYRM_GITHUB_TOKEN") or profile_env.get("GITHUB_PERSONAL_ACCESS_TOKEN", ""),
        watch_minutes=float(_env("BOOKWYRM_WATCH_MINUTES", "5")),
    )
