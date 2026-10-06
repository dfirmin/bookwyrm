# 0003 — A voice companion of our own, with Hermes as the brain

Status: proposed, 2026-10-05.

## Context

Hermes ships a desktop app with voice and a pop-out mascot. Tried on the owner's Mac (macOS 14,
Apple Silicon) it fell short of what Bookwyrm is for:

- the voice (Piper) sounded robotic;
- talking over a reply didn't stop it: the desktop app's interrupt detector compares raw mic
  level to a fixed bar, and macOS's echo cancellation pushes your voice under that bar while the
  app is speaking through the laptop's speakers;
- replies were written for the eye (lists, headings, file paths) and read out as such;
- it was Hermes' app, not Bookwyrm: no ringing call, no card of its own.

What people find human in voice agents is four things, and only one is the voice: a natural
voice; answers written for the ear; timing (answer within a breath, know a pause from being done,
stop the moment you're cut off, speak while still thinking); and, in the very best demos,
speech-to-speech models, which are hosted and bring their own brain.

## Decision

1. **Hermes stays the brain, untouched.** Each call is one Hermes run per turn on the Bookwyrm
   profile, through the gateway's runs API (`/p/bookwyrm/v1/runs`, gateway with
   `multiplex_profiles`): `session_id` per call so Hermes keeps the conversation and tool calls
   in its own session history and memory; `instructions` carries the on-a-call speaking style
   (`voice/prompts/on-a-call.md`); `POST /runs/{id}/stop` when the caller interrupts, so Hermes
   abandons the turn rather than finishing it (and its tool calls) in the background. Skills,
   rules, GitHub tools and the PR-only fence are exactly as in ADR 0001.

2. **The voice is our own pipeline, on Pipecat (BSD-2).** `voice/` is a small Python service:
   Silero voice activity starts a turn and interrupts Bookwyrm; smart-turn v3 decides when the
   caller has finished; Parakeet TDT 0.6B v2 hears; Kokoro-82M (`af_heart`) speaks, sentence by
   sentence as Hermes streams. All local; only text goes to the model provider. Models come from
   the sherpa-onnx GitHub releases, not Hugging Face, which corporate networks often block.
   Pipecat's own VAD and turn models are bundled in the package.

3. **Timing rules, in code.** When Hermes starts a tool, whatever it has said ("Let me check
   the repo.") is spoken at once; Pipecat's sentence splitter would otherwise hold it until the
   next sentence, i.e. until the tool and the next model call finish. If the line has been quiet
   4 s mid-answer, Bookwyrm says "Still looking." (at most twice). The greeting plays the moment
   the call connects, with no model round-trip.

4. **Echo: the platform's cancellation first, a transcript guard second.** The app opens the
   mic with WebRTC echo cancellation, noise suppression and auto-gain. Behind it, `EchoGuard`
   drops "caller" transcripts whose consecutive word pairs are ≥60% Bookwyrm's own last 12 s of
   speech, never a question. 15 labelled cases in `voice/tests/test_units.py`.

5. **The face is our own app.** `app/` is a small Electron app: an original book-dragon that
   lives on the right edge, always on top, click-through except where it's drawn. Click it and it
   rings, then a checkout-card call screen opens with live captions (shown faintly until actually
   spoken, dropped if interrupted), mute, type and hang up. Typing outside a call is a text
   conversation with the same profile. The call client is ~120 lines of plain WebRTC: Pipecat's
   JS transport loaded a script from Daily's CDN at call time, which an enterprise app shouldn't.

6. **Bookwyrm calls you: opt-in, off by default.** When switched on (right-click the dragon),
   the voice service polls the knowledge repo's open issues; a *new* `Quarantined:` issue or gap
   issue rings the app, and the call opens with why. The backlog at switch-on is never announced.
   It reuses the profile's read access; no new secret.

7. **Secrets aren't copied.** The voice service reads Bookwyrm's API key and GitHub token from
   the Bookwyrm profile's `.env`.

## Evidence

Measured on a 2-core cloud box (slower than any Apple Silicon Mac), with live Hermes and GitHub:

| | |
|---|---|
| Caller finishes → Hermes run starts | ~0.6 s (turn detection) |
| Hermes first words (warm) | 1.5–2.5 s; one Anthropic call spiked to 29 s, covered by "Still looking" |
| Caller starts talking over Bookwyrm → it stops | 0.3–0.5 s, and the Hermes run is cancelled |
| Kokoro, this box | ~0.7× real time with 4 threads; much faster on M-series |
| Parakeet, this box | 18 s of speech in 1.9 s |

Proven end to end: scripted calls through the real pipeline (`voice/tests/call_sim.py`); a
WebRTC call from Python; and the real app renderer in Chromium placing a real call with a fake
microphone (`app/tests/e2e.js`).

## Not proven / known limits

- **Laptop speakers.** In simulation without echo cancellation, Bookwyrm can hear and interrupt
  itself. Chromium's echo cancellation should prevent it; it can't be heard from a cloud box.
  Headphones avoid it entirely. If it persists, the next step is a "confirmed interruption"
  strategy (interrupt on words, not on sound, while Bookwyrm is speaking).
- **Talking over the greeting** can clip your first words: echo cancellation ducks speech over
  far-end audio, as phone calls do.
- **Turn splitting:** "Hey." followed by a pause is a complete turn; if you carry on, the
  half-started answer is cancelled. Correct, but it costs a moment.
- **Kokoro's prosody** is good, not human. The TTS is one class; Orpheus, CSM or Chatterbox can
  be tried behind the same interface once someone listens on a Mac.
- **Two new issues at once** are two calls, one per check (default every 5 minutes), never both at once.
