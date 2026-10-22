"""Bookwyrm's local copy of the knowledge repo, and the changes made to it (ADR 0008).

The repo
    ``~/.bookwyrm/workspace/<owner>__<name>/main`` holds the files of the repo's default branch.
    It is fetched over GitHub's REST API (a tarball the first time, then only the files a compare
    says changed), so nobody needs git installed. It syncs when the service starts, every few
    minutes, and right before an edit begins.

Changes
    Every edit, by Bookwyrm or by a person, lands in a *change*: an overlay of new file contents
    keyed by conversation (``changes/<id>/new/<path>``), with the file as it was when first
    touched (``changes/<id>/base/<path>``) so a later upstream edit can be merged three ways.
    Each file in a change is ``pending`` until the person approves or discards it in the app's
    preview. When none are pending and at least one is approved, the change is published: one
    branch, one commit, one pull request, merged straight away (the person already approved it).
    If branch protection won't let the token merge, the pull request stays open for a reviewer.

Human edits are stamped as OKF ``verified`` entries (``{by: "human:Name (Team)", at: ...}``) on
concepts under ``knowledge/``, so Archivist can tell a person stood behind this version.

Everything here is used by the voice service (server.py), which also serves it to the app and,
through workspace_mcp.py, to Hermes.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import tarfile
import tempfile
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote

import httpx
import yaml
from loguru import logger
from merge3 import Merge3

from .config import Settings, data_dir

API = "https://api.github.com"
TEXT_LIMIT = 2_000_000           # bytes; bigger files are listed but never searched or edited
CHANGE_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
HIDDEN_TOP = {".git", ".github"}  # never shown to people or the agent
STATUSES = ("pending", "approved", "rejected", "conflict")


class WorkspaceError(Exception):
    """Something the person or the agent should be told, in plain words."""


# ---- paths ---------------------------------------------------------------------------------------

def clean_path(path: str) -> str:
    """A repo-relative POSIX path, or WorkspaceError. Never escapes the repo, never touches .git."""
    p = (path or "").strip().replace("\\", "/").lstrip("/")
    while p.startswith("./"):
        p = p[2:]
    if not p:
        raise WorkspaceError("A file path is needed (relative to the repo root, e.g. knowledge/policies/Expense Policy.md).")
    parts = PurePosixPath(p).parts
    if any(part in ("..", "") for part in parts) or re.match(r"^[A-Za-z]:", p) or "\x00" in p:
        raise WorkspaceError(f"{path!r} isn't a path inside the repo.")
    if parts[0].casefold() in HIDDEN_TOP:   # .GITHUB is .github on macOS and Windows
        raise WorkspaceError(f"{parts[0]}/ isn't part of the knowledge Bookwyrm looks after.")
    return "/".join(parts)


def repo_key(repo: str) -> str:
    return repo.replace("/", "__")


def now_utc() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _key(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()


def _read(path: Path) -> str:
    """A text file exactly as stored: Windows line endings stay as they are."""
    return path.read_bytes().decode("utf-8")


def is_text(data: bytes) -> bool:
    if len(data) > TEXT_LIMIT or b"\x00" in data[:8192]:
        return False
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


# ---- the human stamp -----------------------------------------------------------------------------

_FM = re.compile(r"\A---[ \t]*\r?\n(.*?)(?:^---[ \t]*\r?$)", re.S | re.M)


def wants_stamp(path: str) -> bool:
    return path.startswith("knowledge/") and path.endswith(".md")


def _flow(item: Any) -> str:
    return yaml.safe_dump(item, default_flow_style=True, sort_keys=False, width=1_000_000).strip()


def _key_block(lines: list[str], idx: int) -> int:
    """The end (exclusive) of the value of the top-level key on line ``idx``: indented lines,
    "- " items at column 0, blank lines inside it, and a flow value that spans lines."""
    depth = lines[idx].count("[") + lines[idx].count("{") - lines[idx].count("]") - lines[idx].count("}")
    end = idx + 1
    j = idx + 1
    while j < len(lines):
        line = lines[j]
        if depth <= 0 and line.strip() and not line.startswith((" ", "\t", "- ")) and line.strip() != "-":
            break
        depth += line.count("[") + line.count("{") - line.count("]") - line.count("}")
        j += 1
        if line.strip():
            end = j
    return end


def stamp_human(text: str, by: str, at: str) -> str:
    """Append ``{by: <by>, at: <at>}`` to the concept's OKF ``verified`` list, changing nothing
    else in the frontmatter. A file with no frontmatter gets one holding only the stamp. Raises
    WorkspaceError rather than write frontmatter that doesn't parse."""
    entry = f'{{by: {json.dumps(by)}, at: {at}}}'
    nl = "\r\n" if "\r\n" in text[:2000] else "\n"
    m = _FM.match(text)
    if not m:
        return f"---{nl}verified:{nl}  - {entry}{nl}---{nl}{nl}{text}"
    fm = m.group(1)
    lines = fm.splitlines()
    try:
        before = yaml.safe_load(fm) or {}
    except yaml.YAMLError as e:
        raise WorkspaceError(f"This document's frontmatter isn't valid YAML, so it can't be stamped: {e}") from e
    if not isinstance(before, dict):
        raise WorkspaceError("This document's frontmatter isn't a set of fields.")
    old = before.get("verified")
    old_items = old if isinstance(old, list) else ([] if old is None else [old])
    idx = next((i for i, line in enumerate(lines) if re.match(r"^verified\s*:", line)), None)
    if idx is None:
        lines += ["verified:", f"  - {entry}"]
    else:
        end = _key_block(lines, idx)
        value = lines[idx].split(":", 1)[1].strip()
        items = [ln for ln in lines[idx + 1:end] if ln.strip()]
        if isinstance(old, list) and (not value or value.startswith("#")) and items and items[0].lstrip().startswith("- "):
            # Already a block list: add one item in the same style, after the last.
            prefix = items[0][: len(items[0]) - len(items[0].lstrip())] + "- "
            lines.insert(end, f"{prefix}{entry}")
        else:
            # An inline mapping, a flow list (on one line or several), a block mapping: rewrite
            # just this key as a block list holding what was there, then the stamp.
            lines[idx:end] = ["verified:", *[f"  - {_flow(i)}" for i in old_items], f"  - {entry}"]
    new_fm = nl.join(lines) + nl
    out = text[: m.start(1)] + new_fm + text[m.end(1):]
    try:
        after = yaml.safe_load(new_fm)
    except yaml.YAMLError as e:
        raise WorkspaceError(f"Stamping this document's frontmatter would break it ({e}); not publishing it.") from e
    if (not isinstance(after, dict) or not isinstance(after.get("verified"), list)
            or after["verified"][:-1] != old_items or {k: v for k, v in after.items() if k != "verified"}
            != {k: v for k, v in before.items() if k != "verified"}):
        raise WorkspaceError("Stamping this document's frontmatter would change more than the stamp; not publishing it.")
    return out


