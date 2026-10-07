"""The local server the Bookwyrm app talks to (127.0.0.1 only).

Calls
    POST   /api/offer            start a call (WebRTC offer in, answer out). request_data may carry
                                 {"reason": {...}} when Bookwyrm placed the call, and
                                 {"session_id": "..."} to carry on an earlier conversation by voice
    PATCH  /api/offer            trickle ICE candidates
    POST   /api/warmup           while the phone rings: wake Hermes so the first answer isn't cold
    GET    /api/events           server-sent events: incoming calls from Bookwyrm (when enabled)
Typed chat and history
    POST   /api/chat             {"text", "session_id"?, "surface": "card"|"window"} -> streamed text
    GET    /api/history          conversations, newest first
    GET    /api/history/{id}     one conversation's messages
    PATCH  /api/history/{id}     {"title"}
    DELETE /api/history/{id}
The repo
    GET    /api/library          open quarantine and gap issues, open Bookwyrm pull requests
Settings
    GET    /api/settings         the settings the app shows (no secrets)
    PUT    /api/settings         change name, team, voice, voice_speed, calls_you, watch_minutes
    POST   /api/settings/reload  re-read settings.json and the profile .env (after setup ran)
    GET    /api/voices           the speaking engines this machine can use, and the current one's voices
    POST   /api/voices/preview   {"voice", "speed"} -> a short WAV sample in the current engine
    GET    /api/prefs, POST /api/prefs   (older app builds: {"calls_you"})
    GET    /health               is Hermes reachable, are the speech models loaded

Run:  python -m bookwyrm_voice.server
"""

from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import time
import uuid
import wave
from contextlib import asynccontextmanager

import httpx
import numpy as np
import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from loguru import logger
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from . import hardware
from .config import EDITABLE, Settings, load_settings, save_settings
from .history import History, context_text
from .models import download_size, engine_present
from .pipeline import Engines, build_call, greet
from .speakers import ENGINE_LABELS, KokoroSpeaker
from .watch import Reason, Watcher, classify

_settings: Settings = load_settings()
state: dict = {"engines": None, "watcher": None, "loading": True, "error": None, "history": None,
               "switching": False}
webrtc = SmallWebRTCRequestHandler()


def cfg() -> Settings:
    return _settings


def _reload() -> Settings:
    """Re-read settings. A change of speaking engine reloads it in the background (that takes a
    while); /health says "loading" meanwhile, and calls keep using the old voice until it's ready."""
    global _settings
    old = _settings
    _settings = load_settings()
    engines: Engines | None = state["engines"]
    if engines is not None:
        if _settings.voice_engine != old.voice_engine or _settings.natural_voice != old.natural_voice:
            asyncio.get_running_loop().create_task(_apply(engines, _settings))
        else:
            try:
                engines.apply(_settings)
            except ValueError as e:
                logger.warning(str(e))
    return _settings


async def _apply(engines: Engines, settings: Settings):
    state["switching"] = True
    try:
        await asyncio.to_thread(engines.apply, settings)
        logger.info(f"Speaking with {engines.status()}")
    except Exception as e:  # noqa: BLE001
        logger.exception(f"Couldn't switch voice: {e}")
    finally:
        state["switching"] = False


_LIBS = {hardware.TURBO_MLX: "mlx_audio", hardware.TURBO_CUDA: "chatterbox", hardware.NANO_CPU: "chatterbox"}


def engine_choices(settings: Settings) -> list[dict]:
    """Every engine, and whether this machine has what it needs (hardware, libraries, model)."""
    machine = hardware.detect()
    out = []
    for e in hardware.ENGINES:
        reason = hardware.why_not(e, machine)
        lib = _LIBS.get(e)
        if reason is None and lib and importlib.util.find_spec(lib) is None:
            reason = "not installed (run setup again to add it)"
        if reason is None and not engine_present(settings.models_dir, e):
            reason = f"not downloaded ({download_size(settings.models_dir, e) / 1e9:.1f} GB; run setup again)"
        out.append({"id": e, "label": ENGINE_LABELS[e], "ready": reason is None, "reason": reason or ""})
    return out


def history() -> History:
    if state["history"] is None:
        state["history"] = History()
    return state["history"]


async def _load_engines():
    logger.info("Loading speech models (first run downloads ~1 GB from GitHub)…")
    try:
        state["engines"] = engines = await asyncio.to_thread(Engines, cfg())
        logger.info(f"Ready. Hermes at {cfg().hermes_url}; speaking with {engines.status()}")
    except Exception as e:
        state["error"] = f"{type(e).__name__}: {e}"
        logger.exception("Could not load the speech models")
    finally:
        state["loading"] = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Answer /health straight away; the models load in the background and /health says so.
    loader = asyncio.create_task(_load_engines())
    w = Watcher(cfg)
    w.start()
    state["watcher"] = w
    yield
    loader.cancel()
    await w.stop()
    await webrtc.close()


