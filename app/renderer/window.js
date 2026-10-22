// The Bookwyrm window: conversations (typed and called), the knowledge repo's documents, gaps,
// settings, and beside them the document pane (doc.js): documents rendered, Bookwyrm's edits to
// review, the person's own edits.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { closeDoc, docContext, handleEvent, initDoc, isEditing, openDocument, openPath, showPreview } from "./doc.js";
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
  for (const v of ["chat", "knowledge", "library", "settings"]) $(`${v}-view`).hidden = v !== next;
  if (next === "chat" && opts.conversation) conv = opts.conversation;
  if (next === "chat" && opts.fresh) conv = null;
  $("nav-new").setAttribute("aria-current", next === "chat" && !conv ? "page" : "false");
  $("nav-knowledge").setAttribute("aria-current", next === "knowledge" ? "page" : "false");
  $("nav-library").setAttribute("aria-current", next === "library" ? "page" : "false");
  $("nav-settings").setAttribute("aria-current", next === "settings" ? "page" : "false");
  $("call-button").hidden = next !== "chat";
  $("refresh-library").hidden = next !== "library";
  if (next === "knowledge") { $("view-title").textContent = "Knowledge"; loadTree(); }
  if (next === "library") { $("view-title").textContent = "Gaps"; loadLibrary(); }
  if (next === "settings") { $("view-title").textContent = "Settings"; loadSettings(); }
  if (next === "chat") {
    if (opts.conversation) openConversation(opts.conversation);
    else if (opts.fresh || !conv) newConversation();
    else $("view-title").textContent = titleOf(conv);
  }
  renderHistory();
}

