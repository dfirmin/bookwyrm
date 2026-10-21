"""The workspace (ADR 0008) against a fake GitHub: syncing, edits, the preview's review, publishing
(branch, commit, pull request, merge), conflicts, the human stamp, and the MCP tool server.
No network, no speech models.

    voice/.venv/bin/python tests/test_workspace.py
"""

import asyncio
import io
import json
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bookwyrm_voice import workspace_mcp  # noqa: E402
from bookwyrm_voice.config import Settings  # noqa: E402
from bookwyrm_voice.workspace import (  # noqa: E402
    Workspace, WorkspaceError, agent_context, apply_preserving, clean_path, gap_info, merge_text, stamp_human,
)

REPO = "acme/knowledge"
API = "https://api.github.test"

CONCEPT = """---
type: Policy
title: Claims Intake
okfx_team: claims
sources:
  - resource: sources/processed/intake.md
verified:
  - {by: process:archivist-verifier/1, at: 2026-10-01T10:00:00Z}
---

# Claims Intake

Claims arrive from PHMS every night.

## Owner

The claims team.
"""


class FakeGitHub:
    """Just enough of GitHub's REST API, with a real history of commits."""

    def __init__(self, files: dict[str, str]):
        self.commits: dict[str, dict[str, str]] = {}
        self.trees: dict[str, dict[str, str]] = {}
        self.branches: dict[str, str] = {}
        self.pulls: list[dict] = []
        self.comments: list[tuple[int, str]] = []
        self.closed: list[tuple[int, str]] = []
        self.issues: list[dict] = []
        self.merge_refusal: str | None = None
        self.on_merge = None          # called while a merge is in flight
        self.fail_comments = False
        self.calls: list[str] = []
        self.n = 0
        self.branches["main"] = self._commit(files)

    def _commit(self, files: dict[str, str]) -> str:
        self.n += 1
        sha = f"{self.n:040x}"
        self.commits[sha] = dict(files)
        return sha

    def push(self, changes: dict[str, str | None]):
        """Someone else commits to main."""
        files = dict(self.commits[self.branches["main"]])
        for p, t in changes.items():
            if t is None:
                files.pop(p, None)
            else:
                files[p] = t
        self.branches["main"] = self._commit(files)

    @property
    def main(self) -> dict[str, str]:
        return self.commits[self.branches["main"]]

    def tarball(self, sha: str) -> bytes:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as t:
            for p, text in self.commits[sha].items():
                data = text.encode()
                info = tarfile.TarInfo(f"acme-knowledge-{sha[:7]}/{p}")
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
        return buf.getvalue()

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix(f"/repos/{REPO}")
        m = request.method
        self.calls.append(f"{m} {path}")
        body = json.loads(request.content) if request.content else {}
        if m == "GET" and path == "":
            return httpx.Response(200, json={"default_branch": "main"})
        if m == "GET" and path == "/commits/main":
            return httpx.Response(200, text=self.branches["main"])
        if m == "GET" and path.startswith("/tarball/"):
            return httpx.Response(200, content=self.tarball(path.split("/")[-1]))
        if m == "GET" and path.startswith("/compare/"):
            old, new = path.split("/compare/")[1].split("...")
            a, b = self.commits[old], self.commits[new]
            files = []
            for p in sorted(a.keys() | b.keys()):
                if a.get(p) != b.get(p):
                    status = "added" if p not in a else "removed" if p not in b else "modified"
                    files.append({"filename": p, "status": status})
            return httpx.Response(200, json={"status": "ahead", "files": files})
        if m == "GET" and path.startswith("/contents/"):
            p = httpx.URL(request.url).path.split("/contents/", 1)[1]
            from urllib.parse import unquote
            p = unquote(p)
            text = self.commits[request.url.params["ref"]].get(p)
            return httpx.Response(404, json={}) if text is None else httpx.Response(200, content=text.encode())
        if m == "GET" and path.startswith("/git/commits/"):
            sha = path.split("/")[-1]
            return httpx.Response(200, json={"tree": {"sha": f"tree-{sha}"}})
        if m == "POST" and path == "/git/trees":
            files = dict(self.commits[body["base_tree"].removeprefix("tree-")])
            for e in body["tree"]:
                if e.get("sha", "x") is None:
                    files.pop(e["path"], None)
                else:
                    files[e["path"]] = e["content"]
            tid = f"t{len(self.trees)}"
            self.trees[tid] = files
            return httpx.Response(201, json={"sha": tid})
        if m == "POST" and path == "/git/commits":
            sha = self._commit(self.trees[body["tree"]])
            self.commits[sha + "-parent"] = {"parent": body["parents"][0]}
            return httpx.Response(201, json={"sha": sha})
        if m == "POST" and path == "/git/refs":
            name = body["ref"].removeprefix("refs/heads/")
            if name in self.branches:
                return httpx.Response(422, json={"message": "Reference already exists"})
            self.branches[name] = body["sha"]
            return httpx.Response(201, json={})
        if m == "DELETE" and path.startswith("/git/refs/heads/"):
            self.branches.pop(path.removeprefix("/git/refs/heads/"), None)
            return httpx.Response(204)
        if m == "POST" and path == "/pulls":
            pr = {"number": 100 + len(self.pulls), "html_url": f"https://github.com/{REPO}/pull/{100 + len(self.pulls)}",
                  "head": body["head"], "title": body["title"], "body": body["body"], "merged": False}
            self.pulls.append(pr)
            return httpx.Response(201, json=pr)
        if m == "PUT" and re.match(r"^/pulls/\d+/merge$", path):
            if self.merge_refusal:
                return httpx.Response(405, json={"message": self.merge_refusal})
            if self.on_merge:
                self.on_merge()
            pr = next(p for p in self.pulls if p["number"] == int(path.split("/")[2]))
            # A squash: main becomes the branch's tree on top of main.
            branch_files = self.commits[self.branches[pr["head"]]]
            self.branches["main"] = self._commit(branch_files)
            pr["merged"] = True
            return httpx.Response(200, json={"merged": True})
        if m == "POST" and re.match(r"^/issues/\d+/comments$", path):
            if self.fail_comments:
                raise httpx.ConnectError("down")
            self.comments.append((int(path.split("/")[2]), body["body"]))
            return httpx.Response(201, json={})
        if m == "PATCH" and re.match(r"^/issues/\d+$", path):
            self.closed.append((int(path.split("/")[2]), body.get("state_reason")))
            return httpx.Response(200, json={})
        if m == "GET" and path == "/issues":
            return httpx.Response(200, json=self.issues)
        return httpx.Response(404, json={"message": f"fake GitHub has no {m} {path}"})


