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
    GET    /api/gaps             gap and quarantine issues, with the concept each is about
    POST   /api/gaps/{n}/comment | /not-applicable | /snooze
The workspace (a local copy of the repo, and each conversation's unpublished changes; ADR 0008)
    GET    /api/ws/status, POST /api/ws/sync, GET /api/ws/tree, GET /api/ws/file, GET /api/ws/search
    GET    /api/ws/changes, GET /api/ws/changes/{id}, GET /api/ws/changes/{id}/file
    POST   /api/ws/changes/{id}/write | edit | delete | move | show | meta | discard
    POST   /api/ws/changes/{id}/review   {"status", "path"?} the person's verdict; publishes when done
    POST   /api/ws/changes/{id}/publish
    POST   /api/ws/edit          a person's own edit from the app's editor: published straight away
    POST   /api/ws/review-edit   Bookwyrm's thoughts on a person's edit (streamed text)
    GET    /api/ws/events        server-sent events: edits, previews, syncs, publishes
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
import difflib
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
from .loopback import allow_loopback
from .config import EDITABLE, Settings, data_dir, load_settings, save_settings
from .history import History, context_text
from .models import download_size, engine_present
from .pipeline import Engines, build_call, greet
from .speakers import ENGINE_LABELS, KokoroSpeaker
from .watch import Reason, Watcher, classify
from .workspace import (
    Workspace, WorkspaceError, agent_context, apply_preserving, clean_path, gap_info, new_conversation_id,
)

allow_loopback()   # calls connect over 127.0.0.1, whatever the VPN or firewall does
_settings: Settings = load_settings()
state: dict = {"engines": None, "watcher": None, "loading": True, "error": None, "history": None,
               "switching": False, "workspace": None, "gaps_cache": None}
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


def workspace(required: bool = True) -> Workspace | None:
    """The local copy of the configured repo. A different repo (Settings → Knowledge repo) gets a
    fresh one; the old one's folder stays, so switching back is quick."""
    s = cfg()
    if not (s.repo and s.github_token):
        if required:
            raise HTTPException(409, "Bookwyrm needs a knowledge repo and a GitHub token. Choose them in Settings.")
        return None
    ws: Workspace | None = state["workspace"]
    if ws is None or ws.repo != s.repo or ws.token != s.github_token:   # a new repo, or a replaced token
        old = ws
        ws = state["workspace"] = Workspace(cfg)
        if old:
            ws.subscribers |= old.subscribers          # the app's event streams carry on
    if _Orphans.subscribers:                           # streams opened before there was a repo
        ws.subscribers |= _Orphans.subscribers
        _Orphans.subscribers.clear()
    return ws


async def _sync_loop():
    """Keep the local copy current: at start, then every few minutes."""
    while True:
        try:
            ws = workspace(required=False)
            if ws is not None:
                await ws.sync()
        except WorkspaceError:
            pass                                       # said in /api/ws/status; try again later
        except Exception:  # noqa: BLE001 — the loop must outlive any one bad sync
            logger.exception("Workspace sync failed")
        await asyncio.sleep(max(1.0, cfg().sync_minutes) * 60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Answer /health straight away; the models load in the background and /health says so.
    loader = asyncio.create_task(_load_engines())
    syncer = asyncio.create_task(_sync_loop())
    w = Watcher(cfg)
    w.start()
    state["watcher"] = w
    yield
    loader.cancel()
    syncer.cancel()
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
    session_id = session_id or new_conversation_id("voice")
    extra = reason.instructions if reason else ""
    extra += agent_context(session_id)
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
    instructions += agent_context(session_id, body.get("open_document") or None, body.get("preview") or None)
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


# ---- the workspace: the local copy of the repo, and each conversation's changes (ADR 0008) --------

def _ws_call(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except WorkspaceError as e:
        raise HTTPException(400, str(e)) from e


async def _ready(ws: Workspace, max_age: float = 0):
    """Sync if the copy is missing (first run) or older than ``max_age`` seconds."""
    try:
        if not ws.status()["ready"]:
            await ws.sync()
        elif max_age:
            await ws.sync(max_age=max_age)
    except Exception as e:  # noqa: BLE001 — offline is fine while there's a copy to work on
        if not isinstance(e, WorkspaceError):
            logger.exception("Workspace sync failed")
        if not ws.status()["ready"]:
            raise HTTPException(503, str(e)) from e


def _ago(ts: float | None) -> str:
    if not ts:
        return ""
    mins = int((time.time() - ts) // 60)
    return "just now" if mins < 1 else f"{mins} min ago" if mins < 90 else f"{mins // 60} h ago"


@app.get("/api/ws/status")
async def ws_status():
    ws = workspace(required=False)
    if ws is None:
        return {"ready": False, "error": "Choose a knowledge repo and GitHub token in Settings."}
    return {**ws.status(), "changes": len(ws.changes())}


@app.post("/api/ws/sync")
async def ws_sync():
    ws = workspace()
    try:
        r = await ws.sync()
    except WorkspaceError as e:
        raise HTTPException(502, str(e)) from e
    return {**ws.status(), "changed": r["changed"]}


@app.get("/api/ws/tree")
async def ws_tree(change: str = ""):
    ws = workspace()
    await _ready(ws)
    st = ws.status()
    return {"repo": ws.repo, "sha": st["sha"], "synced": _ago(st["synced_at"]), "tree": _ws_call(ws.tree, change or None)}


@app.get("/api/ws/file")
async def ws_file(path: str, change: str = ""):
    ws = workspace()
    await _ready(ws)
    content = _ws_call(ws.read, path, change or None)
    ch = ws.get_change(change) if change else None
    clean = _ws_call(clean_path, path)
    return {"path": clean, "content": content, "edited": bool(ch and clean in ch.files), "sha": ws.status()["sha"]}


@app.get("/api/ws/search")
async def ws_search(q: str, path: str = "", regex: bool = False, change: str = "", limit: int = 80):
    ws = workspace()
    await _ready(ws)
    return await asyncio.to_thread(lambda: _ws_call(ws.search, q, under=path, regex=regex, change=change or None,
                                                    limit=max(1, min(400, limit))))


@app.get("/api/ws/changes")
async def ws_changes():
    return workspace().changes()


@app.get("/api/ws/changes/{cid}")
async def ws_change(cid: str):
    ws = workspace()
    ch = _ws_call(ws.get_change, cid)
    if ch is None:
        return {"id": cid, "files": [], "counts": {"pending": 0, "approved": 0, "rejected": 0, "conflict": 0},
                "history": [], "resolves": [], "title": ""}
    return ws.summary(ch)


@app.get("/api/ws/changes/{cid}/file")
async def ws_change_file(cid: str, path: str):
    return _ws_call(workspace().file_view, cid, path)


async def _editing(cid: str) -> Workspace:
    """Before an edit: a current copy of the repo (pulled if the last check is over 30 s old)."""
    ws = workspace()
    await _ready(ws, max_age=30)
    return ws


@app.post("/api/ws/changes/{cid}/write")
async def ws_write(cid: str, request: Request):
    b = await request.json()
    ws = await _editing(cid)
    return _ws_call(ws.write, cid, b.get("path", ""), b.get("content", ""))


@app.post("/api/ws/changes/{cid}/edit")
async def ws_edit(cid: str, request: Request):
    b = await request.json()
    ws = await _editing(cid)
    return _ws_call(ws.edit, cid, b.get("path", ""), b.get("old", ""), b.get("new", ""),
                    replace_all=bool(b.get("replace_all")))


@app.post("/api/ws/changes/{cid}/delete")
async def ws_delete(cid: str, request: Request):
    b = await request.json()
    ws = await _editing(cid)
    return _ws_call(ws.delete, cid, b.get("path", ""))


@app.post("/api/ws/changes/{cid}/move")
async def ws_move(cid: str, request: Request):
    b = await request.json()
    ws = await _editing(cid)
    return _ws_call(ws.move, cid, b.get("from", ""), b.get("to", ""))


@app.post("/api/ws/changes/{cid}/show")
async def ws_show(cid: str, request: Request):
    b = await request.json()
    ws = workspace()
    await _ready(ws)
    return _ws_call(ws.show, cid, b.get("path", ""))


@app.post("/api/ws/changes/{cid}/meta")
async def ws_meta(cid: str, request: Request):
    b = await request.json()
    return _ws_call(workspace().set_meta, cid, title=b.get("title"), resolves=b.get("resolves") or [])


@app.post("/api/ws/changes/{cid}/discard")
async def ws_discard(cid: str, request: Request):
    b = await request.json()
    return _ws_call(workspace().discard, cid, b.get("path") or None)


def _note_published(cid: str, r: dict):
    """Put the outcome in the conversation, so the history (and the person) can see it."""
    if not r.get("ok"):
        return
    h = history()
    if not h.get(cid):
        return
    kind = h.get(cid)["kind"]
    what = "Merged" if r["merged"] else "Opened, waiting for review:"
    closed = f" Closed {', '.join(f'#{n}' for n in r['resolved'])}." if r.get("resolved") else ""
    h.add(cid, kind, "assistant", f"{what} [#{r['pr']} {r['title']}]({r['url']}).{closed}", via="event")


async def _publish(ws: Workspace, cid: str) -> dict:
    try:
        r = await ws.publish(cid)
    except WorkspaceError as e:
        raise HTTPException(502, str(e)) from e
    _note_published(cid, r)
    state["gaps_cache"] = None
    return r


@app.post("/api/ws/changes/{cid}/review")
async def ws_review(cid: str, request: Request):
    """Approve or discard one file, or every file still waiting (no ``path``). When nothing is left
    waiting and something is approved, this publishes: the person has approved it all."""
    b = await request.json()
    ws = workspace()
    summary = _ws_call(ws.review, cid, b.get("status", ""), b.get("path") or None)
    if ws.ready_to_publish(cid):
        return {"summary": summary, "published": await _publish(ws, cid)}
    c = summary["counts"]
    if summary["files"] and not c["pending"] and not c["approved"] and not c["conflict"]:
        _ws_call(ws.discard, cid)           # everything discarded: nothing to publish
        summary = ws.summary(ws.get_change(cid))
    return {"summary": summary, "published": None}


@app.post("/api/ws/changes/{cid}/publish")
async def ws_publish(cid: str):
    return await _publish(workspace(), cid)


@app.post("/api/ws/edit")
async def ws_person_edit(request: Request):
    """A person's own edit, made in the app's editor. They are the approver, so it's published at
    once; if GitHub changed the file meanwhile, the two are merged, or it says so."""
    b = await request.json()
    ws = await _editing("edit")
    cid = new_conversation_id("edit")
    content = b.get("content", "")
    # The editor rewrites Markdown in its own style. Apply only what the person changed to the file
    # as it was written: its normalised starting point vs. what they saved, onto the original.
    if b.get("normalized_base") is not None and b.get("base") is not None:
        content = apply_preserving(b["base"], b["normalized_base"], content)
    r: dict = {}
    try:
        _ws_call(ws.person_edit, cid, b.get("path", ""), content, b.get("base"))
        r = await _publish(ws, cid)
    finally:
        if not r.get("ok"):
            ws.discard(cid)        # the editor still has their text; nothing half-done stays behind
    return {**r, "change": cid}


@app.post("/api/ws/review-edit")
async def ws_review_edit(request: Request):
    """Bookwyrm reads a person's published edit against the repo's contracts and says, briefly,
    whether anything is worth improving. Advice only; it never undoes the edit."""
    b = await request.json()
    path = b.get("path", "")
    before, after = b.get("before") or "", b.get("after") or ""
    diff = "\n".join(difflib.unified_diff(before.splitlines(), after.splitlines(), "before", "after", lineterm="", n=2))[:12000]
    s = cfg()
    who = s.first_name or "The person"
    prompt = (f"{who} just edited `{path}` themselves in the Bookwyrm app, and it's already merged"
              f"{' (' + b['url'] + ')' if b.get('url') else ''}. The change:\n\n```diff\n{diff}\n```\n\n"
              "Check it against the repo's contracts if they cover this file (its concept type, structure sections, "
              "required fields) and for anything unclear. If something is worth improving, say what in one to three "
              "short sentences and offer to make the change. If it's fine, say so in one sentence. Never suggest "
              "undoing their edit, and don't change any files.")
    session = f"review-{uuid.uuid4().hex[:10]}"
    instructions = _CHAT_STYLE["window"] + agent_context(session, path)

    async def stream():
        async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=5)) as c:
            try:
                r = await c.post(f"{s.hermes_url}/runs", headers=_auth(),
                                 json={"input": prompt, "session_id": session, "instructions": instructions})
                r.raise_for_status()
                run_id = r.json()["run_id"]
                async with c.stream("GET", f"{s.hermes_url}/runs/{run_id}/events", headers=_auth()) as ev:
                    async for line in ev.aiter_lines():
                        if line.startswith("data:"):
                            e = json.loads(line[5:])
                            if e.get("event") == "message.delta" and e.get("delta"):
                                yield e["delta"]
                            elif e.get("event") in ("run.completed", "run.failed", "run.cancelled", "run.interrupted"):
                                break
            except httpx.HTTPError:
                yield ""

    return StreamingResponse(stream(), media_type="text/plain; charset=utf-8")


@app.get("/api/ws/events")
async def ws_events():
    q: asyncio.Queue = asyncio.Queue()
    ws = workspace(required=False)
    holder = ws if ws is not None else _Orphans
    holder.subscribers.add(q)

    async def stream():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"event: {ev.get('type', 'message')}\ndata: {json.dumps(ev)}\n\n"
        finally:
            for w in (state["workspace"], _Orphans):
                if w is not None:
                    w.subscribers.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream")


class _Orphans:
    """Event streams opened before a repo was chosen; the first workspace adopts them."""
    subscribers: set = set()


# ---- gaps -----------------------------------------------------------------------------------------

def _gap_prefs() -> dict:
    try:
        return json.loads((data_dir() / "gaps.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_gap_prefs(data: dict):
    f = data_dir() / "gaps.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data, indent=2), encoding="utf-8")


async def _issues(force: bool = False) -> list[dict]:
    cached = state["gaps_cache"]
    if cached and not force and time.time() - cached[0] < 60 and cached[1] == cfg().repo:
        return cached[2]
    ws = workspace()
    try:
        async with ws.gh.client() as c:
            issues = await ws.gh.issues(c)
    except WorkspaceError as e:
        raise HTTPException(502, str(e)) from e
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Couldn't reach GitHub ({type(e).__name__}).") from e
    issues = [i for i in issues if "pull_request" not in i]
    state["gaps_cache"] = (time.time(), cfg().repo, issues)
    return issues


@app.get("/api/gaps")
async def gaps(refresh: bool = False):
    """Every open gap and quarantine issue. ``mine`` marks the ones carrying one of the person's
    labels (Settings → Gaps); the app shows those by default."""
    issues = await _issues(force=refresh)
    snoozed = {int(k): v for k, v in _gap_prefs().get("snoozed", {}).items() if v > time.time()}
    mine_labels = set(cfg().gap_labels)
    out: dict[str, list] = {"gaps": [], "quarantine": []}
    labels: dict[str, int] = {}
    for i in issues:
        r = classify(i)
        if r is None:
            continue
        g = gap_info(i)
        g["mine"] = bool(mine_labels & set(g["labels"]))
        g["snoozed_until"] = snoozed.get(g["number"])
        out["gaps" if r.kind == "gap" else "quarantine"].append(g)
        for lbl in g["labels"]:
            labels[lbl] = labels.get(lbl, 0) + 1
    return {**out, "repo": cfg().repo, "labels": sorted(labels, key=lambda k: (-labels[k], k)),
            "mine_labels": sorted(mine_labels), "checked": time.time()}


@app.get("/api/gaps/count")
async def gap_count():
    """For the robot's badge: the person's own open gaps (all gaps when they haven't chosen labels)."""
    if workspace(required=False) is None:
        return {"count": 0}
    try:
        d = await gaps()
    except HTTPException:
        return {"count": 0}
    items = [g for g in d["gaps"] if not g["snoozed_until"]]
    mine = [g for g in items if g["mine"]] if d["mine_labels"] else items
    return {"count": len(mine), "filtered": bool(d["mine_labels"])}


def _signed(text: str) -> str:
    who = cfg().caller or "someone using Bookwyrm"
    return f"{text.strip()}\n\n— {who}, via Bookwyrm"


@app.post("/api/gaps/{number}/comment")
async def gap_comment(number: int, request: Request):
    text = ((await request.json()).get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Write something to post.")
    ws = workspace()
    try:
        async with ws.gh.client() as c:
            await ws.gh.comment(c, number, _signed(text))
    except WorkspaceError as e:
        raise HTTPException(502, str(e)) from e
    return {"ok": True}


@app.post("/api/gaps/{number}/not-applicable")
async def gap_not_applicable(number: int, request: Request):
    reason = ((await request.json()).get("reason") or "").strip()
    ws = workspace()
    try:
        async with ws.gh.client() as c:
            await ws.gh.comment(c, number, _signed(f"Not applicable{': ' + reason if reason else '.'}"))
            await ws.gh.close_issue(c, number, "not_planned")
    except WorkspaceError as e:
        raise HTTPException(502, str(e)) from e
    state["gaps_cache"] = None
    return {"ok": True}


@app.post("/api/gaps/{number}/snooze")
async def gap_snooze(number: int, request: Request):
    days = float((await request.json()).get("days") or 0)
    prefs = _gap_prefs()
    snoozed = {k: v for k, v in prefs.get("snoozed", {}).items() if v > time.time()}
    if days > 0:
        snoozed[str(number)] = time.time() + days * 86400
    else:
        snoozed.pop(str(number), None)
    _save_gap_prefs({**prefs, "snoozed": snoozed})
    return {"ok": True, "until": snoozed.get(str(number))}


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
    if "sync_minutes" in updates:
        updates["sync_minutes"] = min(60.0, max(1.0, float(updates["sync_minutes"])))
    if "gap_labels" in updates:
        labels = updates["gap_labels"] if isinstance(updates["gap_labels"], list) else []
        updates["gap_labels"] = sorted({str(x).strip()[:60] for x in labels if str(x).strip()})[:30]
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