function route(opts = {}) {
  if (["library", "settings", "knowledge"].includes(opts.view)) setView(opts.view);
  else if (opts.view === "preview" && (opts.change || opts.path)) {
    // Bookwyrm edited or pointed at something (often on a call): the conversation, with it beside it.
    if (view !== "chat" && view !== "knowledge") setView("chat", { conversation: conv || undefined });
    if (opts.change) showPreview(opts.change, opts.path || null);
    else openDocument(opts.path);
  } else setView("chat", { conversation: opts.conversation, fresh: !opts.conversation && opts.view === "new" });
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
      if (m.via === "event") eventNote(m.text);
      else addMessage(m.role, m.text);
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

/** A line in the conversation for something that happened (an approved change published). */
function eventNote(text) {
  const li = document.createElement("li");
  li.className = "event-note";
  li.innerHTML = md(text);
  $("messages").append(li);
  body.dataset.chat = "";
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
    const r = await fetch(`${voiceUrl}/api/chat`, json("POST", { text, session_id: conv, surface: "window", ...docContext() }));
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

// ---------------------------------------------------------------- knowledge: the repo's documents

let tree = null;
const openDirs = new Set(["knowledge"]);

async function loadTree() {
  const box = $("tree");
  if (!tree) box.innerHTML = '<li class="tree-note">Reading the repo…</li>';
  try {
    tree = await api("/api/ws/tree");
  } catch (e) {
    box.replaceChildren(Object.assign(document.createElement("li"), { className: "tree-note problem-text", textContent: e.message }));
    return;
  }
  renderTree();
}

function renderTree() {
  const box = $("tree");
  const q = $("tree-filter").value.trim().toLowerCase();
  const current = openPath();
  const walk = (nodes, depth) => {
    const out = [];
    for (const n of nodes) {
      if (n.dir) {
        const kids = walk(n.children, depth + 1);
        if (q && !kids.length) continue;
        const open = q ? true : openDirs.has(n.path);
        const li = document.createElement("li");
        li.role = "treeitem";
        li.setAttribute("aria-expanded", String(open));
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row dir";
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.innerHTML = '<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5l5 5-5 5"/></svg><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h4l1.5 2h6.5a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
        row.append(n.name);
        row.addEventListener("click", () => { if (openDirs.has(n.path)) openDirs.delete(n.path); else openDirs.add(n.path); renderTree(); });
        li.append(row);
        if (open) {
          const ul = document.createElement("ul");
          ul.role = "group";
          ul.append(...kids);
          li.append(ul);
        }
        out.push(li);
      } else {
        if (q && !n.path.toLowerCase().includes(q)) continue;
        const li = document.createElement("li");
        li.role = "treeitem";
        const row = document.createElement("button");
        row.type = "button";
        row.className = `tree-row${n.path === current ? " current" : ""}`;
        row.style.paddingLeft = `${22 + depth * 14}px`;
        row.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6.5L15.5 6.5v10a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z"/><path d="M11 2.5V7h4.5"/></svg>';
        row.append(n.name.replace(/\.md$/, ""));
        if (n.mark) { const m = document.createElement("span"); m.className = `mark ${n.mark}`; m.textContent = n.mark; row.append(m); }
        row.title = n.path;
        row.addEventListener("click", async () => { await openDocument(n.path); renderTree(); });
        li.append(row);
        out.push(li);
      }
    }
    return out;
  };
  const items = walk(tree?.tree || [], 0);
  box.replaceChildren(...(items.length ? items : [Object.assign(document.createElement("li"), { className: "tree-note", textContent: q ? "No documents match." : "The repo is empty." })]));
}
$("tree-filter").addEventListener("input", renderTree);

/** Keep the conversation's attention on a document: open the chat beside it. */
function askAbout(path, text = null) {
  if (view !== "chat") setView("chat", { conversation: conv || undefined });
  if (text) { send(text); return; }
  input.value = input.value || "";
  input.placeholder = `Ask about ${path.split("/").pop().replace(/\.md$/, "")}, or say what to change`;
  input.focus();
}

// ---------------------------------------------------------------- gaps: what needs the person

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

function ghLink(it) {
  const gh = document.createElement("a");
  gh.className = "gh";
  gh.href = it.url;
  gh.title = "Open on GitHub";
  gh.setAttribute("aria-label", `Open #${it.number} on GitHub`);
  gh.innerHTML = ICON.github;
  return gh;
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
  li.append(ask, ghLink(it));
  return li;
}

/** One gap: what's missing in which document, and what the person can do about it here. */
function gapRow(g) {
  const li = document.createElement("li");
  li.className = `item gap${g.snoozed_until ? " snoozed" : ""}`;
  const what = document.createElement("div");
  what.className = "what";
  const b = document.createElement("b");
  b.textContent = g.concept_title;
  const small = document.createElement("small");
  small.textContent = [g.kind && `${g.kind[0].toUpperCase()}${g.kind.slice(1)}`, g.team && `${g.team} team`, `#${g.number}`, `opened ${ago(g.created)}`,
    g.snoozed_until && `snoozed until ${new Date(g.snoozed_until * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}`].filter(Boolean).join(" · ");
  what.append(b, small);
  if (g.detail) { const d = document.createElement("p"); d.className = "detail"; d.textContent = g.detail; what.append(d); }
  const work = document.createElement("button");
  work.type = "button";
  work.className = "button small primary";
  work.textContent = "Work on it";
  work.addEventListener("click", async () => {
    setView("chat", { fresh: true });
    if (g.concept) openDocument(g.concept, { review: false });
    send(`Help me resolve gap #${g.number}, "${g.title}"${g.concept ? ` in ${g.concept}` : ""}. What's missing, and what do you need from me?`);
  });
  const more = document.createElement("button");
  more.type = "button";
  more.className = "icon-button more";
  more.setAttribute("aria-label", `More for #${g.number}`);
  more.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle class="fill" cx="5" cy="10" r="1.3"/><circle class="fill" cx="10" cy="10" r="1.3"/><circle class="fill" cx="15" cy="10" r="1.3"/></svg>';
  more.addEventListener("click", () => gapMenu(g, li));
  li.append(what, work, more, ghLink(g));
  return li;
}

/** Comment, not applicable, snooze: inline, under the gap. */
function gapMenu(g, li) {
  const open = li.querySelector(".gap-actions");
  if (open) { open.remove(); return; }
  const box = document.createElement("div");
  box.className = "gap-actions";
  const text = document.createElement("textarea");
  text.rows = 2;
  text.placeholder = "A comment for the issue, or why this isn't a gap";
  const row = document.createElement("div");
  const act = (label, fn, cls = "button small") => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.addEventListener("click", fn); return b; };
  const done = async (p, msg) => {
    for (const x of row.querySelectorAll("button")) x.disabled = true;
    try { await p; toast(msg); loadLibrary(true); } catch (e) { toast(e.message); for (const x of row.querySelectorAll("button")) x.disabled = false; }
  };
  row.append(
    act("Comment", () => text.value.trim() ? done(api(`/api/gaps/${g.number}/comment`, json("POST", { text: text.value })), `Commented on #${g.number}`) : text.focus()),
    act("Not applicable", () => done(api(`/api/gaps/${g.number}/not-applicable`, json("POST", { reason: text.value })), `Closed #${g.number} as not applicable`)),
    g.snoozed_until
      ? act("Unsnooze", () => done(api(`/api/gaps/${g.number}/snooze`, json("POST", { days: 0 })), `#${g.number} is back`))
      : act("Snooze a week", () => done(api(`/api/gaps/${g.number}/snooze`, json("POST", { days: 7 })), `Snoozed #${g.number} for a week`)),
  );
  box.append(text, row);
  li.append(box);
  text.focus();
}

let gapScope = "mine";
let gapData = null;

async function loadLibrary(refresh = false) {
  const out = $("library-body");
  $("library-lede").textContent = "Checking the repo…";
  let d;
  let lib;
  try {
    [d, lib] = await Promise.all([api(`/api/gaps${refresh ? "?refresh=true" : ""}`), api("/api/library").catch(() => ({ pulls: [] }))]);
  } catch (e) {
    d = { error: e.message };
  }
  out.replaceChildren();
  bw.targets().then((t) => {
    if (!t?.current || t.current.ok || view !== "library") return;
    const b = document.createElement("p");
    b.className = "banner";
    b.textContent = `${t.current.message} `;
    const go = document.createElement("button");
    go.type = "button";
    go.className = "button small";
    go.textContent = "Choose another repo";
    go.addEventListener("click", () => setView("settings"));
    b.append(go);
    out.prepend(b);
  }).catch(() => {});
  if (d.error) {
    $("library-lede").textContent = "";
    $("gap-filter").hidden = true;
    const p = document.createElement("p");
    p.className = "problem";
    p.textContent = d.error;
    out.append(p);
    return;
  }
  gapData = { ...d, pulls: lib.pulls || [] };
  // The label choice lists every label on a gap.
  const sel = $("gap-label");
  const keep = sel.value;
  sel.replaceChildren(new Option("Any label", ""), ...d.labels.map((l) => new Option(l, l)));
  sel.value = d.labels.includes(keep) ? keep : "";
  renderGaps();
}

function renderGaps() {
  const d = gapData;
  if (!d) return;
  const out = $("library-body");
  out.querySelectorAll(":scope > :not(.banner)").forEach((n) => n.remove());
  $("gap-filter").hidden = false;
  const mine = d.mine_labels.length > 0;
  for (const b of document.querySelectorAll("[data-scope]")) b.setAttribute("aria-checked", String(b.dataset.scope === gapScope));
  const label = $("gap-label").value;
  const showSnoozed = $("gap-snoozed").checked;
  const shown = d.gaps.filter((g) => (gapScope === "all" || !mine || g.mine) && (!label || g.labels.includes(label)) && (showSnoozed || !g.snoozed_until));
  const lede = $("library-lede");
  lede.replaceChildren();
  if (gapScope === "mine" && !mine) {
    lede.append("Showing every gap. ");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = "Choose your labels";
    a.addEventListener("click", (e) => { e.preventDefault(); setView("settings"); setTimeout(() => $("gap-labels").scrollIntoView({ block: "center" }), 400); });
    lede.append(a, " to see only yours.");
  } else {
    lede.append(gapScope === "mine" ? `Gaps labelled ${d.mine_labels.join(", ")}. ` : "Every open gap. ",
      "Work on one and Bookwyrm opens the document and takes you through it.");
  }
  const hidden = d.gaps.length - shown.length;
  out.append(
    section("Gaps", shown, hidden ? `Nothing here. ${hidden} other gap${hidden > 1 ? "s are" : " is"} hidden by the filter.` : "No open gaps.", gapRow),
    section("In quarantine", d.quarantine, "Nothing in quarantine.", (it) => itemRow({ ...it, title: it.title.replace(/^Quarantined:\s*/, "") },
      `#${it.number}, quarantined ${ago(it.created)}`,
      `Let's sort out the quarantined draft ${it.title.replace(/^Quarantined:\s*/, "")} (issue #${it.number}). Why is it there, and what are my options?`)),
    section("Pull requests", d.pulls, "No open pull requests.", (it) => itemRow(it, `#${it.number}, ${it.branch}`,
      `Walk me through pull request #${it.number}, "${it.title}". What does it change, and is it ready to merge?`, it.by)),
  );
  setLibraryCount(d.gaps.filter((g) => (!mine || g.mine) && !g.snoozed_until).length);
}

for (const b of document.querySelectorAll("[data-scope]")) b.addEventListener("click", () => { gapScope = b.dataset.scope; renderGaps(); });
$("gap-label").addEventListener("change", renderGaps);
$("gap-snoozed").addEventListener("change", renderGaps);

function setLibraryCount(n) {
  $("library-count").textContent = String(n);
  $("library-count").hidden = !n;
}
$("refresh-library").addEventListener("click", () => loadLibrary(true));

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
  loadTargets();
  form.voice_speed.value = settings.voice_speed;
  form.calls_you.checked = settings.calls_you;
  form.watch_minutes.value = String(Math.round(settings.watch_minutes));
  if (!form.watch_minutes.value) form.watch_minutes.value = "5";
  form.sync_minutes.value = String(Math.round(settings.sync_minutes || 3));
  if (!form.sync_minutes.value) form.sync_minutes.value = "3";
  loadGapLabels();
  $("repo-apply").hidden = true;
  keyStatus("github-status", settings.keys.github);
  keyStatus("anthropic-status", settings.keys.anthropic);
  keyStatus("gateway-status", settings.keys.gateway);
  form.provider.value = settings.model.provider;
  form.gateway_url.value = settings.model.base_url || "";
  form.gateway_model.value = settings.model.name || "";
  showModelRows();
  $("login-item").checked = await bw.loginItem();
  $("show-robot").checked = await bw.companionVisible();
  const info = await bw.appInfo();
  $("app-paths").textContent = `Settings: ${settings.paths.settings}. Voice service log: ${info.log}.`;
  await loadVoices();
  healthLine();
}

