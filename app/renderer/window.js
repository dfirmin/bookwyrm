// The Bookwyrm window: conversations (typed and called), the library, settings.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { applyOs } from "./os.js";
import "./window.css";

const $ = (id) => document.getElementById(id);
const bw = window.bookwyrm;
const body = document.body;
let voiceUrl = "http://127.0.0.1:7865";

let view = "chat";
let conv = null;              // current conversation id (the Hermes session), null for a new one
let conversations = [];
let sending = false;
let onCall = false;

marked.use({ gfm: true, breaks: false });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener"); }
});
const md = (text) => DOMPurify.sanitize(marked.parse(text || ""));

async function api(path, init) {
  const r = await fetch(`${voiceUrl}${path}`, init);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
  return r.json();
}
const json = (method, data) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

const ICON = {
  call: '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="fill" d="M6.6 2.8l1.6 3.4c.2.5.1 1-.3 1.4L6.6 8.8a10 10 0 0 0 4.6 4.6l1.2-1.3c.4-.4.9-.5 1.4-.3l3.4 1.6c.5.2.8.8.7 1.3l-.4 2c-.1.6-.7 1-1.3 1A14.6 14.6 0 0 1 2.3 3.7c0-.6.4-1.2 1-1.3l2-.4c.5-.1 1.1.2 1.3.8z"/></svg>',
  chat: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5z"/></svg>',
  trash: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 10h6.6L14 6"/></svg>',
  github: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 3h6v6M17 3l-7 7M9 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-4"/></svg>',
};

// ---------------------------------------------------------------- views

function setView(next, opts = {}) {
  view = next;
  body.dataset.view = next;
  for (const v of ["chat", "library", "settings"]) $(`${v}-view`).hidden = v !== next;
  if (next === "chat" && opts.conversation) conv = opts.conversation;
  if (next === "chat" && opts.fresh) conv = null;
  $("nav-new").setAttribute("aria-current", next === "chat" && !conv ? "page" : "false");
  $("nav-library").setAttribute("aria-current", next === "library" ? "page" : "false");
  $("nav-settings").setAttribute("aria-current", next === "settings" ? "page" : "false");
  $("call-button").hidden = next !== "chat";
  $("refresh-library").hidden = next !== "library";
  if (next === "library") { $("view-title").textContent = "Library"; loadLibrary(); }
  if (next === "settings") { $("view-title").textContent = "Settings"; loadSettings(); }
  if (next === "chat") {
    if (opts.conversation) openConversation(opts.conversation);
    else if (opts.fresh || !conv) newConversation();
    else $("view-title").textContent = titleOf(conv);
  }
  renderHistory();
}

function route(opts = {}) {
  if (opts.view === "library" || opts.view === "settings") setView(opts.view);
  else setView("chat", { conversation: opts.conversation, fresh: !opts.conversation && opts.view === "new" });
}

// ---------------------------------------------------------------- history (sidebar)

const titleOf = (id) => conversations.find((c) => c.id === id)?.title || "Conversation";

async function loadHistory() {
  try { conversations = await api("/api/history"); } catch { conversations = []; }
  renderHistory();
}

