// Bookwyrm companion renderer: the dragon, the ring, the call card.
import { Call } from "./call.js";
import "./app.css";

const $ = (id) => document.getElementById(id);
const body = document.body;
const ui = {
  dragon: $("dragon"), status: $("status"), stamp: $("stamp"), reason: $("reason"), lines: $("lines"),
  typeForm: $("type-form"), typeInput: $("type-input"), badge: $("badge"), remote: $("remote"),
  answer: $("answer"), decline: $("decline"), mute: $("mute"), type: $("type"), hangup: $("hangup"),
};

const MIN_RING_MS = 1700;      // long enough to feel like a call being placed
const INCOMING_RING_MS = 25000;

let voiceUrl = "http://127.0.0.1:7865";
let client = null;
let phase = "idle";            // idle | ringing | incoming | connecting | on-call | ended
let callStarted = 0;
let clock = null;
let incomingReason = null;
let missed = 0;
let botLine = null;
let textSession = null;

// ---------------------------------------------------------------- small helpers

function setState(s) { body.dataset.state = s; }
function setShape(s) { body.dataset.shape = s; window.bookwyrm.setShape(s); }
function show(...els) { els.forEach((e) => (e.hidden = false)); }
function hide(...els) { els.forEach((e) => (e.hidden = true)); }
function status(text) { ui.status.textContent = text; }

function line(who, text, cls) {
  const li = document.createElement("li");
  li.className = cls;
  if (who) {
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who;
    li.append(w);
  }
  li.append(document.createTextNode(text));
  ui.lines.append(li);
  ui.lines.scrollTop = ui.lines.scrollHeight;
  return li;
}
const note = (text) => line(null, text, "note");