app = FastAPI(lifespan=lifespan)
# The app's pages are local files; only this machine can reach 127.0.0.1 anyway.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["x-session-id"])


def _auth() -> dict:
    return {"Authorization": f"Bearer {cfg().hermes_key}"}


# ---- calls ----------------------------------------------------------------------------------------

async def _run_call(connection, reason: Reason | None, session_id: str | None):
    settings = cfg()
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    earlier = history().get(session_id) if session_id else None
    extra = reason.instructions if reason else ""
    if earlier:
        extra += ("\n\nThis call carries on a conversation you were already having in the Bookwyrm app; "
                  "you remember it. Don't start over.")
    call = build_call(transport, settings, state["engines"], greet=False, session_id=session_id,
                      instructions_extra=extra)

    @transport.event_handler("on_client_connected")
    async def _connected(transport, client):  # noqa: ARG001
        hello = reason.greeting if reason else ("I'm here. Go ahead." if earlier else settings.greeting)
        await greet(call, hello)

    @transport.event_handler("on_client_disconnected")
    async def _hung_up(transport, client):  # noqa: ARG001
        await call.task.cancel()

    try:
        await WorkerRunner(handle_sigint=False).run(call.task)
    finally:
        _record_call(call, reason, kind=earlier["kind"] if earlier else "call")
        logger.info(f"Call ended (Hermes session {call.llm.session_id})")


def _record_call(call, reason: Reason | None, kind: str):
    """What was said, as Pipecat kept it: interrupted answers are cut where the caller cut in."""
    try:
        # Pipecat keeps each spoken stretch as its own message; join a speaker's run into one turn.
        turns: list[list] = []
        for m in call.context.get_messages():
            role = m.get("role") if isinstance(m, dict) else None
            text = context_text(m).strip() if role in ("user", "assistant") else ""
            if not text:
                continue
            if turns and turns[-1][0] == role:
                turns[-1][1] += " " + text
            else:
                turns.append([role, text])
        h = history()
        for role, text in turns:
            h.add(call.llm.session_id, kind, role, text, via="voice", reason=reason.headline if reason else None)
    except Exception:
        logger.exception("Couldn't save the call to history")


@app.post("/api/offer")
async def offer(request: Request, background: BackgroundTasks):
    if state["engines"] is None:
        raise HTTPException(503, state["error"] or "Bookwyrm is still loading its voice.")
    body = await request.json()
    req = SmallWebRTCRequest.from_dict(body)
    data = req.request_data if isinstance(req.request_data, dict) else {}
    reason = Reason(**data["reason"]) if data.get("reason") else None
    session_id = data.get("session_id") or None

    async def on_connection(connection):
        background.add_task(_run_call, connection, reason, session_id)

    return await webrtc.handle_web_request(request=req, webrtc_connection_callback=on_connection)


@app.patch("/api/offer")
async def ice(request: Request):
    await webrtc.handle_patch_request(SmallWebRTCPatchRequest(**await request.json()))
    return {"ok": True}


@app.post("/api/warmup")
async def warmup():
    # A tiny Hermes request wakes the gateway and the provider connection while the phone rings.
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            await c.get(f"{cfg().hermes_url}/models", headers=_auth())
    except Exception:
        pass
    return {"ok": True}


# ---- typed chat and history -----------------------------------------------------------------------

_CHAT_STYLE = {
    "card": ("You're chatting by text in the Bookwyrm companion's small card. Keep replies short; "
             "plain sentences, no headings or tables."),
    "window": ("You're chatting by text in the Bookwyrm app window. Markdown is fine (short lists, "
               "links to files and pull requests, code spans for paths); keep answers focused."),
}


