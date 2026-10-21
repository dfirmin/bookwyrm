// The document pane: a knowledge document rendered (never raw Markdown); Bookwyrm's edits to it,
// highlighted, to approve or discard one at a time; or the editor, for the person's own changes.
// ADR 0008.
import { Crepe } from "@milkdown/crepe";
// The editor's own styles, minus the features left off (maths, images, AI) and their fonts.
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/common/top-bar.css";
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import DOMPurify from "dompurify";
import { marked } from "marked";

const $ = (id) => document.getElementById(id);
let ctx = null;          // { api, json, toast, onAsk, onChanges, voiceUrl }

// What the pane shows.
//   mode "view":    a document from the repo
//   mode "preview": one file of a change, before → after, with the review bar
//   mode "edit":    the editor
const st = { path: null, mode: null, change: null, file: null, summary: null, text: null, crepe: null,
  editBase: null, editNormal: null, sha: null, stale: false };

// ---------------------------------------------------------------- Markdown

marked.use({ gfm: true, breaks: false });
const md = (text) => DOMPurify.sanitize(marked.parse(text || ""));

/** {raw: the frontmatter block as written (with its blank lines), fields: [[key, text]], body}. */
export function splitFrontmatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?\n?(\s*)/m.exec(text || "");
  if (!m || m.index !== 0) return { raw: "", fields: [], body: text || "" };
  const fields = [];
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (k) fields.push([k[1], k[2]]);
    else if (fields.length && line.trim()) fields[fields.length - 1][1] += `${fields[fields.length - 1][1] ? "\n" : ""}${line.trim()}`;
  }
  return { raw: m[0], fields, body: text.slice(m[0].length) };
}

function blocks(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  return [...t.content.children];
}
const key = (el) => el.outerHTML.replace(/\s+/g, " ").trim();

/** The longest common subsequence of two lists of keys, as aligned steps. */
function align(a, b) {
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(["same", i++, j++]); continue; }
    if (L[i + 1][j] >= L[i][j + 1]) out.push(["del", i++, null]);
    else out.push(["add", null, j++]);
  }
  while (i < n) out.push(["del", i++, null]);
  while (j < m) out.push(["add", null, j++]);
  return out;
}

// Containers whose children are compared one by one (a list item, a table row), so a one-word
// change in a long list marks that item, not the whole list.
const CONTAINERS = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TR", "BLOCKQUOTE"]);

/** Word-level changes inside one block: the new block, with inserted words in <ins> and removed
 *  ones in <del>, placed where they were. */