def human_label(settings: Settings) -> str:
    if settings.name and settings.team:
        return f"human:{settings.name} ({settings.team})"
    return f"human:{settings.name or 'someone using Bookwyrm'}"


# ---- three-way merge ----------------------------------------------------------------------------

def merge_text(base: str, ours: str, theirs: str) -> str | None:
    """Merge our edit and an upstream edit of the same base. None when they overlap."""
    if ours == theirs:
        return ours
    if base == theirs:
        return ours
    if base == ours:
        return theirs
    m = Merge3(base.splitlines(True), ours.splitlines(True), theirs.splitlines(True))
    out: list[str] = []
    for group in m.merge_groups():
        kind = group[0]
        if kind == "conflict":
            return None
        out.extend(group[1])
    return "".join(out)


def _canon(line: str) -> str:
    """A line with the differences a Markdown editor makes on rewrite taken out: spacing, bullet
    and emphasis markers, the length of table rules, escaping."""
    line = re.sub(r"^(\s*)[*+](\s)", r"\1-\2", line)
    line = re.sub(r"[*_]+", "*", line.replace("\\", ""))
    return re.sub(r"-{2,}", "-", re.sub(r"\s+", "", line))


def apply_preserving(original: str, normalized: str, edited: str) -> str:
    """Apply a person's edit, made on an editor's rewrite of a file (``normalized``) and saved as
    ``edited``, to the file as it was written (``original``): only the lines they changed change.
    Lines the editor reformatted but they didn't touch keep their original form, and lines the
    editor dropped (comments, say) stay where they were."""
    from difflib import SequenceMatcher
    o = original.splitlines(True)
    n = normalized.splitlines(True)
    e = edited.splitlines(True)
    # How the editor's lines correspond to the original's, block by block.
    seg: list[tuple | None] = [None] * len(n)     # n index -> (tag, i1, i2, j1, j2)
    orig_only: dict[int, list[str]] = {}          # n position -> original lines the editor dropped there
    for op in SequenceMatcher(None, [_canon(x) for x in n], [_canon(x) for x in o], autojunk=False).get_opcodes():
        tag, i1, i2, j1, j2 = op
        if tag == "insert":
            orig_only.setdefault(i1, []).extend(o[j1:j2])
        for i in range(i1, i2):
            seg[i] = op
    out: list[str] = []
    placed: set[int] = set()

    def add(lines: list[str]):
        if lines and out and not out[-1].endswith(("\n", "\r")):
            out[-1] += "\r\n" if out[-1:] and "\r\n" in original[:2000] else "\n"
        out.extend(lines)

    def dropped_at(p: int):
        if p in orig_only and p not in placed:
            placed.add(p)
            add(orig_only[p])

    for tag, a1, a2, b1, b2 in SequenceMatcher(None, n, e, autojunk=False).get_opcodes():
        if tag != "equal":
            # What they replaced or deleted goes, with anything the editor had dropped inside it.
            dropped_at(a1)
            placed.update(range(a1 + 1, a2))
            add(e[b1:b2])
            continue
        i = a1
        while i < a2:
            dropped_at(i)
            stag, i1, i2, j1, j2 = seg[i]
            if stag == "equal":
                add([o[j1 + (i - i1)]])
                i += 1
            elif stag == "replace" and a1 <= i1 and i2 <= a2 and i == i1:
                add(o[j1:j2])                     # reformatted, untouched: the original form
                placed.update(range(i1 + 1, i2))
                i = i2
            elif stag == "replace":
                add([n[i]])                       # partly edited block: the editor's form
                i += 1
            else:                                 # a line only the editor has (a blank, say)
                i += 1
    dropped_at(len(n))
    return "".join(out)


# ---- GitHub --------------------------------------------------------------------------------------