@app.post("/api/chat")
async def chat(request: Request):
    """Typed conversation with Bookwyrm: same Hermes profile, written replies, saved to history."""
    body = await request.json()
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Nothing to send.")
    session_id = body.get("session_id") or f"text-{uuid.uuid4().hex[:12]}"
    settings = cfg()
    instructions = _CHAT_STYLE.get(body.get("surface"), _CHAT_STYLE["card"])
    if settings.caller:
        instructions += f" You're talking with {settings.caller}; the app on their own machine is signed in as them."
    h = history()
    kind = (h.get(session_id) or {}).get("kind", "chat")
    h.add(session_id, kind, "user", text, via="text")

    async def stream():
        reply: list[str] = []
        async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=5)) as c:
            try:
                r = await c.post(f"{settings.hermes_url}/runs", headers=_auth(),
                                 json={"input": text, "session_id": session_id, "instructions": instructions})
                r.raise_for_status()
                run_id = r.json()["run_id"]
                async with c.stream("GET", f"{settings.hermes_url}/runs/{run_id}/events", headers=_auth()) as s:
                    async for line in s.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        ev = json.loads(line[5:])
                        kind_ = ev.get("event")
                        if kind_ == "message.delta" and ev.get("delta"):
                            reply.append(ev["delta"])
                            yield ev["delta"]
                        elif kind_ == "tool.started":
                            # A marker the window shows as "Checking the repo…"; the card ignores it.
                            yield "⁣"
                        elif kind_ in ("run.completed", "run.failed", "run.cancelled", "run.interrupted"):
                            if kind_ == "run.failed" and not reply:
                                msg = "Something went wrong on my end. Try again?"
                                reply.append(msg)
                                yield msg
                            break
            except httpx.ConnectError:
                msg = "I can't reach my notes right now. Is Hermes running on this machine?"
                reply.append(msg)
                yield msg
            except httpx.HTTPStatusError as e:
                msg = f"Hermes said no ({e.response.status_code}). Check Bookwyrm's setup."
                reply.append(msg)
                yield msg
            finally:
                h.add(session_id, kind, "assistant", "".join(reply), via="text")

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8", headers={"x-session-id": session_id})


@app.get("/api/history")
async def list_history():
    return history().conversations()


@app.get("/api/history/{conv}")
async def get_history(conv: str):
    c = history().get(conv)
    if not c:
        raise HTTPException(404, "No such conversation.")
    return {**c, "messages": history().messages(conv)}


@app.patch("/api/history/{conv}")
async def rename_history(conv: str, request: Request):
    title = ((await request.json()).get("title") or "").strip()
    if title:
        history().rename(conv, title)
    return {"ok": True}


@app.delete("/api/history/{conv}")
async def delete_history(conv: str):
    history().delete(conv)
    return {"ok": True}


# ---- the repo -------------------------------------------------------------------------------------

@app.get("/api/library")
async def library():
    """What needs the owner: quarantined drafts, gaps, and Bookwyrm's open pull requests."""
    s = cfg()
    if not (s.repo and s.github_token):
        return {"repo": s.repo, "error": "Bookwyrm needs a knowledge repo and a GitHub token. Run setup again."}
    headers = {"Authorization": f"Bearer {s.github_token}", "Accept": "application/vnd.github+json"}
    base = f"https://api.github.com/repos/{s.repo}"
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            issues_r, pulls_r = await asyncio.gather(
                c.get(f"{base}/issues", params={"state": "open", "per_page": 100}, headers=headers),
                c.get(f"{base}/pulls", params={"state": "open", "per_page": 50}, headers=headers),
            )
        issues_r.raise_for_status()
        pulls_r.raise_for_status()
    except httpx.HTTPStatusError as e:
        return {"repo": s.repo, "error": f"GitHub answered {e.response.status_code}. Is the token still valid for {s.repo}?"}
    except httpx.HTTPError as e:
        return {"repo": s.repo, "error": f"Couldn't reach GitHub: {type(e).__name__}"}

    def item(i: dict) -> dict:
        return {"number": i["number"], "title": i["title"], "url": i["html_url"],
                "created": i.get("created_at"), "labels": [lbl["name"] for lbl in i.get("labels", [])]}

    quarantine, gaps, other = [], [], []
    for i in issues_r.json():
        r = classify(i)
        if "pull_request" in i:
            continue
        (quarantine if r and r.kind == "quarantine" else gaps if r else other).append(item(i))
    def by(branch: str) -> str:
        return next((who for who in ("bookwyrm", "archivist") if branch.startswith(who + "/")), "people")

    prs = [{**item(p), "branch": p["head"]["ref"], "by": by(p["head"]["ref"]), "draft": p.get("draft", False)}
           for p in pulls_r.json()]
    return {"repo": s.repo, "url": f"https://github.com/{s.repo}", "quarantine": quarantine, "gaps": gaps,
            "other_issues": other, "pulls": prs, "checked": time.time()}


# ---- settings -------------------------------------------------------------------------------------

@app.get("/api/settings")
async def get_settings():
    return cfg().public()