function elapsed() {
  const s = Math.floor((Date.now() - callStarted) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function controls(...visible) {
  [ui.answer, ui.decline, ui.mute, ui.type, ui.hangup].forEach((b) => (b.hidden = !visible.includes(b)));
}

// ---------------------------------------------------------------- the ring: a small struck bell

let audioCtx = null;
let ringTimer = null;

function strike(at, freq) {
  const ctx = audioCtx;
  const out = ctx.createGain();
  out.connect(ctx.destination);
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(0.22, at + 0.01);
  out.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
  for (const [mult, amp] of [[1, 1], [2.76, 0.45], [5.4, 0.2]]) {   // bell-like partials
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq * mult;
    g.gain.value = amp;
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + 1.2);
  }
}

function startRing() {
  audioCtx ??= new AudioContext();
  const ding = () => {
    const t = audioCtx.currentTime + 0.02;
    strike(t, 880);
    strike(t + 0.22, 740);
  };
  ding();
  ringTimer = setInterval(ding, 2000);
}
function stopRing() { clearInterval(ringTimer); ringTimer = null; }

// ---------------------------------------------------------------- health

async function preflight() {
  const h = await window.bookwyrm.health();
  if (!h) return "Can't reach Bookwyrm's voice service on this Mac. It starts with the app once setup is done.";
  if (!h.hermes) return "Bookwyrm's brain isn't running. Open the Hermes app, or run: hermes gateway";
  if (!h.models) return "Bookwyrm is still loading its voice. Try again in a minute.";
  return null;
}

// ---------------------------------------------------------------- calls

function handleMessage(type, data) {
  switch (type) {
    case "bot-started-speaking": setState("speaking"); break;
    case "bot-stopped-speaking": setState("listening"); dropUnsaid(); botLine = null; break;
    case "user-started-speaking": setState("listening"); dropUnsaid(); botLine = null; break;
    case "user-transcription":
      if (data.final && data.text?.trim()) { line("You", data.text.trim(), "you"); setState("thinking"); }
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
      if (!botLine) botLine = line("Bookwyrm", "", "bot");
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
}

function newCall(reason) {
  let level = 0;
  return new Call({
    url: voiceUrl,
    requestData: reason ? { reason } : {},
    onMessage: handleMessage,
    onLevel: (l) => {
      level = level * 0.6 + Math.min(1, l * 6) * 0.4;   // smooth, so the mouth doesn't flicker
      body.style.setProperty("--level", level.toFixed(3));
    },
    onDrop: () => { if (phase === "on-call") endCall("The line dropped."); },
  });
}

async function placeCall(reason = null) {
  phase = reason ? "connecting" : "ringing";
  setShape("open");
  ui.lines.replaceChildren();
  hide(ui.stamp, ui.typeForm);
  ui.reason.hidden = !reason;
  if (reason) ui.reason.textContent = reason.headline;
  setState("ringing");
  status(reason ? "Connecting…" : "Calling Bookwyrm…");
  controls(ui.hangup);
  if (!reason) startRing();

  const problem = await preflight();
  if (problem) { stopRing(); fail(problem); return; }
  fetch(`${voiceUrl}/api/warmup`, { method: "POST" }).catch(() => {});

  const rangSince = Date.now();
  client = newCall(reason);
  try {
    await client.start(ui.remote);
  } catch (e) {
    stopRing();
    fail(`Couldn't connect the call: ${e?.message || e}`);
    return;
  }
  if (phase !== "ringing" && phase !== "connecting") return;   // hung up while ringing
  await new Promise((r) => setTimeout(r, Math.max(0, MIN_RING_MS - (Date.now() - rangSince))));
  stopRing();
  phase = "on-call";
  callStarted = Date.now();
  ui.stamp.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  show(ui.stamp);
  setState("listening");
  status("On a call · 0:00");
  clock = setInterval(() => status(`On a call · ${elapsed()}`), 1000);
  controls(ui.mute, ui.type, ui.hangup);
}

async function endCall(why = null) {
  const was = phase;
  phase = "ended";
  stopRing();
  clearInterval(clock);
  if (client) { client.hangup(); client = null; }
  setState("idle");
  body.style.setProperty("--level", 0);
  if (was === "on-call") note(`${why ? why + " " : ""}Call ended after ${elapsed()}.`);
  status(was === "on-call" ? "Call ended" : "Call cancelled");
  ui.mute.setAttribute("aria-pressed", "false");
  ui.answer.textContent = "Call again";
  ui.decline.textContent = "Close";
  controls(ui.answer, ui.decline, ui.type);
  hide(ui.typeForm);
  incomingReason = null;
}

function fail(message) {
  phase = "ended";
  setState("idle");
  status("Couldn't place the call");
  note(message);
  ui.answer.textContent = "Try again";
  ui.decline.textContent = "Close";
  controls(ui.answer, ui.decline);
}

function closeCard() {
  phase = "idle";
  setShape("docked");
  setState("idle");
  status("Ready when you are");
}

// ---------------------------------------------------------------- incoming calls (opt-in)

function incoming(reason) {
  if (phase !== "idle" && phase !== "ended") return;   // already busy: Bookwyrm will try another time
  incomingReason = reason;
  phase = "incoming";
  setShape("open");
  ui.lines.replaceChildren();
  hide(ui.stamp, ui.typeForm);
  ui.reason.textContent = reason.headline;
  show(ui.reason);
  setState("ringing");
  status("Calling you…");
  ui.answer.textContent = "Answer";
  ui.decline.textContent = "Not now";
  controls(ui.answer, ui.decline);
  startRing();
  setTimeout(() => { if (phase === "incoming") missedCall(); }, INCOMING_RING_MS);
}

function missedCall() {
  stopRing();
  missed += 1;
  ui.badge.textContent = String(missed);
  show(ui.badge);
  note(`Missed call: ${incomingReason?.headline ?? "Bookwyrm"}`);
  incomingReason = null;
  closeCard();
}

function listenForIncoming() {
  const es = new EventSource(`${voiceUrl}/api/events`);
  es.addEventListener("incoming-call", (e) => incoming(JSON.parse(e.data)));
  es.onerror = () => { es.close(); setTimeout(listenForIncoming, 10000); };
}

// ---------------------------------------------------------------- typing

async function typed(text) {
  line("You", text, "you");
  if (phase === "on-call" && client) {
    setState("thinking");
    client.sendText(text);
    return;
  }
  // Not on a call: a text reply, no voice.
  setState("thinking");
  const li = line("Bookwyrm", "", "bot");
  try {
    const r = await fetch(`${voiceUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, session_id: textSession }),
    });
    textSession = r.headers.get("x-session-id") || textSession;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      li.append(document.createTextNode(dec.decode(value, { stream: true })));
      ui.lines.scrollTop = ui.lines.scrollHeight;
    }
  } catch {
    li.append(document.createTextNode("I couldn't reach the voice service to answer that."));
  }
  setState("idle");
}

// ---------------------------------------------------------------- wiring

ui.dragon.addEventListener("click", () => {
  if (missed) { missed = 0; hide(ui.badge); }
  if (phase === "idle") placeCall();
  else if (phase === "incoming") ui.answer.click();
  else if (phase === "ended") closeCard();
});
ui.dragon.addEventListener("contextmenu", (e) => { e.preventDefault(); window.bookwyrm.dragonMenu(); });

ui.answer.addEventListener("click", () => {
  if (phase === "incoming") { stopRing(); placeCall(incomingReason); }
  else placeCall();
});
ui.decline.addEventListener("click", () => {
  if (phase === "incoming") { stopRing(); incomingReason = null; }
  closeCard();
});
ui.hangup.addEventListener("click", () => endCall());
ui.mute.addEventListener("click", () => {
  const muted = ui.mute.getAttribute("aria-pressed") !== "true";
  client?.setMuted(muted);
  ui.mute.setAttribute("aria-pressed", String(muted));
  ui.mute.textContent = muted ? "Muted" : "Mute";
});
ui.type.addEventListener("click", () => { show(ui.typeForm); hide(ui.type); ui.typeInput.focus(); });
ui.typeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ui.typeInput.value.trim();
  ui.typeInput.value = "";
  if (text) typed(text);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && phase === "on-call") endCall();
  else if (e.key === "Escape" && (phase === "ended" || phase === "idle")) closeCard();
});

// Only the dragon and the card take clicks; the rest of the window is see-through.
let interactive = false;
document.addEventListener("mousemove", (e) => {
  const over = !!e.target.closest?.(".card, .dragon");
  if (over !== interactive) { interactive = over; window.bookwyrm.setInteractive(over); }
});

(async () => {
  voiceUrl = await window.bookwyrm.voiceUrl();
  listenForIncoming();
})();
