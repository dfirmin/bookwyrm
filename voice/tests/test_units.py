"""Fast checks for the parts with no audio in them: the echo guard and the "calls you" watcher.

    voice/.venv/bin/python tests/test_units.py
"""

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bookwyrm_voice.config import Settings  # noqa: E402
from bookwyrm_voice import watch  # noqa: E402
from bookwyrm_voice.echo import EchoGuard, SpokenLog  # noqa: E402

SAID = [
    "Just one thing is in quarantine, Dee. It's the social media posting guidelines draft.",
    "The engine couldn't place it because there's no Marketing team in the teams file yet.",
    "Let me look at the teams file to confirm.",
    "If you can answer my question, I'll draft the change.",
    "The high one is the phishing runbook, owned by security.",
    "Quick answer on quarantine first, since I didn't get to it. It's the social media guidelines.",
]

# (what the microphone transcribed, is it Bookwyrm's own voice?)
# The True cases are real echo fragments from simulated calls; the False ones are things a
# caller plausibly says right after hearing SAID.
ECHO_CASES = [
    ("And there's no marketing.", True),
    ("to the social media", True),
    ("no marketing team in the teams file", True),
    ("the social media posting guidelines", True),
    ("Right your question.", False),               # an echo, but too short to tell from speech
    ("Sorry, actually, just the high priority one.", False),
    ("Okay.", False),
    ("What about the phishing runbook?", False),
    ("What about the phishing runbook", False),
    ("Who owns the social media one?", False),
    ("Can you draft the change for marketing?", False),
    ("Yes, go ahead and draft the change.", False),
    ("Is the phishing runbook owned by security?", False),
    ("tell me about the social media draft", False),
    ("go ahead with the marketing team", False),
]


def test_echo_guard():
    log = SpokenLog()
    for s in SAID:
        log.add(s)
    guard = EchoGuard(log)
    wrong = [(t, e) for t, e in ECHO_CASES if guard.is_echo(t) != e]
    assert not wrong, f"echo guard got these wrong: {wrong}"


def _issue(n, title, labels=(), pr=False):
    d = {"number": n, "title": title, "labels": [{"name": label} for label in labels]}
    if pr:
        d["pull_request"] = {}
    return d


class _Resp:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


def test_watcher():
    tmp = Path(tempfile.mkdtemp())
    watch.STATE_DIR, watch.SEEN = tmp, tmp / "seen.json"
    gap8 = _issue(8, "[security] Phishing Credential Harvest Response — missing_escalation")
    q19 = _issue(19, "Quarantined: social-media-guidelines.md", ["quarantine"])
    batches = [
        [gap8, q19],                                                   # backlog: never announced
        [gap8, q19, _issue(30, "Quarantined: vendor-onboarding-notes.md", ["quarantine"]),
         _issue(31, "Weekly Oncall Handoff — missing_rollback"),
         _issue(32, "Bump engine version", pr=True), _issue(33, "Question about the README")],
        [_issue(30, "Quarantined: vendor-onboarding-notes.md", ["quarantine"]),   # announced last time
         _issue(31, "Weekly Oncall Handoff — missing_rollback")],                  # held over: one call per check
        [_issue(30, "Quarantined: vendor-onboarding-notes.md", ["quarantine"]),
         _issue(31, "Weekly Oncall Handoff — missing_rollback")],                  # both announced now
    ]
    expected = [[], [("quarantine", 30)], [("gap", 31)], []]

    async def run():
        w = watch.Watcher(lambda: Settings(repo="o/r", github_token="token", calls_you=True))
        for batch, want in zip(batches, expected):
            async def fake_get(*_a, _b=batch, **_k):
                return _Resp(_b)
            with patch("httpx.AsyncClient.get", side_effect=fake_get):
                got = [(r.kind, r.issue) for r in await w.check()]
            assert got == want, f"watcher: wanted {want}, got {got}"

    try:
        asyncio.run(run())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_history():
    from bookwyrm_voice.history import History
    tmp = Path(tempfile.mkdtemp())
    try:
        h = History(tmp / "h.db")
        h.add("voice-1", "call", "assistant", "Hey Dee! What's up?", via="voice")
        assert h.get("voice-1")["title"] == "Call"
        h.add("voice-1", "call", "user", "What's in quarantine right now?", via="voice")
        assert h.get("voice-1")["title"] == "What's in quarantine right now?"   # named by the first question
        h.add("text-1", "chat", "user", "x" * 100, via="text")
        assert h.get("text-1")["title"].endswith("…") and len(h.get("text-1")["title"]) <= 60
        h.add("voice-1", "call", "assistant", "Typed follow-up answer", via="text")   # carried on by text
        convs = h.conversations()
        assert [c["id"] for c in convs] == ["voice-1", "text-1"]                     # newest activity first
        assert convs[0]["count"] == 3 and convs[0]["voice"] == 2
        h.rename("text-1", "Long one")
        h.delete("voice-1")
        assert [c["title"] for c in h.conversations()] == ["Long one"] and h.messages("voice-1") == []
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    test_echo_guard()
    test_watcher()
    test_history()
    print("ok: echo guard (15 cases), watcher (4 checks), history")