// Kokoro and the natural voice (Chatterbox) each have their own voices; /api/voices says which
// settings key the current engine's choice is saved under.
let voiceSetting = "voice";
let voicesRetry = null;

async function loadVoices() {
  const v = await api("/api/voices").catch(() => ({ voices: [], engines: [] }));
  voiceSetting = v.setting || "voice";
  const sel = $("voice");
  const current = v.current || settings[voiceSetting];
  sel.replaceChildren(...(v.voices.length ? v.voices : [{ id: current, label: current, detail: "loading voices" }]).map((x) => {
    const o = document.createElement("option");
    o.value = x.id;
    o.textContent = `${x.label} (${x.detail})`;
    return o;
  }));
  sel.value = current;

  const eng = $("voice-engine");
  const engines = v.engines || [];
  // Best first, as the service lists them; ones this computer can't use are shown, greyed, with why.
  eng.replaceChildren(...engines.map((e) => {
    const o = document.createElement("option");
    o.value = e.id;
    o.textContent = e.ready ? e.label : `${e.label} (unavailable)`;
    o.title = e.reason;
    o.disabled = !e.ready && e.id !== settings.voice_engine;
    return o;
  }));
  eng.value = settings.voice_engine || "kokoro";
  const s = v.engine || {};
  const best = engines.find((e) => e.ready);
  $("engine-note").textContent = v.loading ? "Loading the voice…"
    : s.note ? `Using Standard for now: ${s.note}`
    : best && best.id !== "kokoro" && eng.value === "kokoro" ? `${best.label.replace(/ \(.*/, "")} is available on this computer` : "";
  form.voice_speed.disabled = s.speed_control === false;
  $("voice-hint").textContent = s.speed_control === false
    ? `Natural voices speak at their own pace. To use your own voice, put a 5 to 15 second recording (.wav, .flac or .mp3) in ${v.voices_dir || "the voices folder"} and reopen Settings.`
    : "Natural voices sound like a person on the phone but need a recent computer; Standard runs anywhere. Setup picks the best one this computer can run.";
  clearTimeout(voicesRetry);
  if (v.loading) voicesRetry = setTimeout(loadVoices, 3000);
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
form.voice.addEventListener("change", () => save({ [voiceSetting]: form.voice.value }));
form.voice_engine.addEventListener("change", async () => {
  await save({ voice_engine: form.voice_engine.value });
  $("engine-note").textContent = "Loading the voice…";
  setTimeout(loadVoices, 1500);
});
form.voice_speed.addEventListener("change", () => save({ voice_speed: Number(form.voice_speed.value) }));
form.calls_you.addEventListener("change", () => save({ calls_you: form.calls_you.checked }));
form.watch_minutes.addEventListener("change", () => save({ watch_minutes: Number(form.watch_minutes.value) }));
form.sync_minutes.addEventListener("change", () => save({ sync_minutes: Number(form.sync_minutes.value) }));

/** "My gaps": toggles for the labels on the repo's gap issues (plus any chosen before). */
async function loadGapLabels() {
  const box = $("gap-labels");
  let labels = [];
  try { labels = (await api("/api/gaps")).labels; } catch (e) { box.replaceChildren(Object.assign(document.createElement("small"), { textContent: `Couldn't read the repo's labels: ${e.message}` })); return; }
  const chosen = new Set(settings.gap_labels || []);
  const all = [...new Set([...chosen, ...labels])];
  if (!all.length) { box.replaceChildren(Object.assign(document.createElement("small"), { textContent: "No gaps have labels yet." })); return; }
  box.replaceChildren(...all.map((l) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pick";
    b.textContent = l;
    b.setAttribute("aria-pressed", String(chosen.has(l)));
    b.addEventListener("click", async () => {
      if (chosen.has(l)) chosen.delete(l); else chosen.add(l);
      b.setAttribute("aria-pressed", String(chosen.has(l)));
      await save({ gap_labels: [...chosen] });
      refreshBadge();
    });
    return b;
  }));
}
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

