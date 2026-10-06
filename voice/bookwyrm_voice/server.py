"""The local call server the Bookwyrm companion app talks to.

    POST  /api/offer       start a call (WebRTC offer in, answer out); request_data may carry
                           {"reason": {...}} when Bookwyrm placed the call
    PATCH /api/offer       trickle ICE candidates
    POST  /api/chat        typed chat when not on a call: {"text", "session_id"?} -> streamed text
    POST  /api/warmup      while the phone rings: wake Hermes so the first answer isn't a cold start
    GET   /api/events      server-sent events: incoming calls from Bookwyrm (when enabled)
    GET   /api/prefs       {"calls_you": bool, "watch_configured": bool}
    POST  /api/prefs       {"calls_you": bool}
    GET   /health          is Hermes reachable, are the speech models loaded

Run:  python -m bookwyrm_voice.server
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from loguru import logger
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from .config import load_settings
from .pipeline import Engines, build_call, greet
from .watch import Reason, Watcher, load_prefs, save_prefs

settings = load_settings()
state: dict = {"engines": None, "watcher": None}
webrtc = SmallWebRTCRequestHandler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Loading speech models (first run downloads ~1 GB from GitHub)…")
    state["engines"] = await asyncio.to_thread(Engines, settings)
    logger.info(f"Ready. Hermes at {settings.hermes_url}; voice {settings.voice}")
    w = Watcher(settings.watch_repo, settings.watch_token, settings.watch_minutes)
    w.start()
    state["watcher"] = w
    yield
    await w.stop()
    await webrtc.close()


app = FastAPI(lifespan=lifespan)
# The app's renderer is a local page; only this machine can reach 127.0.0.1 anyway.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["x-session-id"])


async def _run_call(connection, reason: Reason | None):
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    call = build_call(transport, settings, state["engines"], greet=False,
                      instructions_extra=reason.instructions if reason else "")

    @transport.event_handler("on_client_connected")
    async def _connected(transport, client):  # noqa: ARG001
        await greet(call, reason.greeting if reason else settings.greeting)

    @transport.event_handler("on_client_disconnected")
    async def _hung_up(transport, client):  # noqa: ARG001
        await call.task.cancel()

    await WorkerRunner(handle_sigint=False).run(call.task)
    logger.info(f"Call ended (Hermes session {call.llm.session_id})")


@app.post("/api/offer")
async def offer(request: Request, background: BackgroundTasks):
    body = await request.json()
    req = SmallWebRTCRequest.from_dict(body)
    data = req.request_data or {}
    reason = Reason(**data["reason"]) if isinstance(data, dict) and data.get("reason") else None

    async def on_connection(connection):
        background.add_task(_run_call, connection, reason)

    return await webrtc.handle_web_request(request=req, webrtc_connection_callback=on_connection)


@app.patch("/api/offer")
async def ice(request: Request):
    await webrtc.handle_patch_request(SmallWebRTCPatchRequest(**await request.json()))
    return {"ok": True}


@app.post("/api/chat")
async def chat(request: Request):
    """Typed conversation with Bookwyrm outside a call: same Hermes profile, written replies."""
    import uuid
    body = await request.json()
    text = (body.get("text") or "").strip()
    session_id = body.get("session_id") or f"text-{uuid.uuid4().hex[:12]}"
    headers = {"Authorization": f"Bearer {settings.hermes_key}"}
    instructions = (
        "You're chatting by text in the Bookwyrm desktop app's small call card. Keep replies short; "
        "plain sentences, no headings or tables."
        + (f" You're talking with {settings.caller}; the app on their own machine is signed in as them." if settings.caller else "")
    )

    async def stream():
        async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=5)) as c:
            try:
                r = await c.post(f"{settings.hermes_url}/runs", headers=headers,
                                 json={"input": text, "session_id": session_id, "instructions": instructions})
                r.raise_for_status()
                run_id = r.json()["run_id"]
                async with c.stream("GET", f"{settings.hermes_url}/runs/{run_id}/events", headers=headers) as s:
                    async for line in s.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        ev = json.loads(line[5:])
                        if ev.get("event") == "message.delta" and ev.get("delta"):
                            yield ev["delta"]
                        elif ev.get("event") in ("run.completed", "run.failed", "run.cancelled", "run.interrupted"):
                            break
            except httpx.ConnectError:
                yield "I can't reach my notes right now. Is Hermes running on this machine?"

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8", headers={"x-session-id": session_id})


@app.post("/api/warmup")
async def warmup():
    # A tiny Hermes request wakes the gateway and the provider connection while the phone rings.
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            await c.get(f"{settings.hermes_url}/models", headers={"Authorization": f"Bearer {settings.hermes_key}"})
    except Exception:
        pass
    return {"ok": True}


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


@app.get("/api/prefs")
async def get_prefs():
    return {**load_prefs(), "watch_configured": state["watcher"].configured}


@app.post("/api/prefs")
async def set_prefs(request: Request):
    prefs = {**load_prefs(), **{k: v for k, v in (await request.json()).items() if k in ("calls_you",)}}
    save_prefs(prefs)
    return prefs


@app.get("/health")
async def health():
    hermes = False
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{settings.hermes_url}/models", headers={"Authorization": f"Bearer {settings.hermes_key}"})
            hermes = r.status_code == 200
    except Exception:
        pass
    return {"ok": hermes and state["engines"] is not None, "hermes": hermes,
            "models": state["engines"] is not None, "voice": settings.voice}


def main():
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