function bucket(ts) {
  const d = new Date(ts * 1000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5;
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Previous 7 days";
  if (diff < 30) return "Previous 30 days";
  return d.toLocaleDateString([], { month: "long", year: "numeric" });
}

function renderHistory() {
  const box = $("history");
  const q = $("search").value.trim().toLowerCase();
  const shown = conversations.filter((c) => !q || c.title.toLowerCase().includes(q) || (c.preview || "").toLowerCase().includes(q));
  box.replaceChildren();
  if (!shown.length) {
    const p = document.createElement("p");
    p.className = "none";
    p.textContent = q ? "No conversations match." : "Your calls and messages with Bookwyrm will appear here.";
    box.append(p);
    return;
  }
  let last = null;
  for (const c of shown) {
    const b = bucket(c.updated);
    if (b !== last) { const h = document.createElement("h3"); h.textContent = b; box.append(h); last = b; }
    const row = document.createElement("div");
    row.className = "conv";
    row.role = "listitem";
    row.tabIndex = 0;
    row.dataset.id = c.id;
    row.setAttribute("aria-current", String(view === "chat" && c.id === conv));
    row.title = c.preview || c.title;
    row.innerHTML = (c.kind === "call" || c.voice ? ICON.call : ICON.chat);
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = c.title;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.setAttribute("aria-label", `Delete “${c.title}”`);
    del.innerHTML = ICON.trash;
    row.append(t, del);
    row.addEventListener("click", (e) => { if (!e.target.closest(".del, input")) setView("chat", { conversation: c.id }); });
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === row) setView("chat", { conversation: c.id }); });
    row.addEventListener("dblclick", () => rename(row, c));
    del.addEventListener("click", async () => {
      if (!confirm(`Delete “${c.title}”? This removes it from this list; Bookwyrm's own memory keeps what it learned.`)) return;
      await api(`/api/history/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      if (conv === c.id) newConversation();
      loadHistory();
    });
    box.append(row);
  }
}

function rename(row, c) {
  const t = row.querySelector(".t");
  const input = document.createElement("input");
  input.value = c.title;
  t.replaceWith(input);
  input.focus();
  input.select();
  const done = async (save) => {
    if (save && input.value.trim() && input.value.trim() !== c.title) {
      await api(`/api/history/${encodeURIComponent(c.id)}`, json("PATCH", { title: input.value.trim() })).catch(() => {});
      await loadHistory();
      if (conv === c.id) $("view-title").textContent = titleOf(c.id);
    } else renderHistory();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
  input.addEventListener("blur", () => done(true), { once: true });
}

$("search").addEventListener("input", renderHistory);

// ---------------------------------------------------------------- a conversation

function newConversation() {
  conv = null;
  $("messages").replaceChildren();
  body.dataset.chat = "empty";
  $("view-title").textContent = "New conversation";
  $("composer-input").focus();
  renderHistory();
}

async function openConversation(id) {
  conv = id;
  $("messages").replaceChildren();
  body.dataset.chat = "";
  try {
    const c = await api(`/api/history/${encodeURIComponent(id)}`);
    $("view-title").textContent = c.title;
    let lastVia = null;
    for (const m of c.messages) {
      if (m.via === "voice" && lastVia !== "voice") divider(m.at);
      lastVia = m.via;
      addMessage(m.role, m.text);
    }
    scrollDown();
  } catch {
    $("view-title").textContent = "Conversation";
    addMessage("assistant", "This conversation isn't in the history any more.");
  }
  renderHistory();
}

function divider(at) {
  const li = document.createElement("li");
  li.className = "call-divider";
  li.innerHTML = ICON.call;
  li.append(` Call, ${new Date(at * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
  $("messages").append(li);
}

function addMessage(role, text) {
  const li = document.createElement("li");
  li.className = `msg ${role}`;
  if (role === "assistant") li.innerHTML = md(text);
  else li.textContent = text;
  $("messages").append(li);
  body.dataset.chat = "";
  return li;
}

const scrollDown = () => { const s = $("scroller"); s.scrollTop = s.scrollHeight; };

async function send(text) {
  if (sending || !text.trim()) return;
  sending = true;
  updateSend();
  const isNew = !conv;
  if (isNew) conv = `text-${crypto.randomUUID().slice(0, 12)}`;
  addMessage("user", text);
  const li = addMessage("assistant", "");
  li.innerHTML = '<span class="working">Thinking</span>';
  scrollDown();
  let reply = "";
  let frame = 0;
  const paint = () => { frame = 0; li.innerHTML = md(reply) || '<span class="working">Thinking</span>'; scrollDown(); };
  try {
    const r = await fetch(`${voiceUrl}/api/chat`, json("POST", { text, session_id: conv, surface: "window" }));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (chunk.includes("⁣") && !reply.trim()) li.innerHTML = '<span class="working">Checking the repo</span>';
      reply += chunk.replace(/⁣/g, "");
      if (reply.trim() && !frame) frame = requestAnimationFrame(paint);
    }
    paint();
  } catch (e) {
    li.innerHTML = md(`Couldn't reach Bookwyrm's voice service (${e.message}). Is Bookwyrm still running?`);
  }
  sending = false;
  updateSend();
  await loadHistory();
  if (isNew) $("view-title").textContent = titleOf(conv);
}

const input = $("composer-input");
function updateSend() { $("send").disabled = sending || !input.value.trim(); }
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(200, input.scrollHeight)}px`;
  updateSend();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  input.style.height = "auto";
  send(text);
});
for (const b of document.querySelectorAll(".suggestion")) b.addEventListener("click", () => send(b.textContent));

$("call-button").addEventListener("click", () => { if (!onCall) bw.callFromWindow(conv); });
bw.onCallState(async (on) => {
  onCall = on;
  $("call-button").classList.toggle("on-call", on);
  $("call-label").textContent = on ? "On a call" : "Call";
  $("call-button").disabled = on;
  if (!on) {   // the call was just saved to history: show it
    await new Promise((r) => setTimeout(r, 1200));
    await loadHistory();
    if (view === "chat" && conv) openConversation(conv);
    else if (view === "chat" && conversations[0]?.kind === "call") openConversation(conversations[0].id);
  }
});

// ---------------------------------------------------------------- library

const ago = (iso) => {
  if (!iso) return "";
  const days = Math.round((Date.parse(iso) - Date.now()) / 864e5);
  const rtf = new Intl.RelativeTimeFormat([], { numeric: "auto" });
  if (Math.abs(days) >= 1) return rtf.format(days, "day");
  return rtf.format(Math.round((Date.parse(iso) - Date.now()) / 36e5), "hour");
};

function section(title, items, empty, row) {
  const frag = document.createDocumentFragment();
  const h = document.createElement("h2");
  h.textContent = title;
  if (items.length) { const n = document.createElement("span"); n.className = "n"; n.textContent = ` ${items.length}`; h.append(n); }
  const group = document.createElement("div");
  group.className = "group";
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "nothing";
    p.textContent = empty;
    group.append(p);
  } else {
    const ul = document.createElement("ul");
    ul.className = "items";
    for (const it of items) ul.append(row(it));
    group.append(ul);
  }
  frag.append(h, group);
  return frag;
}

function itemRow(it, meta, prompt, tag) {
  const li = document.createElement("li");
  li.className = "item";
  const what = document.createElement("div");
  what.className = "what";
  const b = document.createElement("b");
  b.textContent = it.title;
  const small = document.createElement("small");
  small.textContent = meta;
  what.append(b, small);
  li.append(what);
  if (tag) { const t = document.createElement("span"); t.className = `tag ${tag}`; t.textContent = tag === "bookwyrm" ? "Bookwyrm" : tag === "archivist" ? "Archivist" : "People"; li.append(t); }
  const ask = document.createElement("button");
  ask.type = "button";
  ask.className = "button small";
  ask.textContent = "Ask Bookwyrm";
  ask.addEventListener("click", () => { setView("chat", { fresh: true }); send(prompt); });
  const gh = document.createElement("a");
  gh.className = "gh";
  gh.href = it.url;
  gh.title = "Open on GitHub";
  gh.setAttribute("aria-label", `Open #${it.number} on GitHub`);
  gh.innerHTML = ICON.github;
  li.append(ask, gh);
  return li;
}

async function loadLibrary() {
  const out = $("library-body");
  $("library-lede").textContent = "Checking the repo…";
  let d;
  try { d = await api("/api/library"); } catch (e) { d = { error: `Couldn't reach Bookwyrm's voice service (${e.message}).` }; }
  out.replaceChildren();
  if (d.error) {
    $("library-lede").textContent = "";
    const p = document.createElement("p");
    p.className = "problem";
    p.textContent = d.error;
    out.append(p);
    return;
  }
  const lede = $("library-lede");
  lede.replaceChildren("What needs you in ");
  const a = document.createElement("a");
  a.href = d.url; a.textContent = d.repo; a.target = "_blank";
  lede.append(a, ". Ask Bookwyrm about any of these and it will work through it with you.");
  const draft = (t) => t.replace(/^Quarantined:\s*/, "");
  // Archivist titles gaps "[team] Concept — kind"; show the concept, with team and kind as detail.
  const gap = (t) => {
    const m = /^(?:\[([^\]]+)\]\s*)?(.*?)\s+—\s+([a-z][a-z0-9_]*)$/.exec(t);
    return m ? { concept: m[2], team: m[1], kind: m[3].replace(/_/g, " ") } : { concept: t };
  };
  out.append(
    section("In quarantine", d.quarantine, "Nothing in quarantine.", (it) => itemRow({ ...it, title: draft(it.title) },
      `#${it.number}, quarantined ${ago(it.created)}`,
      `Let's sort out the quarantined draft ${draft(it.title)} (issue #${it.number}). Why is it there, and what are my options?`)),
    section("Gaps", d.gaps, "No open gaps.", (it) => {
      const g = gap(it.title);
      const meta = [`#${it.number}`, g.kind && `${g.kind[0].toUpperCase()}${g.kind.slice(1)}`, g.team && `${g.team} team`, `opened ${ago(it.created)}`].filter(Boolean).join(", ");
      return itemRow({ ...it, title: g.concept }, meta,
        `Help me resolve the gap in issue #${it.number}: "${it.title}". What's missing, and what do you need from me?`);
    }),
    section("Pull requests", d.pulls, "No open pull requests.", (it) => itemRow(it, `#${it.number}, ${it.branch}`,
      `Walk me through pull request #${it.number}, "${it.title}". What does it change, and is it ready to merge?`, it.by)),
  );
  setLibraryCount(d.quarantine.length + d.gaps.length);
}