class GitHub:
    """The few REST calls the workspace needs. ``transport`` lets tests stand in for GitHub."""

    def __init__(self, repo: str, token: str, *, api: str = API, transport: httpx.AsyncBaseTransport | None = None):
        self.repo = repo
        self.base = f"{api}/repos/{repo}"
        self._client_args = {
            "headers": {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "bookwyrm"},
            "timeout": httpx.Timeout(60, connect=10),
            "follow_redirects": True,
            **({"transport": transport} if transport else {}),
        }
        self.default_branch: str | None = None

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(**self._client_args)

    @staticmethod
    def _raise(r: httpx.Response, doing: str):
        if r.is_success:
            return
        try:
            msg = r.json().get("message", "")
        except ValueError:
            msg = r.text[:200]
        if r.status_code in (401, 403) and "rate limit" not in msg.lower():
            raise WorkspaceError(f"GitHub refused to {doing} ({r.status_code}: {msg}). Check the GitHub token in Settings still covers the repo.")
        raise WorkspaceError(f"GitHub couldn't {doing} ({r.status_code}: {msg}).")

    async def branch(self, c: httpx.AsyncClient) -> str:
        if not self.default_branch:
            r = await c.get(self.base)
            self._raise(r, "read the repo")
            self.default_branch = r.json().get("default_branch") or "main"
        return self.default_branch

    async def head(self, c: httpx.AsyncClient) -> str:
        r = await c.get(f"{self.base}/commits/{quote(await self.branch(c), safe='')}",
                        headers={"Accept": "application/vnd.github.sha"})
        self._raise(r, "read the latest commit")
        return r.text.strip()

    async def tarball(self, c: httpx.AsyncClient, sha: str, dest: Path):
        async with c.stream("GET", f"{self.base}/tarball/{sha}") as r:
            if not r.is_success:
                await r.aread()
                self._raise(r, "download the repo")
            with dest.open("wb") as f:
                async for chunk in r.aiter_bytes():
                    f.write(chunk)

    async def compare(self, c: httpx.AsyncClient, old: str, new: str) -> list[dict] | None:
        """Files changed between two commits, or None when a compare can't say (too many, history
        rewritten): then the caller downloads everything again."""
        r = await c.get(f"{self.base}/compare/{old}...{new}", params={"per_page": 300})
        if r.status_code in (404, 422):
            return None
        self._raise(r, "compare commits")
        data = r.json()
        files = data.get("files")
        if files is None or len(files) >= 300 or data.get("status") not in ("ahead", "identical"):
            return None
        return files

    async def raw(self, c: httpx.AsyncClient, path: str, ref: str) -> bytes | None:
        r = await c.get(f"{self.base}/contents/{quote(path)}", params={"ref": ref},
                        headers={"Accept": "application/vnd.github.raw+json"})
        if r.status_code == 404:
            return None
        self._raise(r, f"read {path}")
        return r.content

    async def publish(self, c: httpx.AsyncClient, *, head: str, branch: str, message: str,
                      writes: dict[str, str], deletes: list[str]) -> str:
        """One commit on a new branch from ``head`` with these files. Returns the branch name."""
        r = await c.get(f"{self.base}/git/commits/{head}")
        self._raise(r, "read the latest commit")
        base_tree = r.json()["tree"]["sha"]
        entries = [{"path": p, "mode": "100644", "type": "blob", "content": t} for p, t in writes.items()]
        entries += [{"path": p, "mode": "100644", "type": "blob", "sha": None} for p in deletes]
        r = await c.post(f"{self.base}/git/trees", json={"base_tree": base_tree, "tree": entries})
        self._raise(r, "prepare the commit")
        tree = r.json()["sha"]
        r = await c.post(f"{self.base}/git/commits", json={"message": message, "tree": tree, "parents": [head]})
        self._raise(r, "make the commit")
        commit = r.json()["sha"]
        name = branch
        for n in range(2, 20):
            r = await c.post(f"{self.base}/git/refs", json={"ref": f"refs/heads/{name}", "sha": commit})
            if r.status_code != 422:
                break
            name = f"{branch}-{n}"
        self._raise(r, "create the branch")
        return name

    async def pull_request(self, c: httpx.AsyncClient, *, branch: str, title: str, body: str) -> dict:
        r = await c.post(f"{self.base}/pulls", json={"title": title, "head": branch, "base": await self.branch(c),
                                                    "body": body, "maintainer_can_modify": True})
        self._raise(r, "open the pull request")
        return r.json()

    async def merge(self, c: httpx.AsyncClient, number: int, title: str) -> tuple[bool, str]:
        """Merge, trying squash, then a merge commit, then rebase (whichever the repo allows)."""
        last = ""
        for method in ("squash", "merge", "rebase"):
            r = await c.put(f"{self.base}/pulls/{number}/merge", json={"merge_method": method, "commit_title": title})
            if r.is_success:
                return True, ""
            try:
                last = r.json().get("message", "")
            except ValueError:
                last = r.text[:200]
            if "not allowed" not in last.lower():   # protection, checks, conflicts: not a method problem
                break
        return False, last or "GitHub wouldn't merge it"

    async def delete_branch(self, c: httpx.AsyncClient, branch: str):
        await c.delete(f"{self.base}/git/refs/heads/{quote(branch, safe='/')}")

    async def comment(self, c: httpx.AsyncClient, number: int, body: str):
        r = await c.post(f"{self.base}/issues/{number}/comments", json={"body": body})
        self._raise(r, f"comment on #{number}")

    async def close_issue(self, c: httpx.AsyncClient, number: int, reason: str = "completed"):
        r = await c.patch(f"{self.base}/issues/{number}", json={"state": "closed", "state_reason": reason})
        self._raise(r, f"close #{number}")

    async def issues(self, c: httpx.AsyncClient) -> list[dict]:
        out: list[dict] = []
        for page in range(1, 11):
            r = await c.get(f"{self.base}/issues", params={"state": "open", "per_page": 100, "page": page})
            self._raise(r, "list issues")
            batch = r.json()
            out += batch
            if len(batch) < 100:
                break
        return out


# ---- gaps ----------------------------------------------------------------------------------------

_GAP_TITLE = re.compile(r"^(?:\[(?P<team>[^\]]+)\]\s*)?(?P<concept>.*?)\s+—\s+(?P<kind>[a-z][a-z0-9_]*)$")


def gap_info(issue: dict) -> dict:
    """What the app shows for a gap issue. Archivist's body starts ``## Concept\\n<path>``."""
    title = issue.get("title", "")
    m = _GAP_TITLE.match(title)
    body = issue.get("body") or ""
    cm = re.search(r"^## Concept\s*\n+([^\n]+)", body, re.M)
    gm = re.search(r"^## Gap[^\n]*\n+[^\n]*\n+(.+?)(?:\n## |\Z)", body, re.M | re.S)
    return {
        "number": issue["number"], "title": title, "url": issue.get("html_url", ""),
        "created": issue.get("created_at"), "labels": [lbl["name"] for lbl in issue.get("labels", [])],
        "concept_title": m.group("concept") if m else title,
        "team": m.group("team") if m else None,
        "kind": m.group("kind").replace("_", " ") if m else None,
        "concept": cm.group(1).strip() if cm else None,
        "detail": gm.group(1).strip()[:600] if gm else "",
        "assignees": [a["login"] for a in issue.get("assignees", [])],
    }