// ---- how Bookwyrm reaches Claude

function modelDraft() {
  return {
    provider: form.provider.value,
    gatewayUrl: form.gateway_url.value.trim().replace(/\/+$/, ""),
    gatewayModel: form.gateway_model.value.trim(),
  };
}

function modelChanged() {
  if (!settings) return false;
  const d = modelDraft();
  const m = settings.model;
  if (d.provider !== m.provider) return true;
  return d.provider === "gateway" && (d.gatewayUrl !== (m.base_url || "") || d.gatewayModel !== (m.name || ""));
}

function showModelRows() {
  const p = form.provider.value;
  for (const el of form.querySelectorAll("[data-for]")) el.hidden = el.dataset.for !== p;
  for (const el of form.querySelectorAll("[data-entry=gatewayKey], [data-entry=anthropicKey]")) {
    if ((el.dataset.entry === "gatewayKey") !== (p === "gateway")) el.hidden = true;
  }
  $("model-apply-row").hidden = !modelChanged();
}

for (const name of ["provider", "gateway_url", "gateway_model"]) {
  form[name].addEventListener("input", showModelRows);
  form[name].addEventListener("change", showModelRows);
}

$("model-apply").addEventListener("click", () => applyModel());

function applyModel(newKey = null) {
  const d = modelDraft();
  const keyField = d.provider === "gateway" ? "gatewayKey" : "anthropicKey";
  const entry = form.querySelector(`[data-entry="${keyField}"]`);
  const typed = newKey ?? entry.querySelector("input").value.trim();
  if (d.provider === "gateway") {
    if (!/^https?:\/\/\S+$/.test(d.gatewayUrl)) { saved("The gateway address should start with https://."); form.gateway_url.focus(); return; }
    if (!d.gatewayModel) { saved("Type the model name the gateway uses for Claude."); form.gateway_model.focus(); return; }
  }
  const haveKey = d.provider === "gateway" ? settings.keys.gateway : settings.keys.anthropic;
  if (!typed && !haveKey) {
    entry.hidden = false;
    entry.querySelector("input").focus();
    saved(d.provider === "gateway" ? "Enter the gateway key, then Save." : "Enter your Anthropic API key, then Save.");
    return;
  }
  entry.querySelector("input").value = "";
  entry.hidden = true;
  applySetup({ ...d, ...(typed ? { [keyField]: typed } : {}) },
    d.provider === "gateway" ? `Connecting Bookwyrm to ${d.gatewayUrl} as "${d.gatewayModel}"…` : "Connecting Bookwyrm to Anthropic directly…");
}