function setLibraryCount(n) {
  $("library-count").textContent = String(n);
  $("library-count").hidden = !n;
}
$("refresh-library").addEventListener("click", loadLibrary);

// ---------------------------------------------------------------- settings

const form = $("settings");
let settings = null;
let savedTimer = null;

function saved(text = "Saved") {
  $("saved").textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("saved").textContent = ""), 2500);
}

async function save(patch) {
  try {
    settings = await api("/api/settings", json("PUT", patch));
    saved();
  } catch (e) {
    saved(`Couldn't save: ${e.message}`);
  }
}

function keyStatus(id, ok) {
  $(id).textContent = ok ? "Saved on this computer" : "Missing";
  $(id).className = `key-status ${ok ? "ok" : "missing"}`;
}

async function loadSettings() {
  try { settings = await api("/api/settings"); } catch (e) { saved(`Couldn't load settings: ${e.message}`); return; }
  form.name.value = settings.name;
  form.team.value = settings.team;
  form.repo.value = settings.repo;
  form.voice_speed.value = settings.voice_speed;
  form.calls_you.checked = settings.calls_you;
  form.watch_minutes.value = String(Math.round(settings.watch_minutes));
  if (!form.watch_minutes.value) form.watch_minutes.value = "5";
  $("repo-apply").hidden = true;
  keyStatus("github-status", settings.keys.github);
  keyStatus("anthropic-status", settings.keys.anthropic);
  $("login-item").checked = await bw.loginItem();
  $("show-robot").checked = await bw.companionVisible();
  const info = await bw.appInfo();
  $("app-paths").textContent = `Settings: ${settings.paths.settings}. Voice service log: ${info.log}.`;
  const v = await api("/api/voices").catch(() => ({ voices: [] }));
  const sel = $("voice");
  sel.replaceChildren(...(v.voices.length ? v.voices : [{ id: settings.voice, label: settings.voice, detail: "loading voices" }]).map((x) => {
    const o = document.createElement("option");
    o.value = x.id;
    o.textContent = `${x.label} (${x.detail})`;
    return o;
  }));
  sel.value = settings.voice;
  healthLine();
}