function wordDiff(oldEl, newEl) {
  const split = (t) => t.split(/(\s+)/).filter(Boolean);
  const a = split(oldEl.textContent);
  const b = split(newEl.textContent);
  if (a.length * b.length > 400_000) return null;
  const segs = [];      // [kind, text] in the new text's order; del segments take no room in it
  for (const [op, i, j] of align(a, b)) {
    const kind = op === "same" ? "same" : op === "add" ? "ins" : "del";
    const text = op === "del" ? a[i] : b[j];
    const last = segs[segs.length - 1];
    if (last && last[0] === kind) last[1] += text; else segs.push([kind, text]);
  }
  const out = newEl.cloneNode(true);
  const walker = document.createTreeWalker(out, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let si = 0;
  let used = 0;          // characters of segs[si] already placed
  for (const node of nodes) {
    let text = node.nodeValue;
    const frag = document.createDocumentFragment();
    while (si < segs.length && (text.length || segs[si][0] === "del")) {
      const [kind, seg] = segs[si];
      if (kind === "del") {
        if (seg.trim()) { const d = document.createElement("del"); d.textContent = seg; frag.append(d); }
        si++;
        continue;
      }
      const take = Math.min(text.length, seg.length - used);
      const piece = text.slice(0, take);
      if (kind === "ins" && piece.trim()) { const i = document.createElement("ins"); i.textContent = piece; frag.append(i); }
      else frag.append(piece);
      text = text.slice(take);
      used += take;
      if (used >= seg.length) { si++; used = 0; }
    }
    if (text) frag.append(text);
    node.replaceWith(frag);
  }
  // Anything removed at the very end.
  for (; si < segs.length; si++) {
    if (segs[si][0] === "del" && segs[si][1].trim()) { const d = document.createElement("del"); d.textContent = segs[si][1]; out.append(d); }
  }
  return out;
}

function mark(el, kind) {
  if (el.tagName === "LI" || el.tagName === "TR") { el.classList.add(`chg-${kind}`); return el; }
  const wrap = document.createElement("div");
  wrap.className = `chg ${kind}`;
  wrap.append(el);
  return wrap;
}

/** Compare two lists of sibling elements; append the merged result to ``into``. Returns the count
 *  of changed places. */
function diffInto(into, a, b) {
  let changes = 0;
  const steps = align(a.map(key), b.map(key));
  for (let k = 0; k < steps.length; k++) {
    const [op, i, j] = steps[k];
    if (op === "same") { into.append(b[j]); continue; }
    changes++;
    // A removed block followed by an added one of the same kind is one block, changed.
    const next = steps[k + 1];
    if (op === "del" && next && next[0] === "add" && a[i].tagName === b[next[2]].tagName) {
      const oldEl = a[i];
      const newEl = b[next[2]];
      k++;
      if (CONTAINERS.has(newEl.tagName)) {
        const shell = newEl.cloneNode(false);
        changes += diffInto(shell, [...oldEl.children], [...newEl.children]) - 1;
        into.append(shell);
        continue;
      }
      const w = wordDiff(oldEl, newEl);
      if (w) { into.append(mark(w, "edit")); continue; }
      into.append(mark(oldEl, "del"), mark(newEl, "add"));
      continue;
    }
    into.append(mark(op === "add" ? b[j] : a[i], op === "add" ? "add" : "del"));
  }
  return changes;
}

/** The new version rendered, with what changed marked: words inserted and removed inside a
 *  block, whole blocks added (green) or removed (struck). */
export function renderDiff(beforeBody, afterBody) {
  const frag = document.createDocumentFragment();
  const holder = document.createElement("div");
  const changes = diffInto(holder, blocks(md(beforeBody)), blocks(md(afterBody)));
  frag.append(...holder.childNodes);
  return { frag, changes };
}

function renderProps(fields, beforeFields = null) {
  const table = $("doc-props-table");
  table.replaceChildren();
  const before = beforeFields ? new Map(beforeFields) : null;
  let changed = 0;
  for (const [k, v] of fields) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = k;
    const td = document.createElement("td");
    td.textContent = v;
    if (before && before.get(k) !== v) { tr.className = "chg-row"; changed++; }
    tr.append(th, td);
    table.append(tr);
  }
  if (before) {
    const now = new Set(fields.map(([k]) => k));
    for (const [k, v] of beforeFields) {
      if (now.has(k)) continue;
      const tr = document.createElement("tr");
      tr.className = "del-row";
      tr.innerHTML = "<th></th><td></td>";
      tr.firstChild.textContent = k;
      tr.lastChild.textContent = v;
      table.append(tr);
      changed++;
    }
  }
  $("doc-props").hidden = !fields.length && !changed;
  $("doc-props").open = changed > 0;
  return changed;
}

// ---------------------------------------------------------------- the pane

