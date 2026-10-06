// Bookwyrm companion: the robot, its menu, the ring and the call card.
import { Call } from "./call.js";
import { applyOs } from "./os.js";
import "./app.css";

const $ = (id) => document.getElementById(id);
const body = document.body;
const bw = window.bookwyrm;
const ui = {
  robot: $("robot"), title: $("title"), status: $("status"), reason: $("reason"), lines: $("lines"),
  typeForm: $("type-form"), typeInput: $("type-input"), badge: $("badge"), remote: $("remote"), close: $("close"),
  answer: $("answer"), decline: $("decline"), mute: $("mute"), type: $("type"), expand: $("expand"), hangup: $("hangup"),
};

const MIN_RING_MS = 1700;      // long enough to feel like a call being placed
const INCOMING_RING_MS = 25000;

let voiceUrl = "http://127.0.0.1:7865";
let client = null;
let phase = "idle";            // idle | ringing | incoming | connecting | on-call | ended | chat
let callStarted = 0;
let clock = null;
let incomingReason = null;
let missed = 0;
let botLine = null;
let session = null;            // the Hermes session (and history entry) the card is showing

// ---------------------------------------------------------------- small helpers

function setState(s) { body.dataset.state = s; }
function setShape(s) { body.dataset.shape = s; bw.setShape(s); }
function show(...els) { els.forEach((e) => (e.hidden = false)); }
function hide(...els) { els.forEach((e) => (e.hidden = true)); }
function status(text) { ui.status.textContent = text; }
const newSession = (kind) => `${kind}-${crypto.randomUUID().slice(0, 12)}`;

function line(text, cls) {
  const li = document.createElement("li");
  li.className = cls;
  li.append(document.createTextNode(text));
  ui.lines.append(li);
  ui.lines.scrollTop = ui.lines.scrollHeight;
  return li;
}
const note = (text) => line(text, "note");