def make(files=None, **settings):
    gh = FakeGitHub(files if files is not None else {
        "index.md": "# Index\n", "knowledge/claims/Claims Intake.md": CONCEPT,
        "knowledge/claims/Claim Header.md": "---\ntitle: Claim Header\n---\n\nLoaded from PHMS.\n",
        "contracts/target.yaml": "slug: knowledge\n", ".github/workflows/x.yml": "on: push\n",
        "sources/processed/intake.md": "Intake runs nightly from PHMS.\n",
    })
    root = Path(tempfile.mkdtemp(prefix="bw-ws-"))
    s = Settings(repo=REPO, github_token="t", name="Dee Firmin", team="Data Engineering", **settings)
    ws = Workspace(lambda: s, root=root, api=API, transport=httpx.MockTransport(gh.handler))
    return gh, ws, root


def run(coro):
    return asyncio.run(coro)


# ---- tests ----------------------------------------------------------------------------------------

def test_paths():
    assert clean_path("./knowledge\\a.md") == "knowledge/a.md"
    for bad in ("../x", "a/../../b", ".git/config", ".github/workflows/x.yml", "", "C:/x"):
        try:
            clean_path(bad)
        except WorkspaceError:
            continue
        raise AssertionError(f"{bad!r} should be refused")


def test_sync_and_read():
    gh, ws, root = make()
    try:
        r = run(ws.sync())
        assert r["sha"] == gh.branches["main"]
        assert ws.read("knowledge/claims/Claims Intake.md") == CONCEPT
        paths = ws.list_paths()
        assert "contracts/target.yaml" in paths and not any(p.startswith(".github") for p in paths)
        tree = ws.tree()
        assert [n["name"] for n in tree if n["dir"]] == ["contracts", "knowledge", "sources"]
        hits = ws.search("phms")
        assert hits["files"] == 3 and hits["total"] == 3, hits
        assert ws.search("phms", under="knowledge")["files"] == 2
        # Nothing new: no download, no compare.
        before = len(gh.calls)
        assert run(ws.sync())["changed"] == []
        assert not any("tarball" in c or "compare" in c for c in gh.calls[before:])
        # Someone else pushes: only the changed files are fetched.
        gh.push({"index.md": "# Index v2\n", "sources/processed/intake.md": None, "knowledge/new.md": "new\n"})
        r = run(ws.sync())
        assert r["changed"] == ["index.md", "knowledge/new.md", "sources/processed/intake.md"], r
        assert not any("tarball" in c for c in gh.calls[before:])
        assert ws.read("index.md") == "# Index v2\n" and not (ws.main / "sources/processed/intake.md").exists()
    finally:
        shutil.rmtree(root)


