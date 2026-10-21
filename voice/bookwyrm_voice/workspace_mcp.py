"""The workspace tools Hermes gives Bookwyrm, as an MCP server on stdio (ADR 0008).

Hermes starts this with the voice service's own Python (``config.yaml`` → ``mcp_servers.workspace``).
It holds no state: every tool is a call to the voice service on 127.0.0.1, which owns the local
copy of the knowledge repo, each conversation's changes and the preview in the app.

It speaks the small part of MCP a tool server needs (initialize, tools/list, tools/call, ping) as
newline-delimited JSON-RPC, so it has no SDK to keep up with.

    python -m bookwyrm_voice.workspace_mcp
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx

SERVICE = os.environ.get("BOOKWYRM_SERVICE_URL", "http://127.0.0.1:7865").rstrip("/")
PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

CONV = {"type": "string", "description": "This conversation's id, from your instructions (the `Workspace:` line)."}
PATH = {"type": "string", "description": "Path from the repo root, e.g. knowledge/policies/Expense Policy.md"}


def _tool(name: str, description: str, props: dict, required: list[str]) -> dict:
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": props, "required": required, "additionalProperties": False}}


TOOLS = [
    _tool("list_files",
          "List the knowledge repo's files and folders (synced from GitHub; your unpublished edits included). "
          "Start at the root, then narrow with `path`.",
          {"conversation": CONV, "path": {"type": "string", "description": "Folder to list; empty for the root."},
           "depth": {"type": "integer", "description": "How many levels down (default 2).", "minimum": 1, "maximum": 8}},
          ["conversation"]),
    _tool("read_file",
          "Read a file, as it stands with this conversation's unpublished edits applied.",
          {"conversation": CONV, "path": PATH}, ["conversation", "path"]),
    _tool("search",
          "Find lines in the repo's text files (case-insensitive). Use it to find every document a sweeping "
          "change touches, e.g. every mention of a source system under a subject area.",
          {"conversation": CONV, "query": {"type": "string"},
           "path": {"type": "string", "description": "Only under this folder, e.g. knowledge/claims"},
           "regex": {"type": "boolean", "description": "Treat query as a regular expression."},
           "max_results": {"type": "integer", "minimum": 1, "maximum": 400}},
          ["conversation", "query"]),
    _tool("write_file",
          "Create a file or replace its whole content. The person sees it in the rendered preview straight away "
          "and approves or discards it there. Keep frontmatter you aren't changing exactly as it was.",
          {"conversation": CONV, "path": PATH, "content": {"type": "string", "description": "The whole new file."}},
          ["conversation", "path", "content"]),
    _tool("edit_file",
          "Replace exact text in a file (cheaper than write_file for small or repeated changes). `old` must match "
          "the file exactly, once, unless replace_all is true.",
          {"conversation": CONV, "path": PATH, "old": {"type": "string"}, "new": {"type": "string"},
           "replace_all": {"type": "boolean"}},
          ["conversation", "path", "old", "new"]),
    _tool("delete_file", "Delete a file (the person approves the deletion in the preview).",
          {"conversation": CONV, "path": PATH}, ["conversation", "path"]),
    _tool("move_file", "Move or rename a file.",
          {"conversation": CONV, "from": PATH, "to": PATH}, ["conversation", "from", "to"]),
    _tool("show_document",
          "Open a document in the person's app, rendered, without changing it: to point at what you're "
          "talking about.",
          {"conversation": CONV, "path": PATH}, ["conversation", "path"]),
    _tool("describe_change",
          "Name this conversation's changes (the pull request title) and the GitHub issues they resolve. "
          "Issues listed here are closed with a link once the person approves and the change merges.",
          {"conversation": CONV, "title": {"type": "string", "description": "Short, e.g. 'Replace PHMS with KMS in claims'"},
           "resolves": {"type": "array", "items": {"type": "integer"}, "description": "Gap or quarantine issue numbers."}},
          ["conversation"]),
    _tool("change_status",
          "What's in this conversation's changes: each file and whether the person approved, discarded or still "
          "has to look at it, any conflicts with newer edits on GitHub, and recent pull requests.",
          {"conversation": CONV}, ["conversation"]),
    _tool("discard",
          "Drop unpublished edits: one file, or (no path) all of this conversation's changes. Only when the "
          "person asks.",
          {"conversation": CONV, "path": PATH}, ["conversation"]),
]


def _fmt_tree(nodes: list[dict], depth: int, indent: str = "") -> list[str]:
    out = []
    for n in nodes:
        if n["dir"]:
            out.append(f"{indent}{n['name']}/")
            if depth > 1:
                out += _fmt_tree(n["children"], depth - 1, indent + "  ")
            else:
                count = _count(n["children"])
                out[-1] += f"  ({count} file{'s' if count != 1 else ''})"
        else:
            out.append(f"{indent}{n['name']}" + (f"  [{n['mark']} in this conversation]" if n.get("mark") else ""))
    return out


def _count(nodes: list[dict]) -> int:
    return sum(_count(n["children"]) if n["dir"] else 1 for n in nodes)


def _find(nodes: list[dict], path: str) -> list[dict] | None:
    path = path.strip("/")
    if not path:
        return nodes
    for n in nodes:
        if n["dir"] and (n["path"] == path or path.startswith(n["path"] + "/")):
            return n["children"] if n["path"] == path else _find(n["children"], path)
    return None


class Service:
    def __init__(self, base: str = SERVICE, transport: httpx.BaseTransport | None = None):
        self.c = httpx.Client(base_url=base, timeout=httpx.Timeout(180, connect=5),
                              **({"transport": transport} if transport else {}))

    def call(self, method: str, url: str, **kw) -> Any:
        try:
            r = self.c.request(method, url, **kw)
        except httpx.ConnectError as e:
            raise RuntimeError("Bookwyrm's app service isn't running on this computer, so the repo can't be reached. "
                               "Tell the person to open Bookwyrm.") from e
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"detail": r.text}
        if r.status_code >= 400:
            raise RuntimeError(data.get("detail") or f"HTTP {r.status_code}")
        return data

    def run(self, name: str, a: dict) -> str:
        cid = a.get("conversation") or ""
        ch = f"/api/ws/changes/{cid}"
        if name == "list_files":
            tree = self.call("GET", "/api/ws/tree", params={"change": cid})
            nodes = _find(tree["tree"], a.get("path") or "")
            if nodes is None:
                return f"There's no folder {a.get('path')!r}."
            lines = _fmt_tree(nodes, int(a.get("depth") or 2))
            head = f"{tree['repo']} at {str(tree.get('sha') or '')[:7]}" + (f" (synced {tree['synced']})" if tree.get("synced") else "")
            return head + "\n" + ("\n".join(lines) if lines else "(empty)")
        if name == "read_file":
            f = self.call("GET", "/api/ws/file", params={"path": a["path"], "change": cid})
            note = " (with this conversation's unpublished edits)" if f.get("edited") else ""
            return f"{f['path']}{note}:\n\n{f['content']}"
        if name == "search":
            r = self.call("GET", "/api/ws/search", params={"q": a["query"], "path": a.get("path") or "", "change": cid,
                                                          "regex": str(bool(a.get("regex"))).lower(),
                                                          "limit": int(a.get("max_results") or 80)})
            if not r["matches"]:
                return "No matches."
            lines = [f"{m['path']}:{m['line']}: {m['text']}" for m in r["matches"]]
            more = f"\n… {r['total'] - len(lines)} more matches; narrow the search or raise max_results." if r["truncated"] else ""
            return f"{r['total']} match{'es' if r['total'] != 1 else ''} in {r['files']} file{'s' if r['files'] != 1 else ''}:\n" + "\n".join(lines) + more
        if name == "write_file":
            r = self.call("POST", f"{ch}/write", json={"path": a["path"], "content": a["content"]})
            return f"{'Created' if r['new_file'] else 'Updated'} {r['path']} in this conversation's changes; it's in the person's preview, waiting for their approval."
        if name == "edit_file":
            r = self.call("POST", f"{ch}/edit", json={"path": a["path"], "old": a["old"], "new": a["new"],
                                                     "replace_all": bool(a.get("replace_all"))})
            return f"Replaced {r['replaced']} occurrence{'s' if r['replaced'] != 1 else ''} in {r['path']}; it's in the preview, waiting for approval."
        if name == "delete_file":
            r = self.call("POST", f"{ch}/delete", json={"path": a["path"]})
            return (f"Dropped {r['path']} (it only existed in this conversation)." if r["status"] == "dropped"
                    else f"Marked {r['path']} for deletion; the person approves it in the preview.")
        if name == "move_file":
            r = self.call("POST", f"{ch}/move", json={"from": a["from"], "to": a["to"]})
            return f"Moved {r['from']} to {r['to']}; waiting for approval in the preview."
        if name == "show_document":
            r = self.call("POST", f"{ch}/show", json={"path": a["path"]})
            return f"Showing {r['shown']} in the person's app."
        if name == "describe_change":
            r = self.call("POST", f"{ch}/meta", json={"title": a.get("title"), "resolves": a.get("resolves") or []})
            return f"Noted. Title: {r['title'] or '(automatic)'}; resolves: {', '.join(f'#{n}' for n in r['resolves']) or 'nothing'}."
        if name == "change_status":
            r = self.call("GET", ch)
            return _fmt_status(r)
        if name == "discard":
            r = self.call("POST", f"{ch}/discard", json={"path": a.get("path")})
            return f"Discarded {len(r['discarded'])} file(s): {', '.join(r['discarded']) or 'nothing'}."
        raise RuntimeError(f"Unknown tool {name}")


def _fmt_status(r: dict) -> str:
    lines = []
    if r.get("files"):
        c = r["counts"]
        lines.append(f"Unpublished changes ({c['pending']} waiting for the person, {c['approved']} approved, "
                     f"{c['rejected']} discarded, {c['conflict']} in conflict):")
        for f in r["files"]:
            extra = " — changed on GitHub since you edited it" if f.get("upstream") else ""
            lines.append(f"- {f['path']}: {'delete' if f['op'] == 'delete' else 'edit'}, {f['status']}{extra}")
        if c["conflict"]:
            lines.append("For a conflict: read the file again (that's the latest from GitHub plus nothing of yours), "
                         "redo your edit on it with write_file, and tell the person it's ready to look at again.")
    else:
        lines.append("No unpublished changes in this conversation.")
    for h in r.get("history", []):
        state = "merged" if h.get("merged") else f"open, not merged ({h.get('message', '')})"
        lines.append(f"Published: PR #{h['pr']} {h['url']} — {h['title']} ({state})")
    return "\n".join(lines)


# ---- JSON-RPC on stdio ----------------------------------------------------------------------------

def handle(service: Service, msg: dict) -> dict | None:
    method = msg.get("method")
    mid = msg.get("id")
    if mid is None:          # a notification (initialized, cancelled): nothing to answer
        return None
    if method == "initialize":
        asked = (msg.get("params") or {}).get("protocolVersion")
        return {"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[1],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "bookwyrm-workspace", "version": "0.1.0"},
            "instructions": "Bookwyrm's local copy of the knowledge repo and this conversation's changes.",
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        p = msg.get("params") or {}
        try:
            text = service.run(p.get("name", ""), p.get("arguments") or {})
            return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}}
        except KeyError as e:
            err = f"Missing argument {e}."
        except Exception as e:  # noqa: BLE001 — every failure goes back to the model as text
            err = str(e)
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": err}], "isError": True}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def main():
    service = Service()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        else:
            out = handle(service, msg) if isinstance(msg, dict) else None
        if out is not None:
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