async function healthLine() {
  const h = await bw.health();
  $("voice-health").textContent = !h ? "Not reachable"
    : h.down === "not-set-up" ? "Not set up. Run the installer again."
    : h.down === "starting" || h.loading ? "Starting…"
    : h.down === "stopped" ? "Stopped. Restart it, or check the log."
    : h.error ? `Couldn't load its voice: ${h.error}`
    : h.hermes ? "Running" : "Running, but Hermes isn't answering (try: hermes gateway restart)";
}

form.addEventListener("submit", (e) => e.preventDefault());
for (const name of ["name", "team"]) {
  form[name].addEventListener("change", () => save({ [name]: form[name].value }));
}
form.voice.addEventListener("change", () => save({ voice: form.voice.value }));
form.voice_speed.addEventListener("change", () => save({ voice_speed: Number(form.voice_speed.value) }));
form.calls_you.addEventListener("change", () => save({ calls_you: form.calls_you.checked }));
form.watch_minutes.addEventListener("change", () => save({ watch_minutes: Number(form.watch_minutes.value) }));
$("voice-play").addEventListener("click", async () => {
  $("voice-play").disabled = true;
  try {
    const r = await fetch(`${voiceUrl}/api/voices/preview`, json("POST", { voice: form.voice.value, speed: Number(form.voice_speed.value) }));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const audio = $("preview-audio");
    audio.src = URL.createObjectURL(await r.blob());
    await audio.play();
  } catch (e) {
    saved(`Couldn't play the sample: ${e.message}`);
  }
  $("voice-play").disabled = false;
});
$("login-item").addEventListener("change", async (e) => { e.target.checked = await bw.setLoginItem(e.target.checked); saved(); });
$("show-robot").addEventListener("change", async (e) => { await bw.setCompanionVisible(e.target.checked); saved(); });
$("voice-restart").addEventListener("click", async () => {
  $("voice-health").textContent = "Restarting…";
  await bw.restartVoice();
  setTimeout(healthLine, 3000);
});