def test_edits_overlay():
    gh, ws, root = make()
    try:
        run(ws.sync())
        cid = "text-abc"
        ws.edit(cid, "knowledge/claims/Claims Intake.md", "PHMS", "KMS")
        assert "KMS" in ws.read("knowledge/claims/Claims Intake.md", cid)
        assert "PHMS" in ws.read("knowledge/claims/Claims Intake.md")          # main untouched
        ws.write(cid, "knowledge/claims/Adjusters.md", "# Adjusters\n")
        ws.delete(cid, "knowledge/claims/Claim Header.md")
        try:
            ws.read("knowledge/claims/Claim Header.md", cid)
            raise AssertionError("deleted in the change")
        except WorkspaceError:
            pass
        assert ws.search("phms", under="knowledge", change=cid)["files"] == 0
        marks = {n["name"]: n.get("mark") for n in ws.tree(cid)[1]["children"][0]["children"]}
        assert marks == {"Adjusters.md": "added", "Claim Header.md": "deleted", "Claims Intake.md": "changed"}, marks
        # An edit that doesn't match, or matches twice, is refused with a reason.
        for old in ("not there", "\n"):
            try:
                ws.edit(cid, "knowledge/claims/Adjusters.md" if old == "not there" else "knowledge/claims/Claims Intake.md", old, "x")
                raise AssertionError("should refuse")
            except WorkspaceError:
                pass
        # A new file deleted again simply disappears from the change.
        assert ws.delete(cid, "knowledge/claims/Adjusters.md")["status"] == "dropped"
        ws.move(cid, "index.md", "INDEX.md")
        s = ws.summary(ws.get_change(cid))
        assert [f["path"] for f in s["files"]] == ["knowledge/claims/Claims Intake.md", "knowledge/claims/Claim Header.md",
                                                   "INDEX.md", "index.md"], s["files"]
        assert s["counts"]["pending"] == 4
        v = ws.file_view(cid, "knowledge/claims/Claims Intake.md")
        assert "PHMS" in v["before"] and "KMS" in v["after"] and v["total"] == 4
    finally:
        shutil.rmtree(root)


