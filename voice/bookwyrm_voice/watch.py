"""Opt-in "Bookwyrm calls you": watch the knowledge repo for new things that need the owner.

Off by default. When on, polls the repo's open issues every few minutes. Archivist files one issue
per quarantined draft ("Quarantined: <file>") and one per gap, so a *new* such issue is the
signal. Issues already open when watching starts are never announced, so turning the feature on
doesn't trigger a burst of calls about the backlog.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path

import httpx
from loguru import logger

STATE_DIR = Path.home() / ".bookwyrm"
PREFS = STATE_DIR / "prefs.json"
SEEN = STATE_DIR / "seen-issues.json"


def load_prefs() -> dict:
    try:
        return json.loads(PREFS.read_text())
    except Exception:
        return {"calls_you": False}


def save_prefs(prefs: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PREFS.write_text(json.dumps(prefs, indent=2))


@dataclass
class Reason:
    """Why Bookwyrm is calling: shown on the incoming-call screen and told to Hermes."""
    kind: str        # "quarantine" | "gap"
    issue: int
    title: str

    @property
    def headline(self) -> str:
        if self.kind == "quarantine":
            return f"New in quarantine: {self.title.split(':', 1)[-1].strip()}"
        return f"New gap: {self.title}"

    @property
    def greeting(self) -> str:
        if self.kind == "quarantine":
            return "Hey, sorry to bug you. Something new just landed in quarantine. Got a minute?"
        return "Hey, sorry to bug you. A new gap just came up in the knowledge base. Got a minute?"

    @property
    def instructions(self) -> str:
        return (
            "\n\nYou placed this call; they didn't. You called because of GitHub issue "
            f"#{self.issue}, \"{self.title}\" ({'a newly quarantined draft' if self.kind == 'quarantine' else 'a new gap'}). "
            "You've already said hello and asked if they have a minute. When they say yes, look at that issue "
            "and explain it in a sentence or two, then ask how they'd like to handle it. If they're busy, "
            "say you'll leave it and say goodbye."
        )


_GAP_TITLE = re.compile(r" — [a-z][a-z0-9_]+$")  # "<concept title> — <kind>" (Archivist default)


def classify(issue: dict) -> Reason | None:
    if "pull_request" in issue:
        return None
    title = issue.get("title", "")
    labels = {lbl.get("name", "") for lbl in issue.get("labels", [])}
    if title.startswith("Quarantined:") or "quarantine" in labels:
        return Reason("quarantine", issue["number"], title)
    if _GAP_TITLE.search(title):
        return Reason("gap", issue["number"], title)
    return None


class Watcher:
    def __init__(self, repo: str, token: str, every_minutes: float = 5.0):
        self.repo, self.token, self.every = repo, token, every_minutes * 60
        self.subscribers: set[asyncio.Queue] = set()
        self._task: asyncio.Task | None = None

    @property
    def configured(self) -> bool:
        return bool(self.repo and self.token)

    def start(self):
        if self.configured and not self._task:
            self._task = asyncio.create_task(self._loop())

    async def stop(self):
        if self._task:
            self._task.cancel()

    async def _loop(self):
        while True:
            try:
                if load_prefs().get("calls_you"):
                    for reason in await self.check():
                        logger.info(f"Calling the owner: {reason.headline} (#{reason.issue})")
                        for q in list(self.subscribers):
                            q.put_nowait(reason)
                else:
                    SEEN.unlink(missing_ok=True)  # when switched on later, start fresh
            except Exception as e:
                logger.warning(f"Repo watch failed: {e}")
            await asyncio.sleep(self.every)

    async def check(self) -> list[Reason]:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(
                f"https://api.github.com/repos/{self.repo}/issues",
                params={"state": "open", "per_page": 100},
                headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json"},
            )
            r.raise_for_status()
            issues = r.json()
        first_look = not SEEN.exists()
        seen = set() if first_look else set(json.loads(SEEN.read_text()))
        now = {i["number"] for i in issues}
        new = [] if first_look else [r for i in issues if i["number"] not in seen and (r := classify(i))]
        # One call per check: the rest stay unseen and ring on the next check, not all at once.
        held = {r.issue for r in new[1:]}
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        SEEN.write_text(json.dumps(sorted((seen | now) - held)))
        return new[:1]