@app.put("/api/settings")
async def put_settings(request: Request):
    body = await request.json()
    updates = {k: body[k] for k in EDITABLE if k in body}
    if "voice_speed" in updates:
        updates["voice_speed"] = min(1.4, max(0.7, float(updates["voice_speed"])))
    if "watch_minutes" in updates:
        updates["watch_minutes"] = min(120.0, max(1.0, float(updates["watch_minutes"])))
    for k in ("name", "team"):
        if k in updates:
            updates[k] = str(updates[k]).strip()[:80]
    engines: Engines | None = state["engines"]
    if "voice_engine" in updates:
        choice = next((c for c in engine_choices(cfg()) if c["id"] == updates["voice_engine"]), None)
        if choice is None:
            raise HTTPException(400, f"Unknown speaking engine {updates['voice_engine']!r}")
        if not choice["ready"]:
            raise HTTPException(400, f"{choice['label']} isn't available: {choice['reason']}")
    if engines is not None:
        speaker = engines.speaker
        kokoro = isinstance(speaker, KokoroSpeaker)
        if "voice" in updates and kokoro and not speaker.has_voice(updates["voice"]):
            raise HTTPException(400, f"Unknown voice {updates['voice']!r}")
        if "natural_voice" in updates and not kokoro and not speaker.has_voice(updates["natural_voice"]):
            raise HTTPException(400, f"Unknown voice {updates['natural_voice']!r}")
    save_settings(updates)
    return _reload().public()


@app.post("/api/settings/reload")
async def reload_settings():
    return _reload().public()


@app.get("/api/voices")
async def voices():
    """The engines (for the "Voice quality" choice) and the speaking engine's voices. ``setting``
    names the settings key a voice choice is saved under (Kokoro and Chatterbox keep their own)."""
    s = cfg()
    engines: Engines | None = state["engines"]
    choices = await asyncio.to_thread(engine_choices, s)
    if engines is None or state["switching"]:
        return {"voices": [], "current": s.voice, "setting": "voice", "loading": True,
                "engines": choices, "engine": {"engine": s.voice_engine, "wanted": s.voice_engine}}
    speaker = engines.speaker
    kokoro = isinstance(speaker, KokoroSpeaker)
    return {"voices": speaker.voices(), "current": speaker.voice, "setting": "voice" if kokoro else "natural_voice",
            "engines": choices, "engine": engines.status(), "voices_dir": str(s.voices_dir)}


@app.post("/api/voices/preview")
async def preview(request: Request):
    engines: Engines | None = state["engines"]
    if engines is None:
        raise HTTPException(503, "Still loading the voices.")
    body = await request.json()
    speaker = engines.speaker
    voice = body.get("voice") or speaker.voice
    if not speaker.has_voice(voice):
        raise HTTPException(400, f"Unknown voice {voice!r}")
    speed = float(body.get("speed") or cfg().voice_speed)
    first = cfg().first_name
    text = f"Hey{' ' + first if first else ''}! This is how I'd sound. Want to try another one?"
    try:
        audio = await asyncio.to_thread(speaker.speak, text, speed, voice)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    pcm = (np.clip(audio.samples, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(audio.sample_rate)
        w.writeframes(pcm.tobytes())
    return Response(buf.getvalue(), media_type="audio/wav")


@app.get("/api/prefs")
async def get_prefs():
    return {"calls_you": cfg().calls_you, "watch_configured": state["watcher"].configured}


@app.post("/api/prefs")
async def set_prefs(request: Request):
    body = await request.json()
    if "calls_you" in body:
        save_settings({"calls_you": bool(body["calls_you"])})
        _reload()
    return await get_prefs()


@app.get("/api/events")
async def events():
    q: asyncio.Queue = asyncio.Queue()
    watcher: Watcher = state["watcher"]
    watcher.subscribers.add(q)

    async def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    reason = await asyncio.wait_for(q.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                payload = {"kind": reason.kind, "issue": reason.issue, "title": reason.title,
                           "headline": reason.headline}
                yield f"event: incoming-call\ndata: {json.dumps(payload)}\n\n"
        finally:
            watcher.subscribers.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/health")
async def health():
    hermes = False
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{cfg().hermes_url}/models", headers=_auth())
            hermes = r.status_code == 200
    except Exception:
        pass
    return {"ok": hermes and state["engines"] is not None, "hermes": hermes,
            "models": state["engines"] is not None, "loading": state["loading"],
            "error": state["error"], "voice": cfg().voice, "switching": state["switching"],
            "speaking": state["engines"].status() if state["engines"] is not None else None}


def main():
    s = cfg()
    uvicorn.run(app, host=s.host, port=s.port, log_level="warning")


if __name__ == "__main__":
    main()