// ---- which knowledge repo: active targets from the Archivist registry

const ACCESS_NOTE = { none: "token can't reach it", read: "read-only for your token" };
let targets = null;
let registryDraft = null;   // a registry typed in Settings, not saved until a repo from it is chosen

async function loadTargets() {
  const sel = $("repo");
  const note = $("repo-note");
  sel.disabled = true;
  sel.replaceChildren(new Option("Reading the Archivist registry…", ""));
  targets = await bw.targets({ showTest: $("show-test").checked, ...(registryDraft ? { registry: registryDraft } : {}) });
  $("registry-current").textContent = registryDraft ? `${registryDraft} (not saved yet)` : (targets.registry || "");
  $("registry-current").className = "key-status ok";
  sel.replaceChildren();
  note.hidden = true;
  if (targets.error && registryDraft) {
    // The registry just typed can't be read: say why, and go back to the saved one.
    note.textContent = targets.error;
    note.hidden = false;
    registryDraft = null;
    $("registry-entry").hidden = false;
    const keep = note.textContent;
    await loadTargets();
    note.textContent = keep;
    note.hidden = false;
    return;
  }
  if (targets.error) {
    // Can't read the registry: keep showing the saved repo; switching waits until it can be checked.
    if (settings?.repo) sel.append(new Option(settings.repo, settings.repo));
    note.textContent = `${targets.error} You can keep using ${settings?.repo || "your repo"}; switching needs the registry.`;
    note.hidden = false;
    $("repo-source").textContent = "Archivist registry unavailable";
    $("repo-apply").hidden = true;
    return;
  }
  $("repo-source").textContent = `From the Archivist registry (${targets.source})`;
  for (const t of targets.targets) {
    const label = `${t.name} (${t.repo})${t.type === "test" ? ", test" : ""}${ACCESS_NOTE[t.access] ? `: ${ACCESS_NOTE[t.access]}` : ""}`;
    const o = new Option(label, t.repo);
    o.disabled = t.access === "none" || t.access === "read";
    sel.append(o);
  }
  if (registryDraft) {
    // A new registry: nothing is chosen until the person picks one of its repos.
    sel.prepend(new Option(targets.targets.length ? "Choose a repo from this registry…" : "No active repos in this registry", ""));
    sel.value = "";
  } else {
    if (settings?.repo && !targets.targets.some((t) => t.repo === settings.repo)) {
      sel.append(new Option(`${settings.repo} (not an active target)`, settings.repo));
    }
    sel.value = settings?.repo || "";
  }
  sel.disabled = false;
  $("show-test-row").hidden = !(targets.hiddenTest || $("show-test").checked);
  if (targets.current && !targets.current.ok) { note.textContent = targets.current.message; note.hidden = false; }
  $("repo-apply").hidden = true;
}