// Repo and keys go through the setup wizard: they change Bookwyrm's Hermes profile too.
form.repo.addEventListener("input", () => { $("repo-apply").hidden = form.repo.value.trim() === settings?.repo; });
$("repo-apply").addEventListener("click", () => {
  const repo = form.repo.value.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) { saved("The repository should look like owner/name."); return; }
  applySetup({ repo }, `Switching Bookwyrm to ${repo}…`);
});
for (const row of form.querySelectorAll("[data-key]")) {
  const entry = form.querySelector(`[data-entry="${row.dataset.key}"]`);
  row.querySelector(".replace").addEventListener("click", () => { entry.hidden = !entry.hidden; entry.querySelector("input").focus(); });
  entry.querySelector(".save-key").addEventListener("click", () => {
    const value = entry.querySelector("input").value.trim();
    if (!value) return;
    entry.querySelector("input").value = "";
    entry.hidden = true;
    applySetup({ [row.dataset.key]: value }, "Saving the key and checking it works…");
  });
}

async function applySetup(changes, message) {
  const log = $("setup-log");
  log.hidden = false;
  log.textContent = `${message}\n`;
  for (const b of form.querySelectorAll("button")) b.disabled = true;
  const result = await bw.runSetup(changes);
  for (const b of form.querySelectorAll("button")) b.disabled = false;
  log.textContent += result.ok ? "\nDone." : `\nThat didn't finish cleanly${result.message ? `: ${result.message}` : ""}. The lines above say why.`;
  log.scrollTop = log.scrollHeight;
  await loadSettings();
}
bw.onSetupLine((l) => { const log = $("setup-log"); log.textContent += `${l}\n`; log.scrollTop = log.scrollHeight; });

// ---------------------------------------------------------------- start

$("nav-new").addEventListener("click", () => setView("chat", { fresh: true }));
$("nav-library").addEventListener("click", () => setView("library"));
$("nav-settings").addEventListener("click", () => setView("settings"));
bw.onShow((opts) => route(opts));

(async () => {
  await applyOs();
  voiceUrl = await bw.voiceUrl();
  try {
    const s = await api("/api/settings");
    const first = s.name.split(" ")[0];
    if (first) $("empty-greeting").textContent = `What do you need, ${first}?`;
    if (s.repo) $("empty-repo").textContent = `Ask about ${s.repo}, or tell Bookwyrm something it should know.`;
  } catch {}
  await loadHistory();
  route(Object.fromEntries(new URLSearchParams(location.search)));
  api("/api/library").then((d) => { if (!d.error) setLibraryCount(d.quarantine.length + d.gaps.length); }).catch(() => {});
})();
