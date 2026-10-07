# 0007 — A natural voice, matched to the machine

Status: proposed, 2026-10-07.

## Context

ADR 0003 gave Bookwyrm answers written for the ear, good timing and interruption, and a local
voice: Kokoro-82M. Kokoro is small and runs on any CPU, but on calls it still sounds flat. It has
no idea of emotion or conversational rhythm; it reads punctuation and that's all. The prompt side
(`on-a-call.md`) was already doing what text can do.

The voices that sound like a person (ElevenLabs and the like) are hosted. Bookwyrm keeps speech on
the machine (ADR 0003), so a hosted voice was not considered. Open models have closed much of the
gap. Chatterbox (Resemble AI, MIT) is the best fit we found for a phone-call agent:

- **Turbo** (350M): built for low-latency voice agents; evaluated by Resemble against ElevenLabs
  Turbo v2.5; understands sound tags such as `[chuckle]` and `[sigh]`; copies a voice from a
  5–15 second recording.
- **Nano** (110M): the same design, for CPUs, about 3x faster than real time on 8 cores.

Bookwyrm runs on Macs and Windows PCs of every size, and people worry about disk, memory and
fans. One engine can't suit all of them.

## Decision

1. **Speaking engines behind one interface** (`voice/bookwyrm_voice/speakers.py`): `speak(text,
   speed, voice) -> audio`, `voices()`, `set_voice()`. The Pipecat service (`SpeakerTTSService`)
   speaks with whichever is chosen.

   | engine | runs on | through | model download |
   |---|---|---|---|
   | `chatterbox-turbo-mlx` | Apple Silicon Mac, macOS 14+ | MLX (mlx-audio), Mac GPU | 0.7 GB (8-bit) |
   | `chatterbox-turbo` | Windows/Linux with an NVIDIA GPU (4 GB+) | PyTorch + CUDA | 3.0 GB |
   | `chatterbox-nano` | Windows/Linux, 8+ CPU threads | PyTorch, CPU | 1.9 GB |
   | `kokoro` | anything | sherpa-onnx, CPU | 0.35 GB (always installed) |

   All need 8 GB of memory or more. Intel Macs get Kokoro: PyTorch no longer builds for them.

2. **Setup picks, per machine.** `python -m bookwyrm_voice.hardware` looks at the machine (OS,
   chip, CPU threads, memory, NVIDIA GPU) and recommends one. The installer's new
   **natural-voice** step installs only that engine's libraries (a `pyproject` extra, `mlx` or
   `torch`; PyTorch via uv's `--torch-backend`, so CPU-only PCs get the small CPU build) and
   downloads only its model. `--voice-engine kokoro` skips it; `--voice-engine <engine>` forces
   one. Settings → Voice quality switches between what's installed.

3. **Never mute, never stutter.** Kokoro is always installed. Bookwyrm falls back to it, and says
   why in Settings, when the chosen engine isn't installed or downloaded, fails to load, is
   measured at start as too slow for this machine (over 0.8 s of work per second of speech), or
   fails mid-call (that sentence and the rest of the call switch over).

4. **Pinned and local.** Chatterbox models come from Hugging Face at fixed commits, downloaded by
   `models.py` (with the same progress protocol as the GitHub-hosted models) into
   `~/.bookwyrm/models`; at run time Bookwyrm sets Hugging Face to offline. The PyTorch build
   installs `chatterbox-tts` from a fixed commit without its own requirements (they pin gradio
   and NumPy 1); `pyproject` lists what it actually imports.

5. **Sounds, sparingly.** When the voice understands tags, the call prompt offers four that suit
   a work call (`[chuckle]`, `[laugh]`, `[sigh]`, `[clear throat]`), at most one per answer. Tags
   are stripped before Kokoro speaks and before the echo guard compares words.

6. **Your own voice.** A recording in `~/.bookwyrm/voices/` (5–15 s, .wav/.flac/.mp3) appears as
   a voice choice for Chatterbox. Kokoro and Chatterbox keep separate voice settings (`voice`,
   `natural_voice`). Chatterbox has no speed control, so the slider is off for it.

## Consequences

- The natural voice costs 1–3 GB more disk and a few GB of memory during a call; the installer
  shows the size while it downloads, `--voice-engine kokoro` avoids it, and Standard stays one
  click away in Settings.
- Hugging Face is blocked on some company networks. The natural-voice step then fails with a
  plain hint and Bookwyrm keeps Kokoro; nothing else in setup depends on it.
- Chatterbox's PyTorch output carries Resemble's inaudible Perth watermark. We keep it.
- Chatterbox was written against NumPy 1; under NumPy 2 its loudness step returns float64, which
  breaks voice copying. Bookwyrm levels recordings itself, in float32, before handing them over.
- `tests/bench_voices.py` compares engines on a machine (load time, time to first audio, real-time
  factor, memory) and writes a WAV per engine to listen to.