const titleFrom = (path, fields) => fields.find(([k]) => k === "title")?.[1]?.replace(/^["']|["']$/g, "") || path.split("/").pop().replace(/\.md$/, "");

function head(path, fields) {
  $("doc-path").textContent = path.split("/").slice(0, -1).join(" › ");
  $("doc-title").textContent = titleFrom(path, fields);
}

function actions(...buttons) {
  $("doc-actions").replaceChildren(...buttons);
}

function button(label, onClick, cls = "button small") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function notice(text, kind = "", action = null) {
  const n = $("doc-notice");
  if (!text) { n.hidden = true; return; }
  n.className = `notice ${kind}`;
  n.replaceChildren(text);
  if (action) n.append(" ", action);
  n.hidden = false;
}

function setOpen(on) {
  $("doc").hidden = !on;
  document.body.classList.toggle("doc-open", on);
}

export const isEditing = () => st.mode === "edit";
export const openPath = () => (st.mode ? st.path : null);

/** What the conversation should tell Bookwyrm about what the person is looking at. */
export function docContext() {
  if (!st.mode || $("doc").hidden) return {};
  return st.mode === "preview" ? { open_document: st.path, preview: st.path } : { open_document: st.path };
}

export function initDoc(context) {
  ctx = context;
  // For the app's own tests: what the editor would save.
  window.bookwyrmEditor = { markdown: () => (st.crepe ? st.fmRaw + st.crepe.getMarkdown() : null), original: () => st.editBase };
  $("doc-close").addEventListener("click", () => closeDoc());
  $("review-approve").addEventListener("click", () => review("approved"));
  $("review-discard").addEventListener("click", () => review("rejected"));
  $("review-all").addEventListener("click", () => review("approved", true));
  $("review-prev").addEventListener("click", () => step(-1));
  $("review-next").addEventListener("click", () => step(1));
}

export async function closeDoc(force = false) {
  if (st.mode === "edit" && !force && !(await leaveEditor())) return false;
  destroyEditor();
  Object.assign(st, { path: null, mode: null, change: null, file: null, summary: null });
  setOpen(false);
  return true;
}

/** Open a document from the repo. If one of the person's conversations has an unpublished edit to
 *  it, show that edit for review instead. */
export async function openDocument(path, { review = true } = {}) {
  if (st.mode === "edit" && st.path !== path && !(await leaveEditor())) return;
  if (review) {
    const pending = (await ctx.api("/api/ws/changes").catch(() => []))
      .find((c) => c.files.some((f) => f.path === path && f.status !== "rejected"));
    if (pending) return showPreview(pending.id, path);
  }
  destroyEditor();
  let f;
  try {
    f = await ctx.api(`/api/ws/file?path=${encodeURIComponent(path)}`);
  } catch (e) {
    ctx.toast(e.message);
    return;
  }
  Object.assign(st, { path: f.path, mode: "view", change: null, file: null, text: f.content, sha: f.sha, stale: false });
  const { fields, body } = splitFrontmatter(f.content);
  head(f.path, fields);
  renderProps(fields);
  $("review-bar").hidden = true;
  notice("");
  $("doc-editor").hidden = true;
  $("doc-body").hidden = false;
  $("doc-body").innerHTML = md(body);
  $("doc-scroller").scrollTop = 0;
  actions(
    button("Ask Bookwyrm", () => ctx.onAsk(f.path)),
    button("Edit", () => startEdit()),
  );
  setOpen(true);
}

// ---------------------------------------------------------------- reviewing Bookwyrm's edits

/** Show one file of a change, before → after, with the review bar. */
export async function showPreview(change, path = null) {
  if (st.mode === "edit" && !(await leaveEditor())) return;
  destroyEditor();
  let summary;
  try {
    summary = await ctx.api(`/api/ws/changes/${encodeURIComponent(change)}`);
  } catch (e) {
    ctx.toast(e.message);
    return;
  }
  if (!summary.files.length) {
    if (st.change === change) { if (st.path) openDocument(st.path, { review: false }); else closeDoc(); }
    return;
  }
  const target = path && summary.files.some((f) => f.path === path) ? path
    : (summary.files.find((f) => f.status === "pending" || f.status === "conflict") || summary.files[0]).path;
  let file;
  try {
    file = await ctx.api(`/api/ws/changes/${encodeURIComponent(change)}/file?path=${encodeURIComponent(target)}`);
  } catch (e) {
    ctx.toast(e.message);
    return;
  }
  const keepScroll = st.mode === "preview" && st.change === change && st.path === target;
  const scroll = $("doc-scroller").scrollTop;
  Object.assign(st, { path: target, mode: "preview", change, file, summary });

  const before = splitFrontmatter(file.before ?? "");
  const after = splitFrontmatter(file.after ?? "");
  head(target, after.fields.length ? after.fields : before.fields);
  $("doc-editor").hidden = true;
  $("doc-body").hidden = false;
  const body = $("doc-body");
  if (file.op === "delete") {
    renderProps(before.fields);
    body.innerHTML = md(before.body);
    body.classList.add("deleting");
  } else {
    body.classList.remove("deleting");
    const propsChanged = renderProps(after.fields, file.before == null ? null : before.fields);
    if (file.before == null) {
      body.innerHTML = md(after.body);
    } else {
      const { frag, changes } = renderDiff(before.body, after.body);
      body.replaceChildren(frag);
      if (!changes && !propsChanged) body.prepend(Object.assign(document.createElement("p"), { className: "quiet", textContent: "No visible change (whitespace or formatting only)." }));
    }
  }
  $("doc-scroller").scrollTop = keepScroll ? scroll : 0;
  if (!keepScroll) body.querySelector(".chg, .chg-add, .chg-del, .chg-edit, ins, del")?.scrollIntoView({ block: "center" });

  // The review bar: where we are in the change, and what to do with this file.
  const files = summary.files;
  const idx = files.findIndex((f) => f.path === target);
  $("review-count").textContent = files.length > 1 ? `${idx + 1} of ${files.length}` : "";
  $("review-prev").hidden = $("review-next").hidden = files.length < 2;
  const what = file.op === "delete" ? "Bookwyrm wants to delete this" : file.before == null ? "New document from Bookwyrm" : "Bookwyrm's edit";
  const statusWord = { approved: "Approved", rejected: "Discarded", conflict: "Needs redoing", pending: "" }[file.status];
  $("review-what").textContent = statusWord ? `${what} · ${statusWord}` : what;
  $("review-approve").hidden = file.status !== "pending";
  $("review-discard").hidden = file.status !== "pending" && file.status !== "conflict";
  const waiting = files.filter((f) => f.status === "pending").length;
  $("review-all").hidden = waiting < 2;
  $("review-all").textContent = `Approve all ${waiting}`;
  $("review-bar").hidden = false;

  if (file.status === "conflict") {
    notice("Someone changed this on GitHub in the same place since Bookwyrm edited it. Ask Bookwyrm to redo the edit on the latest version, or discard it.", "warn");
  } else if (file.upstream_changed) {
    notice("This changed on GitHub since Bookwyrm edited it. Both changes will be kept when you approve.", "info");
  } else if (file.status === "approved" || file.status === "rejected") {
    notice(`${file.status === "approved" ? "Approved" : "Discarded"}. It goes out with the rest when nothing is left to look at.`, "info",
      button("Undo", () => review("pending"), "link"));
  } else {
    notice("");
  }
  actions(button("Ask Bookwyrm", () => ctx.onAsk(target)));
  setOpen(true);
}

function step(dir) {
  if (!st.summary) return;
  const files = st.summary.files;
  const i = files.findIndex((f) => f.path === st.path);
  showPreview(st.change, files[(i + dir + files.length) % files.length].path);
}

async function review(status, all = false) {
  const change = st.change;
  const path = st.path;
  for (const id of ["review-approve", "review-discard", "review-all"]) $(id).disabled = true;
  try {
    const r = await ctx.api(`/api/ws/changes/${encodeURIComponent(change)}/review`, ctx.json("POST", { status, ...(all ? {} : { path }) }));
    if (r.published) {
      published(r.published, path);
    } else {
      const next = r.summary.files.find((f) => f.status === "pending" || f.status === "conflict");
      if (next) await showPreview(change, next.path);
      else if (r.summary.files.length) await showPreview(change, path);
      else await openDocument(path, { review: false }).catch(() => closeDoc(true));
    }
  } catch (e) {
    ctx.toast(e.message);
  } finally {
    for (const id of ["review-approve", "review-discard", "review-all"]) $(id).disabled = false;
    ctx.onChanges();
  }
}

function published(r, path) {
  if (!r.ok) {
    ctx.toast(r.message);
    showPreview(st.change, path);
    return;
  }
  const link = { label: `#${r.pr}`, url: r.url };
  ctx.toast(r.merged ? `Published and merged: ${r.title}` : `Pull request opened: ${r.message}`, link);
  // Show what's on GitHub now (the copy has just synced).
  setTimeout(() => openDocument(path, { review: false }).catch(() => {}), 300);
}

// ---------------------------------------------------------------- the person's own edits

let pendingNormal = null;

async function startEdit() {
  if (st.mode !== "view") return;
  const { raw, body } = splitFrontmatter(st.text);
  $("doc-body").hidden = true;
  const host = $("doc-editor");
  host.replaceChildren();
  host.hidden = false;
  notice("");
  const crepe = new Crepe({
    root: host,
    defaultValue: body,
    features: { [Crepe.Feature.Latex]: false, [Crepe.Feature.ImageBlock]: false, [Crepe.Feature.AI]: false, [Crepe.Feature.TopBar]: true },
    featureConfigs: { [Crepe.Feature.Placeholder]: { text: "Write here…" } },
  });
  // Write Markdown the way Archivist does, so unchanged parts don't move.
  crepe.editor.config((c) => c.update(remarkStringifyOptionsCtx, (o) => ({
    ...o, bullet: "-", emphasis: "*", strong: "*", rule: "-", fences: true, listItemIndent: "one", tablePipeAlign: false,
  })));
  await crepe.create();
  pendingNormal = crepe.getMarkdown();
  Object.assign(st, { mode: "edit", crepe, editBase: st.text, editNormal: raw + pendingNormal, fmRaw: raw });
  actions(button("Cancel", () => cancelEdit()), button("Save", () => saveEdit(), "button small primary"));
  host.querySelector(".ProseMirror")?.focus();
}

function destroyEditor() {
  if (st.crepe) { try { st.crepe.destroy(); } catch {} }
  st.crepe = null;
  $("doc-editor").hidden = true;
  $("doc-editor").replaceChildren();
}

const editedText = () => st.fmRaw + st.crepe.getMarkdown();
const dirty = () => st.mode === "edit" && st.crepe && editedText() !== st.editNormal;

async function leaveEditor() {
  if (!dirty()) return true;
  return confirm("You have unsaved changes to this document. Discard them?");
}

async function cancelEdit() {
  if (!(await leaveEditor())) return;
  const path = st.path;
  destroyEditor();
  st.mode = "view";
  openDocument(path, { review: false });
}

async function saveEdit() {
  if (!dirty()) { cancelEdit(); return; }
  const path = st.path;
  const content = editedText();
  const before = st.editBase;
  const save = [...$("doc-actions").children];
  for (const b of save) b.disabled = true;
  notice("Publishing your edit…", "info");
  let r;
  try {
    r = await ctx.api("/api/ws/edit", ctx.json("POST", { path, content, base: before, normalized_base: st.editNormal }));
  } catch (e) {
    notice(`Couldn't publish: ${e.message}`, "warn");
    for (const b of save) b.disabled = false;
    return;
  }
  if (!r.ok) {
    notice(r.message, "warn");
    for (const b of save) b.disabled = false;
    return;
  }
  destroyEditor();
  st.mode = "view";
  ctx.toast(r.merged ? `Saved and merged: ${r.title}` : `Saved as a pull request: ${r.message}`, { label: `#${r.pr}`, url: r.url });
  await openDocument(path, { review: false });
  ctx.onChanges();
  thoughts(path, before, content, r.url);
}

/** Bookwyrm reads the person's edit against the contracts and says whether anything is worth a
 *  second look. Advice only; the edit is already merged. */
async function thoughts(path, before, after, url) {
  const box = $("doc-notes");
  box.hidden = false;
  box.innerHTML = '<b>Bookwyrm</b><div class="said"><span class="working">Reading your edit</span></div>';
  const said = box.querySelector(".said");
  let text = "";
  try {
    const r = await fetch(`${ctx.voiceUrl()}/api/ws/review-edit`, ctx.json("POST", { path, before, after, url }));
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (st.path !== path) return;
      said.innerHTML = md(text);
    }
  } catch {}
  if (!text.trim()) { box.hidden = true; return; }
  const row = document.createElement("div");
  row.className = "notes-actions";
  row.append(button("Ask Bookwyrm to do it", () => { box.hidden = true; ctx.onAsk(path, `About my edit to ${path}: ${text.trim()}\n\nGo ahead.`); }),
    button("Dismiss", () => { box.hidden = true; }, "button small quiet"));
  box.append(row);
}

// ---------------------------------------------------------------- live events

/** Events from the voice service (edits, syncs, publishes). Returns true when the pane changed. */
export function handleEvent(ev) {
  if (ev.type === "change" && ev.op !== "discard") {
    if (st.mode === "edit") return false;                      // never yank the editor away
    showPreview(ev.change, ev.path);
    return true;
  }
  if ((ev.type === "change" && ev.op === "discard") || ev.type === "review" || ev.type === "conflict" || ev.type === "upstream") {
    if (st.mode === "preview" && st.change === ev.change) showPreview(ev.change, st.path);
    return false;
  }
  if (ev.type === "show" && st.mode !== "edit") {
    openDocument(ev.path);
    return true;
  }
  if (ev.type === "synced" && st.path && ev.changed?.includes(st.path)) {
    if (st.mode === "view") {
      notice("This document was updated on GitHub.", "info", button("Reload", () => openDocument(st.path, { review: false }), "link"));
    } else if (st.mode === "edit") {
      notice("Someone changed this on GitHub while you were editing. Saving keeps both changes where they don't overlap.", "info");
    }
  }
  return false;
}