def test_review_and_publish():
    gh, ws, root = make()
    try:
        run(ws.sync())
        cid = "voice-123"
        ws.edit(cid, "knowledge/claims/Claims Intake.md", "PHMS", "KMS")
        ws.edit(cid, "knowledge/claims/Claim Header.md", "PHMS", "KMS")
        ws.write(cid, "index.md", "# Index\n\n- Claims\n")
        ws.set_meta(cid, title="Replace PHMS with KMS in claims", resolves=[25])
        ws.review(cid, "approved", "knowledge/claims/Claims Intake.md")
        assert not ws.ready_to_publish(cid)
        ws.review(cid, "rejected", "index.md")
        ws.review(cid, "approved")                       # approve the rest
        assert ws.ready_to_publish(cid)
        r = run(ws.publish(cid))
        assert r["ok"] and r["merged"] and r["pr"] == 100, r
        main = gh.main
        assert "Claims arrive from KMS" in main["knowledge/claims/Claims Intake.md"]
        assert main["index.md"] == "# Index\n"           # the discarded edit isn't published
        stamped = main["knowledge/claims/Claims Intake.md"]
        assert stamped.count("by: process:archivist-verifier/1") == 1
        assert '  - {by: "human:Dee Firmin (Data Engineering)", at: ' in stamped, stamped
        assert "okfx_team: claims" in stamped and stamped.endswith("The claims team.\n")
        pr = gh.pulls[0]
        assert pr["title"] == "Replace PHMS with KMS in claims" and "Closes #25" in pr["body"] and "Dee Firmin" in pr["body"]
        assert pr["head"] not in gh.branches                   # branch deleted after merge
        assert gh.closed == [(25, "completed")] and "#100" in gh.comments[0][1]
        assert ws.get_change(cid).files == {}                  # published and discarded files cleared
        assert ws.read("knowledge/claims/Claims Intake.md") == stamped   # synced after merging
        # Not a concept: no stamp.
        ws.write(cid, "contracts/target.yaml", "slug: knowledge\nengine: v2\n")
        ws.review(cid, "approved")
        run(ws.publish(cid))
        assert gh.main["contracts/target.yaml"] == "slug: knowledge\nengine: v2\n"
    finally:
        shutil.rmtree(root)


def test_merge_refused_leaves_pr_open():
    gh, ws, root = make()
    try:
        run(ws.sync())
        gh.merge_refusal = "At least 1 approving review is required by reviewers with write access."
        ws.write("c1", "knowledge/claims/Notes.md", "# Notes\n")
        ws.set_meta("c1", resolves=[7])
        ws.review("c1", "approved")
        r = run(ws.publish("c1"))
        assert r["ok"] and not r["merged"] and "approving review" in r["message"], r
        assert gh.pulls[0]["head"] in gh.branches and gh.closed == []
        assert "waiting for review" in gh.comments[0][1]
    finally:
        shutil.rmtree(root)


def test_upstream_changes():
    gh, ws, root = make()
    try:
        run(ws.sync())
        path = "knowledge/claims/Claims Intake.md"
        # Someone else changes another part of the file: merged three ways.
        ws.edit("a", path, "PHMS", "KMS")
        gh.push({path: CONCEPT.replace("The claims team.", "The claims platform team.")})
        run(ws.sync())
        assert ws.get_change("a").files[path].get("upstream")
        ws.review("a", "approved")
        r = run(ws.publish("a"))
        assert r["ok"] and r["merged"]
        assert "from KMS" in gh.main[path] and "claims platform team" in gh.main[path]
        # Someone else changes the same line: a conflict, nothing published, and it says which file.
        current = ws.read(path)
        ws.edit("b", path, "from KMS every night", "from KMS hourly")
        gh.push({path: current.replace("from KMS every night", "from KMS twice a day")})
        ws.review("b", "approved")
        n = len(gh.pulls)
        r = run(ws.publish("b"))
        assert not r["ok"] and r["conflicts"] == [path] and len(gh.pulls) == n
        assert ws.get_change("b").files[path]["status"] == "conflict"
        try:
            ws.review("b", "approved", path)
            raise AssertionError("a conflict can't be approved as it is")
        except WorkspaceError:
            pass
        # Redoing the edit on the latest version clears it.
        ws.edit("b", path, "twice a day", "hourly")
        assert ws.get_change("b").files[path]["status"] == "pending"
        ws.review("b", "approved")
        assert run(ws.publish("b"))["merged"] and "from KMS hourly" in gh.main[path]
    finally:
        shutil.rmtree(root)


