"""Settings for the voice service.

Where they come from, highest priority first:

1. ``BOOKWYRM_*`` environment variables (tests, unusual setups);
2. ``~/.bookwyrm/settings.json``: written by the setup wizard and the app's Settings page;
3. ``voice/.env`` from older installs (``BOOKWYRM_CALLER="Name, Team"``, ``BOOKWYRM_REPO``);
4. defaults that work on one machine running Hermes' gateway locally.

Secrets are never kept here: the Hermes API key and the GitHub token are read from the Bookwyrm
Hermes profile's own ``.env``.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
VOICE_DIR = PACKAGE_DIR.parent

# Settings the app may change (PUT /api/settings). Repo and keys go through the setup wizard,
# because they also change the Hermes profile.
EDITABLE = ("name", "team", "voice", "voice_speed", "calls_you", "watch_minutes")


def data_dir() -> Path:
    return Path(os.environ.get("BOOKWYRM_HOME") or Path.home() / ".bookwyrm").expanduser()


def settings_file() -> Path:
    return data_dir() / "settings.json"


def hermes_home() -> Path:
    """Hermes' own default: %LOCALAPPDATA%\\hermes on Windows, ~/.hermes elsewhere."""
    if os.environ.get("HERMES_HOME"):
        return Path(os.environ["HERMES_HOME"]).expanduser()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "hermes"
    return Path.home() / ".hermes"


def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if path.is_file():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def read_settings_file() -> dict:
    try:
        data = json.loads(settings_file().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(updates: dict) -> dict:
    """Merge ``updates`` into settings.json, keeping keys we don't know (the wizard's, say)."""
    data = {**read_settings_file(), **updates}
    path = settings_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return data


@dataclass(frozen=True)
class Settings:
    name: str = ""
    team: str = ""
    repo: str = ""
    profile: str = "bookwyrm"

    # Hermes: the brain. The profile served by the host gateway (multiplexed profiles).
    hermes_url: str = "http://127.0.0.1:8642/p/bookwyrm/v1"
    hermes_key: str = ""
    profile_env: Path = Path()

    models_dir: Path = Path.home() / ".bookwyrm" / "models"
    voice: str = "af_heart"
    voice_speed: float = 1.0

    # Local server the companion app talks to.
    host: str = "127.0.0.1"
    port: int = 7865

    prompt_path: Path = VOICE_DIR / "prompts" / "on-a-call.md"

    # Opt-in "Bookwyrm calls you" (switched on from the app). Read-only access is enough.
    calls_you: bool = False
    github_token: str = ""
    watch_minutes: float = 5.0
    greeting_override: str = ""

    @property
    def caller(self) -> str:
        return ", ".join(p for p in (self.name, self.team) if p)

    @property
    def first_name(self) -> str:
        return self.name.split()[0] if self.name else ""

    @property
    def greeting(self) -> str:
        if self.greeting_override:
            return self.greeting_override
        return f"Hey {self.first_name}! What's up?" if self.first_name else "Hey! What's up?"

    # Kept for the watcher and older code.
    @property
    def watch_repo(self) -> str:
        return self.repo

    @property
    def watch_token(self) -> str:
        return self.github_token

    @property
    def instructions(self) -> str:
        text = self.prompt_path.read_text(encoding="utf-8")
        if self.caller:
            text += (
                f"\n\nYou're talking with {self.caller}. The Bookwyrm desktop app on their own machine "
                "placed this call, so you know who they are; don't ask. Use their first name now and then."
            )
        return text

    def public(self) -> dict:
        """What the app's Settings page shows. No secrets, only whether they're set."""
        saved_model = read_settings_file().get("model") or {}
        model = {"provider": "gateway", "base_url": saved_model.get("base_url", ""), "name": saved_model.get("name", "")} \
            if saved_model.get("provider") == "gateway" else {"provider": "anthropic"}
        secrets = read_env_file(self.profile_env)
        return {
            "model": model,
            "name": self.name, "team": self.team, "repo": self.repo, "profile": self.profile,
            "voice": self.voice, "voice_speed": self.voice_speed,
            "calls_you": self.calls_you, "watch_minutes": self.watch_minutes,
            "keys": {"github": bool(self.github_token), "hermes_api": bool(self.hermes_key),
                     "anthropic": bool(secrets.get("ANTHROPIC_API_KEY")),
                     "gateway": bool(secrets.get("LITELLM_API_KEY"))},
            "paths": {"settings": str(settings_file()), "profile_env": str(self.profile_env),
                      "models": str(self.models_dir), "data": str(data_dir())},
        }


def _split_caller(caller: str) -> tuple[str, str]:
    name, _, team = caller.partition(",")
    return name.strip(), team.strip()


def load_settings(env_file: str | os.PathLike | None = None) -> Settings:
    env = os.environ
    legacy = read_env_file(Path(env_file) if env_file else VOICE_DIR / ".env")
    saved = read_settings_file()

    def pick(env_key: str, saved_key: str, default):
        """Environment, then settings.json, then the legacy voice/.env, then the default."""
        if env.get(env_key, "").strip():
            return env[env_key].strip()
        if saved_key and saved.get(saved_key) not in (None, ""):
            return saved[saved_key]
        if legacy.get(env_key, "").strip():
            return legacy[env_key].strip()
        return default

    legacy_name, legacy_team = _split_caller(env.get("BOOKWYRM_CALLER") or legacy.get("BOOKWYRM_CALLER", ""))
    profile = str(pick("BOOKWYRM_PROFILE", "profile", "bookwyrm"))
    profile_env = Path(str(pick("BOOKWYRM_PROFILE_ENV", "", str(hermes_home() / "profiles" / profile / ".env")))).expanduser()
    secrets = read_env_file(profile_env)
    calls_you = saved.get("calls_you")
    if calls_you is None:  # older installs kept this in prefs.json
        try:
            calls_you = json.loads((data_dir() / "prefs.json").read_text()).get("calls_you", False)
        except (OSError, ValueError):
            calls_you = False

    return Settings(
        name=str(saved.get("name") or legacy_name),
        team=str(saved.get("team") or legacy_team),
        repo=str(pick("BOOKWYRM_REPO", "repo", "")),
        profile=profile,
        hermes_url=str(pick("BOOKWYRM_HERMES_URL", "hermes_url", f"http://127.0.0.1:8642/p/{profile}/v1")).rstrip("/"),
        hermes_key=env.get("BOOKWYRM_HERMES_KEY") or secrets.get("API_SERVER_KEY", ""),
        profile_env=profile_env,
        models_dir=Path(str(pick("BOOKWYRM_MODELS_DIR", "models_dir", str(data_dir() / "models")))).expanduser(),
        voice=str(pick("BOOKWYRM_VOICE", "voice", Settings.voice)),
        voice_speed=float(pick("BOOKWYRM_VOICE_SPEED", "voice_speed", Settings.voice_speed)),
        host=str(pick("BOOKWYRM_HOST", "", Settings.host)),
        port=int(pick("BOOKWYRM_PORT", "", Settings.port)),
        calls_you=bool(calls_you),
        github_token=env.get("BOOKWYRM_GITHUB_TOKEN") or secrets.get("GITHUB_PERSONAL_ACCESS_TOKEN", ""),
        watch_minutes=float(pick("BOOKWYRM_WATCH_MINUTES", "watch_minutes", 5.0)),
        greeting_override=env.get("BOOKWYRM_GREETING", "").strip() or legacy.get("BOOKWYRM_GREETING", ""),
    )