function elapsed() {
  const s = Math.floor((Date.now() - callStarted) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function controls(...visible) {
  [ui.answer, ui.decline, ui.mute, ui.type, ui.expand, ui.hangup].forEach((b) => (b.hidden = !visible.includes(b)));
}

// ---------------------------------------------------------------- the ring: a soft two-note chime

let audioCtx = null;
let ringTimer = null;

function strike(at, freq) {
  const ctx = audioCtx;
  const out = ctx.createGain();
  out.connect(ctx.destination);
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(0.18, at + 0.01);
  out.gain.exponentialRampToValueAtTime(0.0001, at + 1.0);
  for (const [mult, amp] of [[1, 1], [2.76, 0.35], [5.4, 0.12]]) {   // bell-like partials
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq * mult;
    g.gain.value = amp;
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + 1.1);
  }
}

function startRing() {
  audioCtx ??= new AudioContext();
  const ding = () => {
    const t = audioCtx.currentTime + 0.02;
    strike(t, 880);
    strike(t + 0.2, 740);
  };
  ding();
  ringTimer = setInterval(ding, 2000);
}
function stopRing() { clearInterval(ringTimer); ringTimer = null; }

// ---------------------------------------------------------------- health

const WAKING = "Bookwyrm is still waking up. Try again in a moment.";

// While the voice service is starting or loading its models, keep ringing rather than failing.
async function readyOrReason(maxWaitMs = 60000) {
  const until = Date.now() + maxWaitMs;
  for (;;) {
    const problem = await preflight();
    if (problem !== WAKING || Date.now() > until) return problem;
    status("Calling… (Bookwyrm is waking up)");
    await new Promise((r) => setTimeout(r, 1500));
    if (phase !== "ringing" && phase !== "connecting") return "cancelled";
  }
}

async function preflight() {
  const h = await bw.health();
  if (h?.down === "not-set-up") return "Bookwyrm's voice isn't set up on this computer yet. Run the Bookwyrm installer again.";
  if (h?.down === "starting" || h?.loading) return WAKING;
  if (h?.down === "stopped") return `Bookwyrm's voice service stopped. The end of its log (${h.log}):\n${h.detail || "(empty)"}`;
  if (h?.error) return `Bookwyrm couldn't load its voice: ${h.error}`;
  if (!h) return "Can't reach Bookwyrm's voice service.";
  if (!h.hermes) return "Bookwyrm's brain (Hermes) isn't running. Run: hermes gateway restart";
  return null;
}

// ---------------------------------------------------------------- calls

function handleMessage(type, data) {
  switch (type) {
    case "bot-started-speaking": setState("speaking"); break;
    case "bot-stopped-speaking": setState("listening"); dropUnsaid(); botLine = null; break;
    case "user-started-speaking": setState("listening"); dropUnsaid(); botLine = null; break;
    case "user-transcription":
      if (data.final && data.text?.trim()) { line(data.text.trim(), "you"); setState("thinking"); }
      break;
    case "bot-output": {
      // Each sentence arrives twice: "new" as Bookwyrm starts saying it, "completed" once said.
      // Show it faintly at first and firm it up when it has actually been spoken.
      const text = data.text?.trim();
      if (!text || data.aggregated_by === "word") return;
      const done = data.spoken === true || data.spoken_status === "completed";
      if (done) {
        const pending = [...ui.lines.querySelectorAll("span.said.live")].find((s) => s.dataset.text === text);
        if (pending) { pending.classList.remove("live"); return; }
      }
      if (!botLine) botLine = line("", "bot");
      const span = document.createElement("span");
      span.className = done ? "said" : "said live";
      span.dataset.text = text;
      span.textContent = (botLine.childNodes.length > 1 ? " " : "") + text;
      botLine.append(span);
      ui.lines.scrollTop = ui.lines.scrollHeight;
      break;
    }
  }
}

// Sentences queued but never spoken (Bookwyrm was interrupted) don't belong in the record.
function dropUnsaid() {
  ui.lines.querySelectorAll("span.said.live").forEach((s) => s.remove());
  ui.lines.querySelectorAll("li.bot").forEach((li) => { if (!li.textContent.trim()) li.remove(); });
}

function newCall(reason) {
  let level = 0;
  return new Call({
    url: voiceUrl,
    requestData: { session_id: session, ...(reason ? { reason } : {}) },
    onMessage: handleMessage,
    onLevel: (l) => {
      level = level * 0.6 + Math.min(1, l * 6) * 0.4;   // smooth, so the mouth doesn't flicker
      body.style.setProperty("--level", level.toFixed(3));
    },
    onDrop: () => { if (phase === "on-call") endCall("The line dropped."); },
  });
}

// `continueSession` carries on a conversation from the Bookwyrm window by voice.
async function placeCall(reason = null, continueSession = null) {
  if (client) return;
  phase = reason ? "connecting" : "ringing";
  session = continueSession || newSession("voice");
  setShape("open");
  if (!continueSession) ui.lines.replaceChildren();
  hide(ui.typeForm);
  ui.reason.hidden = !reason;
  if (reason) ui.reason.textContent = reason.headline;
  setState("ringing");
  status(reason ? "Connecting…" : "Calling…");
  controls(ui.hangup);
  if (!reason) startRing();

  const problem = await readyOrReason();
  if (problem === "cancelled") return;
  if (problem) { stopRing(); fail(problem); return; }
  fetch(`${voiceUrl}/api/warmup`, { method: "POST" }).catch(() => {});

  const rangSince = Date.now();
  client = newCall(reason);
  try {
    await client.start(ui.remote);
  } catch (e) {
    client = null;
    stopRing();
    fail(`Couldn't connect the call: ${e?.message || e}`);
    return;
  }
  if (phase !== "ringing" && phase !== "connecting") return;   // hung up while ringing
  await new Promise((r) => setTimeout(r, Math.max(0, MIN_RING_MS - (Date.now() - rangSince))));
  stopRing();
  phase = "on-call";
  callStarted = Date.now();
  setState("listening");
  status("0:00");
  clock = setInterval(() => status(elapsed()), 1000);
  controls(ui.mute, ui.type, ui.expand, ui.hangup);
  bw.callState(true);
}

async function endCall(why = null) {
  const was = phase;
  phase = "ended";
  stopRing();
  clearInterval(clock);
  if (client) { client.hangup(); client = null; }
  setState("idle");
  body.style.setProperty("--level", 0);
  if (was === "on-call") note(`${why ? why + " " : ""}Call ended · ${elapsed()}`);
  status(was === "on-call" ? "Call ended" : "Call cancelled");
  setMuted(false);
  phase = "chat";                     // what was said stays; type to carry on, or call again
  controls(ui.type, ui.expand, ui.answer);
  hide(ui.typeForm);
  incomingReason = null;
  bw.callState(false);
}

function fail(message) {
  phase = "ended";
  setState("idle");
  status("Couldn't place the call");
  note(message);
  controls();
}

function closeCard() {
  if (phase === "on-call" || phase === "ringing" || phase === "connecting") endCall();
  if (phase === "incoming") { stopRing(); incomingReason = null; }
  phase = "idle";
  setShape("docked");
  setState("idle");
  status("Ready when you are");
}

function setMuted(muted) {
  client?.setMuted(muted);
  ui.mute.setAttribute("aria-pressed", String(muted));
  ui.mute.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  ui.mute.title = muted ? "Unmute" : "Mute";
}

// ---------------------------------------------------------------- incoming calls (opt-in)

function incoming(reason) {
  if (!["idle", "ended", "chat"].includes(phase)) return;   // busy: Bookwyrm will try another time
  incomingReason = reason;
  phase = "incoming";
  setShape("open");
  ui.lines.replaceChildren();
  hide(ui.typeForm);
  ui.reason.textContent = reason.headline;
  show(ui.reason);
  setState("ringing");
  status("Bookwyrm is calling you");
  controls(ui.decline, ui.answer);
  startRing();
  setTimeout(() => { if (phase === "incoming") missedCall(); }, INCOMING_RING_MS);
}

function missedCall() {
  stopRing();
  missed += 1;
  ui.badge.textContent = String(missed);
  show(ui.badge);
  incomingReason = null;
  closeCard();
}

function listenForIncoming() {
  const es = new EventSource(`${voiceUrl}/api/events`);
  es.addEventListener("incoming-call", (e) => incoming(JSON.parse(e.data)));
  es.onerror = () => { es.close(); setTimeout(listenForIncoming, 10000); };
}

// ---------------------------------------------------------------- typing

function openChat() {
  if (phase === "on-call") { showTyping(); return; }
  phase = "chat";
  session = newSession("text");
  ui.lines.replaceChildren();
  hide(ui.reason);
  setShape("open");
  setState("idle");
  status("Message");
  controls(ui.expand, ui.answer);
  showTyping();
}

function showTyping() {
  show(ui.typeForm);
  hide(ui.type);
  setTimeout(() => ui.typeInput.focus(), 50);
}

async function typed(text) {
  line(text, "you");
  if (phase === "on-call" && client) {
    setState("thinking");
    client.sendText(text);
    return;
  }
  // Not on a call: a written reply, no voice.
  if (phase !== "chat") { phase = "chat"; controls(ui.expand, ui.answer); }
  setState("thinking");
  const li = line("", "bot thinking");
  try {
    const r = await fetch(`${voiceUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, session_id: session, surface: "card" }),
    });
    session = r.headers.get("x-session-id") || session;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true }).replace(/⁣/g, "");
      if (chunk) { li.classList.remove("thinking"); li.append(document.createTextNode(chunk)); }
      ui.lines.scrollTop = ui.lines.scrollHeight;
    }
  } catch {
    li.append(document.createTextNode("I couldn't reach the voice service to answer that."));
  }
  li.classList.remove("thinking");
  li.textContent = li.textContent.trim();
  setState("idle");
}

// ---------------------------------------------------------------- the robot: click for the menu, drag to move

let press = null;   // {x, y, dragging}

ui.robot.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, dragging: false };
  ui.robot.setPointerCapture(e.pointerId);
});
ui.robot.addEventListener("pointermove", (e) => {
  if (!press || press.dragging) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.dragging = true;
    body.classList.add("dragging");
    bw.dragStart();
  }
});
ui.robot.addEventListener("pointerup", (e) => {
  if (!press) return;
  const wasDrag = press.dragging;
  press = null;
  ui.robot.releasePointerCapture(e.pointerId);
  if (wasDrag) { body.classList.remove("dragging"); bw.dragEnd(); }
  else robotClicked();
});
ui.robot.addEventListener("pointercancel", () => {
  if (press?.dragging) { body.classList.remove("dragging"); bw.dragEnd(); }
  press = null;
});
ui.robot.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); robotClicked(); }
});
ui.robot.addEventListener("contextmenu", (e) => { e.preventDefault(); robotMenu(); });

function robotClicked() {
  if (missed) { missed = 0; hide(ui.badge); }
  if (phase === "incoming") { ui.answer.click(); return; }
  robotMenu();
}

function robotMenu() {
  bw.robotMenu({ phase, muted: ui.mute.getAttribute("aria-pressed") === "true", cardOpen: body.dataset.shape === "open" });
}

// What the menus (robot and menu-bar/tray) ask us to do.
bw.onAction(({ action, session_id }) => {
  switch (action) {
    case "call": if (phase === "chat" && session) placeCall(null, session); else placeCall(); break;
    case "continue-call": closeCard(); placeCall(null, session_id); break;
    case "message": openChat(); break;
    case "hangup": endCall(); break;
    case "mute": setMuted(true); break;
    case "unmute": setMuted(false); break;
    case "close-card": closeCard(); break;
    case "answer": ui.answer.click(); break;
  }
});

// ---------------------------------------------------------------- card buttons

ui.answer.addEventListener("click", () => {
  if (phase === "incoming") { stopRing(); placeCall(incomingReason); }
  else if (phase === "chat") placeCall(null, session);   // carry on by voice
});
ui.decline.addEventListener("click", () => {
  if (phase === "incoming") { stopRing(); incomingReason = null; }
  closeCard();
});
ui.hangup.addEventListener("click", () => endCall());
ui.close.addEventListener("click", () => closeCard());
ui.mute.addEventListener("click", () => setMuted(ui.mute.getAttribute("aria-pressed") !== "true"));
ui.type.addEventListener("click", showTyping);
ui.expand.addEventListener("click", () => bw.openWindow({ conversation: session }));
ui.typeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ui.typeInput.value.trim();
  ui.typeInput.value = "";
  if (text) typed(text);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (phase === "on-call") endCall();
  else if (body.dataset.shape === "open") closeCard();
});

// Only the robot and the card take clicks; the rest of the window is see-through.
let interactive = false;
document.addEventListener("mousemove", (e) => {
  const over = !!e.target.closest?.(".card, .robot") || body.classList.contains("dragging");
  if (over !== interactive) { interactive = over; bw.setInteractive(over); }
});

bw.onLayout(({ side, v }) => { body.dataset.side = side; body.dataset.v = v; });

(async () => {
  await applyOs();
  voiceUrl = await bw.voiceUrl();
  listenForIncoming();
})();