def test_publish_edge_cases():
    gh, ws, root = make({"knowledge/a.md": "---\r\ntitle: A\r\n---\r\n\r\nOne\r\nTwo\r\n", "b.md": "b\n", "c.md": "c\n", "d.md": "d\n"})
    try:
        run(ws.sync())
        # Windows line endings survive an edit and publish, with no false conflict.
        ws.edit("w", "knowledge/a.md", "Two", "Three")
        ws.review("w", "approved")
        r = run(ws.publish("w"))
        assert r["merged"] and gh.main["knowledge/a.md"].endswith("\r\nOne\r\nThree\r\n"), repr(gh.main["knowledge/a.md"])
        assert "\r\nverified:\r\n" in gh.main["knowledge/a.md"]
        # An edit Bookwyrm makes while a publish is in flight isn't lost.
        ws.write("x", "b.md", "b2\n")
        ws.review("x", "approved")
        gh.on_merge = lambda: ws.write("x", "b.md", "b3\n")
        run(ws.publish("x"))
        gh.on_merge = None
        f = ws.get_change("x").files["b.md"]
        assert f["status"] == "pending" and ws.read("b.md", "x") == "b3\n"
        # Approve all leaves a conflict alone and approves the rest.
        ws.write("y", "c.md", "c-mine\n")
        ws.write("y", "d.md", "d-mine\n")
        gh.push({"c.md": "c-theirs\n"})
        ws.review("y", "approved", "c.md")
        run(ws.sync())
        ch = ws.get_change("y")
        ch.files["c.md"]["status"] = "conflict"
        ws._save(ch)
        ws.review("y", "approved")
        assert ws.get_change("y").files["d.md"]["status"] == "approved"
        assert ws.get_change("y").files["c.md"]["status"] == "conflict"
        ws.discard("y")
        # Deleting what someone else already deleted is simply done.
        ws.delete("z", "d.md")
        gh.push({"d.md": None})
        ws.review("z", "approved")
        r = run(ws.publish("z"))
        assert r["ok"] and r["pr"] is None and ws.get_change("z").files == {}
        # GitHub going away after the merge doesn't leave the change half-published.
        gh.fail_comments = True
        ws.write("v", "b.md", "b4\n")
        ws.set_meta("v", resolves=[3])
        ws.review("v", "approved")
        r = run(ws.publish("v"))
        assert r["merged"] and ws.get_change("v").files == {} and gh.main["b.md"] == "b4\n"
    finally:
        shutil.rmtree(root)


def test_person_edit():
    gh, ws, root = make()
    try:
        run(ws.sync())
        path = "knowledge/claims/Claim Header.md"
        base = ws.read(path)
        gh.push({path: base.replace("title: Claim Header", "title: Claim Header (daily)")})   # while they type
        ws.person_edit("edit-1", path, base.replace("PHMS", "KMS"), base)
        r = run(ws.publish("edit-1"))
        assert r["merged"] and "Loaded from KMS." in gh.main[path] and "(daily)" in gh.main[path], r
        assert "edited directly in the Bookwyrm app" in gh.pulls[-1]["body"]
    finally:
        shutil.rmtree(root)