# ---- the workspace --------------------------------------------------------------------------------

@dataclass
class Change:
    id: str
    dir: Path
    manifest: dict

    @property
    def files(self) -> dict[str, dict]:
        return self.manifest.setdefault("files", {})

    # Overlay files are stored under a hash of their repo path, not the path itself. Macs and
    # Windows treat index.md and INDEX.md as one file, and Windows refuses names like CON or
    # "Type: Null.md"; a hash is the same everywhere.
    def new(self, path: str) -> Path:
        return self.dir / "new" / _key(path)

    def base(self, path: str) -> Path:
        return self.dir / "base" / _key(path)


class Workspace:
    """One knowledge repo on this machine. ``settings`` is called each time so changes made in the
    app (name, team) apply at once; a different repo gets a different Workspace."""

    def __init__(self, settings: Callable[[], Settings], *, root: Path | None = None,
                 api: str = API, transport: httpx.AsyncBaseTransport | None = None):
        self._settings = settings
        s = settings()
        self.repo = s.repo
        self.token = s.github_token
        self.root = root or data_dir() / "workspace" / repo_key(self.repo)
        self.main = self.root / "main"
        self.changes_dir = self.root / "changes"
        self.state_file = self.root / "state.json"
        self.gh = GitHub(self.repo, s.github_token, api=api, transport=transport)
        self._sync_lock = asyncio.Lock()
        self._publish_lock = asyncio.Lock()
        self.subscribers: set[asyncio.Queue] = set()
        self.syncing = False
        self.error: str | None = None
        self._paths: set[str] | None = None   # exact-case listing of main, rebuilt after a sync

    # ---- state and events

    @property
    def state(self) -> dict:
        try:
            return json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_state(self, **kw):
        data = {**self.state, **kw}
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(self.state_file)

    def emit(self, event: dict):
        event = {"at": time.time(), **event}
        for q in list(self.subscribers):
            q.put_nowait(event)

    def status(self) -> dict:
        st = self.state
        return {"repo": self.repo, "sha": st.get("sha"), "synced_at": st.get("synced_at"),
                "checked_at": st.get("checked_at"), "syncing": self.syncing, "error": self.error,
                "ready": self.main.is_dir() and bool(st.get("sha"))}

    # ---- sync

    async def sync(self, *, max_age: float = 0) -> dict:
        """Bring ``main`` up to the repo's default branch. ``max_age``: skip the check when the
        last one was this recent (seconds). Returns {changed: [paths], sha}."""
        if max_age and time.time() - (self.state.get("checked_at") or 0) < max_age and self.main.is_dir():
            return {"changed": [], "sha": self.state.get("sha")}
        async with self._sync_lock:
            self.syncing = True
            self.emit({"type": "sync", "syncing": True})
            try:
                result = await self._sync()
                self.error = None
                return result
            except (httpx.HTTPError, WorkspaceError) as e:
                self.error = str(e) if isinstance(e, WorkspaceError) else f"Couldn't reach GitHub ({type(e).__name__})"
                logger.warning(f"Workspace sync failed: {self.error}")
                raise WorkspaceError(self.error) from e
            finally:
                self.syncing = False
                self.emit({"type": "sync", "syncing": False, **self.status()})

    async def _sync(self) -> dict:
        async with self.gh.client() as c:
            head = await self.gh.head(c)
            old = self.state.get("sha")
            if old == head and self.main.is_dir():
                self._save_state(checked_at=time.time())
                return {"changed": [], "sha": head}
            files = await self.gh.compare(c, old, head) if old and self.main.is_dir() else None
            if files is None:
                changed = await self._download(c, head)
            else:
                changed = []
                for f in files:
                    name = f["filename"]
                    if f.get("previous_filename"):
                        self._remove(f["previous_filename"])
                        changed.append(f["previous_filename"])
                    if name.split("/")[0] in HIDDEN_TOP:
                        continue
                    if f["status"] == "removed":
                        self._remove(name)
                    else:
                        data = await self.gh.raw(c, name, head)
                        if data is None:
                            self._remove(name)
                        else:
                            target = self._main_file(name)
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(data)
                    changed.append(name)
        self._paths = None
        self._save_state(sha=head, synced_at=time.time(), checked_at=time.time())
        changed = sorted({p for p in changed if p.split("/")[0] not in HIDDEN_TOP})
        if changed:
            self._flag_upstream(changed)
            self.emit({"type": "synced", "changed": changed[:500], "sha": head})
        logger.info(f"Workspace {self.repo} at {head[:7]} ({len(changed)} files changed)")
        return {"changed": changed, "sha": head}

    async def _download(self, c: httpx.AsyncClient, sha: str) -> list[str]:
        self.root.mkdir(parents=True, exist_ok=True)
        before = self._fingerprints()
        with tempfile.TemporaryDirectory(dir=self.root) as tmp:
            tar = Path(tmp) / "repo.tar.gz"
            await self.gh.tarball(c, sha, tar)
            out = Path(tmp) / "x"
            await asyncio.to_thread(_extract, tar, out)
            tops = [p for p in out.iterdir() if p.is_dir()]
            if len(tops) != 1:
                raise WorkspaceError("GitHub sent an archive Bookwyrm didn't understand.")
            fresh = self.root / "main.new"
            shutil.rmtree(fresh, ignore_errors=True)
            shutil.move(str(tops[0]), fresh)
        old = self.root / "main.old"
        shutil.rmtree(old, ignore_errors=True)
        if self.main.exists():
            self.main.rename(old)
        fresh.rename(self.main)
        shutil.rmtree(old, ignore_errors=True)
        if not before:
            return []
        # A full download after a long time away: report what differs by content.
        after = self._fingerprints()
        return sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))

    def _fingerprints(self) -> dict[str, tuple[int, int]]:
        out = {}
        for p in self.list_paths():
            data = (self.main / p).read_bytes()
            out[p] = (len(data), hash(data))
        return out

    def _main_file(self, path: str) -> Path:
        return self.main / clean_path(path)

    def _main_paths(self) -> set[str]:
        """Every file on main, spelled exactly as GitHub has it. Lookups go through this, not the
        filesystem: on a Mac or Windows, asking for INDEX.md would find index.md."""
        if self._paths is None:
            self._paths = set(self.list_paths())
        return self._paths

    def _main_has(self, path: str) -> bool:
        return path in self._main_paths()

    def _remove(self, path: str):
        try:
            self._main_file(path).unlink(missing_ok=True)
        except WorkspaceError:
            pass

    # ---- reading

    def list_paths(self) -> list[str]:
        if not self.main.is_dir():
            return []
        out = []
        for p in self.main.rglob("*"):
            if p.is_file():
                rel = p.relative_to(self.main).as_posix()
                if rel.split("/")[0] not in HIDDEN_TOP:
                    out.append(rel)
        return sorted(out)

    def tree(self, change: str | None = None) -> list[dict]:
        """Every file, with any change's additions and deletions applied, as a nested list."""
        paths = set(self._main_paths())
        marks: dict[str, str] = {}
        if change and (ch := self.get_change(change)):
            for p, f in ch.files.items():
                if f["op"] == "delete":
                    marks[p] = "deleted"
                else:
                    marks[p] = "changed" if p in paths else "added"
                    paths.add(p)
        root: dict = {}
        for p in sorted(paths):
            node = root
            parts = p.split("/")
            for d in parts[:-1]:
                node = node.setdefault(d + "/", {})
            node[parts[-1]] = p

        def build(node: dict, prefix: str) -> list[dict]:
            dirs = sorted((k for k in node if k.endswith("/")), key=str.lower)
            files = sorted((k for k in node if not k.endswith("/")), key=str.lower)
            out = [{"name": d[:-1], "path": prefix + d[:-1], "dir": True, "children": build(node[d], prefix + d)} for d in dirs]
            out += [{"name": f, "path": node[f], "dir": False, **({"mark": marks[node[f]]} if node[f] in marks else {})}
                    for f in files]
            return out

        return build(root, "")

    def read_main(self, path: str) -> str | None:
        f = self._main_file(path)
        if not self._main_has(clean_path(path)):
            return None
        data = f.read_bytes()
        if not is_text(data):
            raise WorkspaceError(f"{path} isn't a text file Bookwyrm can read ({len(data):,} bytes).")
        return data.decode("utf-8")

    def read(self, path: str, change: str | None = None) -> str:
        path = clean_path(path)
        # A file in conflict reads as GitHub has it now, so the edit is redone on the latest version.
        if change and (ch := self.get_change(change)) and path in ch.files and ch.files[path]["status"] != "conflict":
            f = ch.files[path]
            if f["op"] == "delete":
                raise WorkspaceError(f"{path} is deleted in this conversation's changes (not published yet).")
            return _read(ch.new(path))
        text = self.read_main(path)
        if text is None:
            raise WorkspaceError(f"There's no {path} in {self.repo}.")
        return text

    def exists(self, path: str, change: str | None = None) -> bool:
        try:
            self.read(path, change)
            return True
        except WorkspaceError:
            return False

    def search(self, query: str, *, under: str = "", regex: bool = False, change: str | None = None,
               limit: int = 60) -> dict:
        """Lines matching ``query`` (case-insensitive) in text files, with this conversation's
        unpublished edits applied."""
        if not query:
            raise WorkspaceError("Say what to search for.")
        try:
            pattern = re.compile(query if regex else re.escape(query), re.I)
        except re.error as e:
            raise WorkspaceError(f"That pattern isn't a valid regular expression: {e}") from e
        prefix = clean_path(under).rstrip("/") + "/" if under.strip("/ ") else ""
        paths = sorted(p for p in self._main_paths() if p.startswith(prefix))
        overlay: dict[str, dict] = {}
        if change and (ch := self.get_change(change)):
            overlay = ch.files
            paths = sorted(set(paths) | {p for p in overlay if p.startswith(prefix) and overlay[p]["op"] == "write"})
        hits: list[dict] = []
        files_hit = 0
        total = 0
        for p in paths:
            if p in overlay and overlay[p]["op"] == "delete":
                continue
            try:
                text = self.read(p, change)
            except (WorkspaceError, UnicodeDecodeError):
                continue
            found = False
            for i, line in enumerate(text.splitlines(), 1):
                if pattern.search(line):
                    total += 1
                    found = True
                    if len(hits) < limit:
                        hits.append({"path": p, "line": i, "text": line.strip()[:240]})
            files_hit += found
        return {"matches": hits, "total": total, "files": files_hit, "truncated": total > len(hits)}

    # ---- changes

    def _change_dir(self, cid: str) -> Path:
        if not CHANGE_ID.match(cid or ""):
            raise WorkspaceError(f"{cid!r} isn't a conversation id Bookwyrm knows.")
        return self.changes_dir / cid

    def get_change(self, cid: str) -> Change | None:
        d = self._change_dir(cid)
        try:
            return Change(cid, d, json.loads((d / "manifest.json").read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return None

    def _save(self, ch: Change):
        ch.manifest["updated"] = time.time()
        ch.dir.mkdir(parents=True, exist_ok=True)
        tmp = ch.dir / "manifest.tmp"
        tmp.write_text(json.dumps(ch.manifest, indent=2), encoding="utf-8")
        tmp.replace(ch.dir / "manifest.json")

    def _ensure_change(self, cid: str) -> Change:
        ch = self.get_change(cid)
        if ch is None:
            s = self._settings()
            ch = Change(cid, self._change_dir(cid), {"id": cid, "created": time.time(), "files": {}, "order": [],
                                                    "resolves": [], "title": "", "history": [],
                                                    "person": s.caller})
            self._save(ch)
        return ch

    def changes(self) -> list[dict]:
        out = []
        if self.changes_dir.is_dir():
            for d in self.changes_dir.iterdir():
                ch = self.get_change(d.name) if CHANGE_ID.match(d.name) else None
                if ch and ch.files:
                    out.append(self.summary(ch))
        return sorted(out, key=lambda c: -c["updated"])

    def summary(self, ch: Change) -> dict:
        order = [p for p in ch.manifest.get("order", []) if p in ch.files]
        counts = {s: sum(1 for f in ch.files.values() if f["status"] == s) for s in STATUSES}
        return {"id": ch.id, "title": ch.manifest.get("title", ""), "updated": ch.manifest.get("updated", 0),
                "files": [{"path": p, **ch.files[p]} for p in order], "counts": counts,
                "current": ch.manifest.get("current"), "resolves": ch.manifest.get("resolves", []),
                "history": ch.manifest.get("history", [])[-5:]}

    def _touch(self, ch: Change, path: str, *, by: str):
        """First time this change touches ``path``: remember the file as it is on main now."""
        if path in ch.files:
            f = ch.files[path]
            if f["status"] == "conflict":   # a fresh edit after a conflict starts from today's main
                self._record_base(ch, path)
            return
        self._record_base(ch, path)
        ch.files[path] = {"op": "write", "status": "pending", "by": by, "base_exists": self._main_has(path)}
        order = ch.manifest.setdefault("order", [])
        if path not in order:
            order.append(path)

    def _record_base(self, ch: Change, path: str):
        base = ch.base(path)
        src = self.main / path
        there = self._main_has(path)
        if there:
            base.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, base)
        else:
            base.unlink(missing_ok=True)
        if path in ch.files:
            ch.files[path]["base_exists"] = there
            ch.files[path].pop("upstream", None)

    def base_text(self, ch: Change, path: str) -> str | None:
        f = ch.base(path)
        return _read(f) if f.is_file() else None

    def write(self, cid: str, path: str, content: str, *, by: str = "bookwyrm", approve: bool = False) -> dict:
        path = clean_path(path)
        if len(content.encode("utf-8")) > TEXT_LIMIT:
            raise WorkspaceError(f"That's too big for one file ({len(content):,} characters).")
        if any(p.startswith(path + "/") for p in self._main_paths()):
            raise WorkspaceError(f"{path} is a folder.")
        ch = self._ensure_change(cid)
        self._touch(ch, path, by=by)
        f = ch.files[path]
        target = ch.new(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="")
        f.update(op="write", status="approved" if approve else "pending", by=by, updated=time.time())
        f.pop("conflict", None)
        ch.manifest["current"] = path
        self._save(ch)
        self.emit({"type": "change", "change": cid, "path": path, "op": "write", "by": by})
        return {"path": path, "status": f["status"], "new_file": not f["base_exists"]}

    def person_edit(self, cid: str, path: str, content: str, base: str | None) -> dict:
        """A person's own edit from the app's editor: approved already. ``base`` is the file as it
        was when they started editing (None for a new file), so an upstream change made while they
        typed is merged three ways at publish, not overwritten."""
        path = clean_path(path)
        if len(content.encode("utf-8")) > TEXT_LIMIT:
            raise WorkspaceError(f"That's too big for one file ({len(content):,} characters).")
        ch = self._ensure_change(cid)
        b = ch.base(path)
        if base is None:
            b.unlink(missing_ok=True)
        else:
            b.parent.mkdir(parents=True, exist_ok=True)
            b.write_text(base, encoding="utf-8", newline="")
        n = ch.new(path)
        n.parent.mkdir(parents=True, exist_ok=True)
        n.write_text(content, encoding="utf-8", newline="")
        ch.files[path] = {"op": "write", "status": "approved", "by": "person", "base_exists": base is not None,
                          "updated": time.time()}
        ch.manifest.setdefault("order", []).append(path)
        ch.manifest["title"] = f"Edit {PurePosixPath(path).stem}"
        self._save(ch)
        return {"path": path}

    def edit(self, cid: str, path: str, old: str, new: str, *, replace_all: bool = False) -> dict:
        path = clean_path(path)
        text = self.read(path, cid)
        n = text.count(old) if old else 0
        if n == 0:
            raise WorkspaceError(f"The text to replace isn't in {path}. Read the file again and copy it exactly.")
        if n > 1 and not replace_all:
            raise WorkspaceError(f"That text appears {n} times in {path}. Include more around it, or set replace_all.")
        out = self.write(cid, path, text.replace(old, new) if replace_all else text.replace(old, new, 1))
        return {**out, "replaced": n if replace_all else 1}

    def delete(self, cid: str, path: str, *, by: str = "bookwyrm") -> dict:
        path = clean_path(path)
        if not self.exists(path, cid):
            raise WorkspaceError(f"There's no {path} to delete.")
        ch = self._ensure_change(cid)
        self._touch(ch, path, by=by)
        f = ch.files[path]
        (ch.new(path)).unlink(missing_ok=True)
        if not f["base_exists"]:     # it only ever existed in this change: just drop it
            del ch.files[path]
            self._save(ch)
            self.emit({"type": "change", "change": cid, "path": path, "op": "discard"})
            return {"path": path, "status": "dropped"}
        f.update(op="delete", status="pending", by=by, updated=time.time())
        ch.manifest["current"] = path
        self._save(ch)
        self.emit({"type": "change", "change": cid, "path": path, "op": "delete", "by": by})
        return {"path": path, "status": "pending"}

    def move(self, cid: str, src: str, dst: str) -> dict:
        src, dst = clean_path(src), clean_path(dst)
        if self.exists(dst, cid):
            raise WorkspaceError(f"{dst} already exists.")
        text = self.read(src, cid)
        self.write(cid, dst, text)
        self.delete(cid, src)
        return {"from": src, "to": dst, "status": "pending"}

    def discard(self, cid: str, path: str | None = None) -> dict:
        ch = self.get_change(cid)
        if ch is None:
            return {"discarded": []}
        paths = [clean_path(path)] if path else list(ch.files)
        for p in paths:
            if p in ch.files:
                del ch.files[p]
                (ch.new(p)).unlink(missing_ok=True)
                (ch.base(p)).unlink(missing_ok=True)
        self._save(ch)
        self.emit({"type": "change", "change": cid, "op": "discard", "paths": paths})
        return {"discarded": paths}

    def show(self, cid: str | None, path: str) -> dict:
        path = clean_path(path)
        if not self.exists(path, cid):
            raise WorkspaceError(f"There's no {path} in {self.repo}.")
        self.emit({"type": "show", "change": cid, "path": path})
        return {"shown": path}

    def set_meta(self, cid: str, *, title: str | None = None, resolves: list[int] | None = None) -> dict:
        ch = self._ensure_change(cid)
        if title is not None:
            ch.manifest["title"] = title.strip()[:120]
        if resolves:
            ch.manifest["resolves"] = sorted(set(ch.manifest.get("resolves", [])) | {int(n) for n in resolves})
        self._save(ch)
        return self.summary(ch)

    def file_view(self, cid: str, path: str) -> dict:
        """Before and after of one file in a change, for the preview."""
        path = clean_path(path)
        ch = self.get_change(cid)
        if ch is None or path not in ch.files:
            raise WorkspaceError(f"{path} has no unpublished changes in this conversation.")
        f = ch.files[path]
        before = self.read_main(path)
        after = None if f["op"] == "delete" else _read(ch.new(path))
        order = [p for p in ch.manifest.get("order", []) if p in ch.files]
        return {"path": path, **f, "before": before, "after": after, "index": order.index(path), "total": len(order),
                "upstream_changed": bool(f.get("upstream"))}

    def review(self, cid: str, status: str, path: str | None = None) -> dict:
        """The person's verdict on one file (or every pending file, when ``path`` is None)."""
        if status not in ("approved", "rejected", "pending"):
            raise WorkspaceError(f"Unknown review status {status!r}.")
        ch = self.get_change(cid)
        if ch is None or not ch.files:
            raise WorkspaceError("There's nothing waiting for review in this conversation.")
        # "Approve all" approves what's waiting; a conflict has to be redone first. "Discard all"
        # also drops conflicts.
        waiting = ("pending",) if status == "approved" else ("pending", "conflict")
        paths = [clean_path(path)] if path else [p for p, f in ch.files.items() if f["status"] in waiting]
        for p in paths:
            if p not in ch.files:
                raise WorkspaceError(f"{p} isn't part of this conversation's changes.")
            if ch.files[p]["status"] == "conflict" and status == "approved":
                raise WorkspaceError(f"{p} changed on GitHub in a way that overlaps this edit. Ask Bookwyrm to redo it on the latest version first.")
            ch.files[p]["status"] = status
        self._save(ch)
        self.emit({"type": "review", "change": cid, "paths": paths, "status": status})
        return self.summary(ch)

    def ready_to_publish(self, cid: str) -> bool:
        ch = self.get_change(cid)
        if ch is None or not ch.files:
            return False
        statuses = [f["status"] for f in ch.files.values()]
        return "approved" in statuses and "pending" not in statuses and "conflict" not in statuses

    def _flag_upstream(self, changed: list[str]):
        """A file someone else changed on GitHub while it has unpublished edits here."""
        hit = set(changed)
        for c in self.changes():
            ch = self.get_change(c["id"])
            touched = [p for p in ch.files if p in hit]
            for p in touched:
                ch.files[p]["upstream"] = True
            if touched:
                self._save(ch)
                self.emit({"type": "upstream", "change": ch.id, "paths": touched})

    # ---- publishing

    async def publish(self, cid: str) -> dict:
        async with self._publish_lock:
            return await self._publish(cid)

    async def _publish(self, cid: str) -> dict:
        ch = self.get_change(cid)
        if ch is None:
            raise WorkspaceError("There's nothing to publish in this conversation.")
        approved = [p for p in ch.manifest.get("order", []) if p in ch.files and ch.files[p]["status"] == "approved"]
        if not approved:
            raise WorkspaceError("Nothing is approved yet.")
        # Exactly what was decided when publishing began. An edit made while it runs (Bookwyrm can
        # keep working) changes "updated" and is kept for the next round, not cleared.
        decided = {p: f.get("updated") for p, f in ch.files.items() if f["status"] in ("approved", "rejected")}
        await self.sync()
        s = self._settings()
        writes: dict[str, str] = {}
        deletes: list[str] = []
        conflicts: list[str] = []
        for p in approved:
            f = ch.files[p]
            base = self.base_text(ch, p)
            theirs = self.read_main(p)
            if f["op"] == "delete":
                if theirs is not None and theirs != base:
                    conflicts.append(p)
                elif theirs is not None:
                    deletes.append(p)
                continue                  # (already deleted on GitHub: nothing to do)
            ours = _read(ch.new(p))
            if theirs == base:
                merged = ours
            elif base is None or theirs is None:
                merged = None          # created by someone else meanwhile, or deleted upstream
            else:
                merged = merge_text(base, ours, theirs)
            if merged is None:
                conflicts.append(p)
                continue
            writes[p] = stamp_human(merged, human_label(s), now_utc()) if wants_stamp(p) else merged
        if conflicts:
            for p in conflicts:
                ch.files[p]["status"] = "conflict"
            self._save(ch)
            self.emit({"type": "conflict", "change": cid, "paths": conflicts})
            return {"ok": False, "conflicts": conflicts,
                    "message": "Some documents changed on GitHub in ways that overlap these edits: "
                               + ", ".join(conflicts) + ". Ask Bookwyrm to redo them on the latest version."}
        if not writes and not deletes:
            self._clear(cid, decided)
            result = {"ok": True, "pr": None, "url": None, "merged": True, "title": "Nothing new",
                      "files": approved, "resolved": [], "message": "These changes are already on GitHub."}
            self.emit({"type": "published", "change": cid, **result})
            return result

        title = ch.manifest.get("title") or self._title(writes, deletes)
        person = s.caller or "someone using Bookwyrm"
        resolves = ch.manifest.get("resolves", [])
        stamp = datetime.now().strftime("%Y%m%d-%H%M")
        slug = re.sub(r"[^a-z0-9]+", "-", (title or cid).lower()).strip("-")[:40] or "change"
        body = self._pr_body(writes, deletes, ch, person, resolves)
        try:
            async with self.gh.client() as c:
                head = self.state.get("sha") or await self.gh.head(c)
                branch = await self.gh.publish(c, head=head, branch=f"bookwyrm/{slug}-{stamp}",
                                               message=f"{title}\n\nApproved-by: {person} (in Bookwyrm)",
                                               writes=writes, deletes=deletes)
                pr = await self.gh.pull_request(c, branch=branch, title=title, body=body)
                merged, why = await self.gh.merge(c, pr["number"], title)
        except httpx.HTTPError as e:
            raise WorkspaceError(f"Lost the connection to GitHub while publishing ({type(e).__name__}). "
                                 "Nothing is lost here; approve again to retry.") from e
        # From here the change is on GitHub: tidying up must not fail the publish.
        try:
            async with self.gh.client() as c:
                if merged:
                    await self.gh.delete_branch(c, branch)
                for n in resolves:
                    if merged:
                        await self.gh.comment(c, n, f"Resolved in #{pr['number']}, approved by {person} in Bookwyrm.")
                        await self.gh.close_issue(c, n)
                    else:
                        await self.gh.comment(c, n, f"A fix is waiting for review in #{pr['number']} (from {person}, via Bookwyrm).")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Published #{pr['number']}, but couldn't tidy up on GitHub: {e}")
        result = {"ok": True, "pr": pr["number"], "url": pr["html_url"], "merged": merged, "title": title,
                  "files": approved, "branch": branch, "resolved": resolves if merged else [],
                  "message": "" if merged else f"The pull request is open but GitHub wouldn't merge it: {why}"}
        ch = self._clear(cid, decided)
        ch.manifest.setdefault("history", []).append({**result, "at": time.time()})
        ch.manifest["title"] = ""
        ch.manifest["resolves"] = []
        self._save(ch)
        self.emit({"type": "published", "change": cid, **result})
        if merged:
            try:
                await self.sync()
            except WorkspaceError:
                pass
        return result

    def _clear(self, cid: str, decided: dict[str, Any]) -> Change:
        """Drop what was published or discarded, as it was when publishing began. Re-reads the
        change, so edits made meanwhile (and flags a sync set) are kept."""
        ch = self.get_change(cid)
        for p, updated in decided.items():
            f = ch.files.get(p)
            if f and f["status"] in ("approved", "rejected") and f.get("updated") == updated:
                del ch.files[p]
                (ch.new(p)).unlink(missing_ok=True)
                (ch.base(p)).unlink(missing_ok=True)
        self._save(ch)
        return ch

    @staticmethod
    def _title(writes: dict, deletes: list) -> str:
        paths = list(writes) + deletes
        if len(paths) == 1:
            name = PurePosixPath(paths[0]).stem
            return f"{'Delete' if deletes else 'Update'} {name}"
        return f"Update {len(paths)} documents"

    @staticmethod
    def _pr_body(writes: dict, deletes: list, ch: Change, person: str, resolves: list[int]) -> str:
        lines = ["## What", ""]
        lines += [f"- {'Add' if not ch.files[p].get('base_exists') else 'Edit'} `{p}`" for p in writes]
        lines += [f"- Delete `{p}`" for p in deletes]
        authors = {ch.files[p].get("by") for p in [*writes, *deletes]}
        how = ("edited directly in the Bookwyrm app" if authors == {"person"}
               else "drafted with Bookwyrm and reviewed one document at a time in its rendered preview")
        lines += ["", "## Why", "",
                  f"Approved by **{person}**, {how}, on {datetime.now().strftime('%Y-%m-%d')}. "
                  "Concepts under `knowledge/` carry a `human:` entry in `verified` for this approval."]
        if resolves:
            lines += ["", *[f"Closes #{n}" for n in resolves]]
        lines += ["", f"— Bookwyrm, on behalf of {person}"]
        return "\n".join(lines)


def _extract(tar: Path, out: Path):
    """Unpack the repo. A file this computer can't store (a name Windows refuses, or one that
    clashes by case with another on a Mac) is skipped and logged, not fatal."""
    out.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar) as t:
        for member in t:
            try:
                t.extract(member, out, filter="data")
            except (OSError, tarfile.TarError) as e:
                logger.warning(f"Skipped {member.name} from the repo download: {e}")


# ---- what Hermes is told about the workspace ------------------------------------------------------

def agent_context(conversation: str, open_document: str | None = None, preview: str | None = None) -> str:
    """Added to every run's instructions, so the workspace tools know which conversation's changes
    to use, and the agent knows what the person is looking at."""
    text = (f"\n\nWorkspace: this conversation's id is `{conversation}`. Pass it as `conversation` to every "
            "mcp_workspace tool. Your edits go into this conversation's changes and open in the person's "
            "app as a rendered preview, where they approve them; approval publishes and merges them.")
    if open_document:
        text += f" The person has `{open_document}` open in the app right now; \"this document\" means that file."
    if preview:
        text += f" They're looking at your edit to `{preview}` in the preview."
    return text


def new_conversation_id(prefix: str = "text") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"