form.repo.addEventListener("change", () => {
  $("repo-apply").hidden = !form.repo.value || (form.repo.value === settings?.repo && !registryDraft);
});
$("show-test").addEventListener("change", loadTargets);
$("repo-apply").addEventListener("click", () => {
  const repo = form.repo.value;
  const t = targets?.targets?.find((x) => x.repo === repo);
  const registry = registryDraft;
  registryDraft = null;
  applySetup({ repo, ...(registry ? { registry } : {}) },
    `Switching Bookwyrm to ${t ? t.name : repo}${registry ? `, from the registry in ${registry}` : ""}…`);
});
$("registry-change").addEventListener("click", () => {
  const entry = $("registry-entry");
  entry.hidden = !entry.hidden;
  $("registry-input").value = registryDraft || targets?.registry || "";
  $("registry-input").focus();
});
async function loadRegistryDraft() {
  const value = $("registry-input").value.trim();
  if (!value || value === targets?.registry) { $("registry-entry").hidden = true; return; }
  registryDraft = value;
  $("registry-entry").hidden = true;
  await loadTargets();
  if (registryDraft) saved(`Read ${registryDraft}. Choose a repo from it, then Switch.`);
}
$("registry-load").addEventListener("click", loadRegistryDraft);
$("registry-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); loadRegistryDraft(); } });
for (const row of form.querySelectorAll("[data-key]")) {
  const entry = form.querySelector(`[data-entry="${row.dataset.key}"]`);
  row.querySelector(".replace").addEventListener("click", () => { entry.hidden = !entry.hidden; entry.querySelector("input").focus(); });
  entry.querySelector(".save-key").addEventListener("click", () => {
    const value = entry.querySelector("input").value.trim();
    if (!value) return;
    // A model key goes with the model settings on screen, so the two are checked together.
    if (row.dataset.key !== "githubToken") { applyModel(value); return; }
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

// ---------------------------------------------------------------- live: sync status, edits, publishes

let toastTimer = null;
function toast(text, link = null) {
  const t = $("toast");
  t.replaceChildren(text);
  if (link) {
    const a = document.createElement("a");
    a.href = link.url;
    a.textContent = link.label;
    t.append(" ", a);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 7000);
}

function syncPill(st) {
  const pill = $("sync");
  if (!st || st.error && !st.ready) {
    pill.dataset.state = "off";
    $("sync-label").textContent = st?.error ? "Can't reach GitHub" : "Not set up";
    pill.title = st?.error || "Choose a knowledge repo in Settings.";
    return;
  }
  pill.dataset.state = st.syncing ? "syncing" : st.error ? "off" : "ok";
  const mins = st.synced_at ? Math.floor((Date.now() / 1000 - Math.max(st.synced_at, st.checked_at || 0)) / 60) : null;
  $("sync-label").textContent = st.syncing ? "Syncing…" : st.error ? "Offline" : mins === null ? "Not synced" : mins < 1 ? "Up to date" : `Synced ${mins} min ago`;
  pill.title = st.error ? `${st.error} Showing the copy from ${new Date(st.synced_at * 1000).toLocaleString()}.`
    : `${st.repo} at ${String(st.sha || "").slice(0, 7)}. Bookwyrm keeps a copy on this computer and checks GitHub every few minutes. Click to check now.`;
}
let lastStatus = null;
async function refreshStatus() {
  try { lastStatus = await api("/api/ws/status"); } catch { lastStatus = null; }
  syncPill(lastStatus);
}
$("sync").addEventListener("click", async () => {
  syncPill({ ...(lastStatus || {}), syncing: true, ready: true });
  try { lastStatus = { ...(await api("/api/ws/sync", { method: "POST" })) }; } catch (e) { toast(e.message); }
  refreshStatus();
  if (view === "knowledge") loadTree();
});

/** "3 edits to review": Bookwyrm's unpublished edits, from any conversation. */
async function refreshChanges() {
  let changes = [];
  try { changes = await api("/api/ws/changes"); } catch {}
  const waiting = changes.flatMap((c) => c.files.filter((f) => f.status === "pending" || f.status === "conflict").map((f) => ({ change: c.id, path: f.path })));
  const chip = $("review-chip");
  chip.hidden = !waiting.length;
  chip.textContent = `${waiting.length} edit${waiting.length === 1 ? "" : "s"} to review`;
  chip.onclick = () => {
    if (view !== "chat" && view !== "knowledge") setView("chat", { conversation: conv || undefined });
    showPreview(waiting[0].change, waiting[0].path);
  };
  if (view === "knowledge" && tree) loadTree();
}

function refreshBadge() {
  api("/api/gaps/count").then((d) => setLibraryCount(d.count)).catch(() => {});
}

function listen() {
  const es = new EventSource(`${voiceUrl}/api/ws/events`);
  es.onmessage = () => {};
  const on = (type, fn) => es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch {} });
  on("change", (ev) => {
    if (handleEvent(ev) && view !== "chat" && view !== "knowledge") setView("chat", { conversation: conv || undefined });
    refreshChanges();
  });
  for (const type of ["review", "conflict", "upstream"]) on(type, (ev) => { handleEvent(ev); refreshChanges(); });
  on("show", (ev) => { if (handleEvent(ev) && view !== "chat" && view !== "knowledge") setView("chat", { conversation: conv || undefined }); });
  on("sync", (ev) => { if ("ready" in ev) { lastStatus = ev; syncPill(ev); } else syncPill({ ...(lastStatus || {}), syncing: true }); });
  on("synced", (ev) => { handleEvent(ev); if (view === "knowledge") loadTree(); });
  on("published", async (ev) => {
    refreshChanges();
    refreshBadge();
    if (conv === ev.change) { await loadHistory(); if (view === "chat") openConversation(conv); }
  });
  es.onerror = () => { syncPill(null); };
  es.onopen = () => refreshStatus();
}

// ---------------------------------------------------------------- start

$("nav-new").addEventListener("click", () => setView("chat", { fresh: true }));
$("nav-knowledge").addEventListener("click", () => setView("knowledge"));
$("nav-library").addEventListener("click", () => setView("library"));
$("nav-settings").addEventListener("click", () => setView("settings"));
bw.onShow((opts) => route(opts));

(async () => {
  await applyOs();
  voiceUrl = await bw.voiceUrl();
  initDoc({ api, json, toast, onAsk: askAbout, onChanges: refreshChanges, voiceUrl: () => voiceUrl });
  // Show the page asked for straight away; the greeting and history fill in as the service answers
  // (on a slow or cold machine that can take a few seconds).
  route(Object.fromEntries(new URLSearchParams(location.search)));
  api("/api/settings").then((s) => {
    const first = s.name.split(" ")[0];
    if (first) $("empty-greeting").textContent = `What do you need, ${first}?`;
    if (s.repo) $("empty-repo").textContent = `Ask about ${s.repo}, or tell Bookwyrm something it should know.`;
  }).catch(() => {});
  await loadHistory();
  if (view === "chat" && conv) $("view-title").textContent = titleOf(conv);
  refreshBadge();
  refreshStatus();
  refreshChanges();
  listen();
  setInterval(refreshStatus, 60_000);
  setInterval(refreshBadge, 5 * 60_000);
})();