def test_stamp_formats():
    by, at = "human:Dee (Data)", "2026-10-21T12:00:00Z"
    entry = '{by: "human:Dee (Data)", at: 2026-10-21T12:00:00Z}'
    assert stamp_human("---\ntitle: A\n---\nbody\n", by, at) == f"---\ntitle: A\nverified:\n  - {entry}\n---\nbody\n"
    assert stamp_human("body\n", by, at) == f"---\nverified:\n  - {entry}\n---\n\nbody\n"
    block = "---\ntitle: A\nverified:\n  - by: process:x\n    at: 2026-01-01\ntags: [a]\n---\nbody\n"
    assert stamp_human(block, by, at) == f"---\ntitle: A\nverified:\n  - by: process:x\n    at: 2026-01-01\n  - {entry}\ntags: [a]\n---\nbody\n"
    col0 = "---\nverified:\n- {by: process:x, at: 1}\n---\n"
    assert stamp_human(col0, by, at) == f"---\nverified:\n- {{by: process:x, at: 1}}\n- {entry}\n---\n"
    inline = "---\nverified: {by: process:x, at: '2026-01-01'}\n---\n"
    out = stamp_human(inline, by, at)
    assert out.startswith("---\nverified:\n  - {by: 'process:x', at: '2026-01-01'}\n") and entry in out, out
    flow = "---\nverified: [{by: a, at: 1}, {by: b, at: 2}]\n---\n"
    assert stamp_human(flow, by, at) == f"---\nverified:\n  - {{by: a, at: 1}}\n  - {{by: b, at: 2}}\n  - {entry}\n---\n"
    multi = "---\ntitle: A\nverified: [\n  {by: a, at: 1},\n  {by: b, at: 2}\n]\ntags: [x]\n---\n"
    assert stamp_human(multi, by, at) == f"---\ntitle: A\nverified:\n  - {{by: a, at: 1}}\n  - {{by: b, at: 2}}\n  - {entry}\ntags: [x]\n---\n"
    mapping = "---\nverified:\n  by: a\n  at: 1\ntitle: A\n---\n"
    assert stamp_human(mapping, by, at) == f"---\nverified:\n  - {{by: a, at: 1}}\n  - {entry}\ntitle: A\n---\n"
    try:
        stamp_human("---\ntitle: [unclosed\n---\n", by, at)
        raise AssertionError("broken frontmatter should be refused")
    except WorkspaceError:
        pass
    crlf = "---\r\ntitle: A\r\n---\r\nbody\r\n"
    assert stamp_human(crlf, by, at) == f"---\r\ntitle: A\r\nverified:\r\n  - {entry}\r\n---\r\nbody\r\n"
    # The result still parses, and the old entries are kept.
    import yaml
    data = yaml.safe_load(stamp_human(block, by, at).split("---")[1])
    assert [v["by"] for v in data["verified"]] == ["process:x", "human:Dee (Data)"]


def test_merge_text():
    base = "a\nb\nc\nd\n"
    assert merge_text(base, "A\nb\nc\nd\n", "a\nb\nc\nD\n") == "A\nb\nc\nD\n"
    assert merge_text(base, "a\nX\nc\nd\n", "a\nY\nc\nd\n") is None


def test_editor_saves_change_only_what_was_edited():
    original = ("# Runbook\n\n<!-- owner: platform -->\n* Step one\n* Step two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n"
                "| 3 | 4 |\n\nText __bold__.\n")
    # What the editor makes of it: different bullets, padded tables, its own bold, the comment gone.
    normal = "# Runbook\n\n- Step one\n- Step two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nText **bold**.\n"
    assert apply_preserving(original, normal, normal) == original
    edited = normal.replace("- Step two", "- Step two, carefully").replace("| 3 | 4 |", "| 3 | 5 |")
    out = apply_preserving(original, normal, edited)
    assert out == original.replace("* Step two", "- Step two, carefully").replace("| 3 | 4 |", "| 3 | 5 |"), out
    added = normal.replace("Text **bold**.\n", "Text **bold**.\n\nA new line.\n")
    assert apply_preserving(original, normal, added) == original + "\nA new line.\n"
    # Lines the editor renumbers or rewrites, then the person edits or deletes: never duplicated.
    lst = "1. alpha\n1. beta\n1. gamma\n"
    assert apply_preserving(lst, "1. alpha\n2. beta\n3. gamma\n", "1. alpha\n2. BETA\n3. gamma\n") == "1. alpha\n2. BETA\n3. gamma\n"
    assert apply_preserving(lst, "1. alpha\n2. beta\n3. gamma\n", "1. alpha\n2. gamma\n") == "1. alpha\n2. gamma\n"
    setext = "Title\n=====\n\nText\n"
    assert apply_preserving(setext, "# Title\n\nText\n", "# New Title\n\nText\n") == "# New Title\n\nText\n"
    assert apply_preserving(setext, "# Title\n\nText\n", "# Title\n\nMore text\n") == "Title\n=====\n\nMore text\n"
    assert apply_preserving("a\nb", "a\nb\n", "a\nb\nc\n") == "a\nb\nc\n"


