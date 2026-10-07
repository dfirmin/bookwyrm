"""Fast checks for the parts with no audio in them: the echo guard, the "calls you" watcher,
history, and choosing a speaking engine (no PyTorch or MLX needed: those engines are faked).

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


def test_sound_tags():
    from bookwyrm_voice.speakers import has_tags, strip_tags
    assert strip_tags("calling you back [chuckle], have you got a minute?") == "calling you back, have you got a minute?"
    assert strip_tags("[sigh] Two gaps are still open.") == "Two gaps are still open."
    assert strip_tags("Hmm [clear throat] okay.") == "Hmm okay."
    assert strip_tags("See [the runbook] for it.") == "See [the runbook] for it."   # only Chatterbox's tags
    assert has_tags("ha [laugh]") and not has_tags("no tags here")


def test_engine_choice():
    from bookwyrm_voice import hardware as hw
    M = hw.Machine
    cases = [
        (M("Darwin", "arm64", 8, 16, 0, (14, 5)), hw.TURBO_MLX),       # an M2 on Sonoma
        (M("Darwin", "arm64", 8, 8, 0, (15, 1)), hw.TURBO_MLX),        # base M1 Air
        (M("Darwin", "arm64", 8, 16, 0, (13, 6)), hw.NANO_CPU),        # too old for MLX: PyTorch CPU
        (M("Darwin", "x86_64", 12, 32, 0, (14, 0)), hw.KOKORO),        # Intel Mac: no PyTorch builds
        (M("Windows", "x86_64", 16, 32, 8, None), hw.TURBO_CUDA),      # gaming laptop
        (M("Windows", "x86_64", 16, 32, 2, None), hw.NANO_CPU),        # small GPU: CPU instead
        (M("Windows", "x86_64", 12, 16, 0, None), hw.NANO_CPU),        # office desktop
        (M("Windows", "x86_64", 4, 8, 0, None), hw.KOKORO),            # thin laptop
        (M("Windows", "arm64", 8, 16, 0, None), hw.NANO_CPU),          # Snapdragon
        (M("Linux", "x86_64", 32, 6, 24, None), hw.KOKORO),            # big GPU, not enough memory
        (M("Linux", "x86_64", 8, 0, 0, None), hw.NANO_CPU),            # memory unknown: don't block
        (M("Linux", "x86_64", 8, 7.7, 0, None), hw.NANO_CPU),          # an "8 GB" PC, as it reports itself
        (M("Windows", "x86_64", 16, 6.8, 12, None), hw.KOKORO),        # 8 GB minus a lot of shared graphics
    ]
    wrong = [(m.describe(), want, hw.recommend(m)) for m, want in cases if hw.recommend(m) != want]
    assert not wrong, f"engine choice: {wrong}"
    assert all(hw.KOKORO in hw.supported(m) for m, _ in cases)        # Kokoro always works


def test_hardware_detect():
    from bookwyrm_voice import hardware as hw
    m = hw.detect()
    assert m.cores >= 1 and m.system and m.arch
    assert m.ram_gb > 0, f"couldn't read this machine's memory ({m.system})"
    assert hw.recommend(m) in hw.ENGINES


class _FakeChatterbox:
    """Stands in for Chatterbox: who's speaking is a tag; 'speech' is 0.1 s per word."""
    sr = 24000

    def __init__(self):
        self.conds = "default"

    def norm_loudness(self, wav, sr):
        return wav


def test_chatterbox_voices():
    from bookwyrm_voice import speakers

    class Fake(speakers._Chatterbox):
        engine = "chatterbox-nano"

        def __init__(self, voices_dir):
            self.model = _FakeChatterbox()
            self.learned = []
            super().__init__(voices_dir, "default")
            self._conds["default"] = "default"

        def _put_conds(self, conds):
            self.model.conds = conds

        def _conds_from_clip(self, clip):
            self.learned.append(clip.stem)
            return f"voice:{clip.stem}"

        def _generate(self, text):
            self.heard = (self.model.conds, text)
            return [0.0] * int(0.1 * self.sample_rate * len(text.split()))

    tmp = Path(tempfile.mkdtemp())
    try:
        (tmp / "dee_on_a_call.wav").write_bytes(b"")
        (tmp / "notes.txt").write_text("not audio")
        sp = Fake(tmp)
        assert [v["id"] for v in sp.voices()] == ["default", "dee_on_a_call"]
        assert sp.voices()[1]["label"] == "Dee On A Call"
        a = sp.speak("Two gaps are open [sigh].")
        assert sp.heard == ("default", "Two gaps are open [sigh].") and abs(a.seconds - 0.5) < 1e-6
        sp.set_voice("dee_on_a_call")
        assert sp.learned == ["dee_on_a_call"] and sp.voice == "dee_on_a_call"
        sp.speak("Hello there.")
        assert sp.heard[0] == "voice:dee_on_a_call"
        sp.speak("Preview.", voice="default")                              # a preview in another voice
        assert sp.heard[0] == "default" and sp.voice == "dee_on_a_call"
        sp.set_voice("dee_on_a_call")
        assert sp.learned == ["dee_on_a_call"]                             # learned once, then cached
        try:
            sp.set_voice("nobody")
            raise AssertionError("an unknown voice should be refused")
        except ValueError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_engine_downloads():
    from bookwyrm_voice import models
    tmp = Path(tempfile.mkdtemp())
    try:
        assert not models.engine_present(tmp, "chatterbox-turbo-mlx")
        assert not models.engine_present(tmp, "no-such-engine")
        gb = {e: models.download_size(tmp, e) / 1e9 for e in models.ENGINE_MODELS}
        assert gb["kokoro"] == 0 and 0.6 < gb["chatterbox-turbo-mlx"] < 1.0, gb
        assert 1.8 < gb["chatterbox-nano"] < 2.1 and 2.8 < gb["chatterbox-turbo"] < 3.1, gb
        for m in models.HF_MODELS.values():
            assert len(m.revision) == 40, f"{m.repo} must be pinned to a commit"
        d = tmp / models.CHATTERBOX_MLX
        d.mkdir()
        (d / ".bookwyrm-complete").write_text("x")
        assert models.engine_present(tmp, "chatterbox-turbo-mlx")
        assert models.download_size(tmp, "chatterbox-turbo-mlx") == 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    test_echo_guard()
    test_watcher()
    test_history()
    test_sound_tags()
    test_engine_choice()
    test_hardware_detect()
    test_chatterbox_voices()
    test_engine_downloads()
    print("ok: echo guard (15 cases), watcher (4 checks), history, sound tags, engine choice (13 machines), "
          "hardware detection, Chatterbox voices, engine downloads")