def test_gap_info():
    issue = {"number": 25, "title": "[platform] Post-Incident Review — missing_section", "html_url": "u",
             "labels": [{"name": "policy"}, {"name": "platform"}], "assignees": [],
             "body": "## Concept\nknowledge/policies/Post-Incident Review.md\nTitle: Post-Incident Review\n\n"
                     "## Gap (documentation)\nmissing_section\nThe Purpose section is a stub.\n\n## Routing\nOwner: x\n"}
    g = gap_info(issue)
    assert g["concept"] == "knowledge/policies/Post-Incident Review.md"
    assert g["team"] == "platform" and g["kind"] == "missing section" and g["concept_title"] == "Post-Incident Review"
    assert g["detail"] == "The Purpose section is a stub."


def test_agent_context():
    t = agent_context("text-1", "knowledge/a.md")
    assert "`text-1`" in t and "knowledge/a.md" in t


def test_mcp_server():
    seen = []

    def svc(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.content))
        if request.url.path == "/api/ws/changes/c1/edit":
            return httpx.Response(200, json={"path": "knowledge/a.md", "replaced": 3, "status": "pending"})
        if request.url.path == "/api/ws/tree":
            return httpx.Response(200, json={"repo": REPO, "sha": "abcdef123", "synced": "just now", "tree": [
                {"name": "knowledge", "path": "knowledge", "dir": True, "children": [
                    {"name": "claims", "path": "knowledge/claims", "dir": True, "children": [
                        {"name": "a.md", "path": "knowledge/claims/a.md", "dir": False, "mark": "changed"}]}]},
                {"name": "index.md", "path": "index.md", "dir": False}]})
        if request.url.path == "/api/ws/file":
            return httpx.Response(400, json={"detail": "There's no x.md in acme/knowledge."})
        return httpx.Response(404, json={"detail": "nope"})

    service = workspace_mcp.Service("http://svc", transport=httpx.MockTransport(svc))
    init = workspace_mcp.handle(service, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                          "params": {"protocolVersion": "2025-06-18"}})
    assert init["result"]["protocolVersion"] == "2025-06-18" and "tools" in init["result"]["capabilities"]
    assert workspace_mcp.handle(service, {"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    names = [t["name"] for t in workspace_mcp.handle(service, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]]
    assert {"read_file", "write_file", "edit_file", "search", "change_status"} <= set(names)
    for t in workspace_mcp.TOOLS:
        assert "conversation" in t["inputSchema"]["required"], t["name"]

    def call(name, args):
        return workspace_mcp.handle(service, {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                              "params": {"name": name, "arguments": args}})["result"]

    r = call("edit_file", {"conversation": "c1", "path": "knowledge/a.md", "old": "PHMS", "new": "KMS", "replace_all": True})
    assert not r.get("isError") and "Replaced 3 occurrences" in r["content"][0]["text"]
    assert json.loads(seen[-1][2])["replace_all"] is True
    r = call("list_files", {"conversation": "c1", "path": "knowledge", "depth": 1})
    assert "claims/  (1 file)" in r["content"][0]["text"], r
    r = call("list_files", {"conversation": "c1", "depth": 3})
    assert "a.md  [changed in this conversation]" in r["content"][0]["text"], r
    r = call("read_file", {"conversation": "c1", "path": "x.md"})
    assert r["isError"] and "There's no x.md" in r["content"][0]["text"]
    r = call("read_file", {"conversation": "c1"})
    assert r["isError"] and "Missing argument" in r["content"][0]["text"]
    unknown = workspace_mcp.handle(service, {"jsonrpc": "2.0", "id": 9, "method": "resources/list"})
    assert unknown["error"]["code"] == -32601


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"FAIL {name}: {type(e).__name__}: {e}")
                import traceback
                traceback.print_exc()
    sys.exit(1 if failed else 0)
