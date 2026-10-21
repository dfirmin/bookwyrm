# 0008 — Full authoring through a local workspace, approved in a rendered preview

Status: proposed, 2026-10-21. Supersedes the gating parts of [0001](0001-hermes-runtime-github-tools-sqlite-memory.md)
(§2 the tool surface, §3 "small corrections only") and [0002](0002-sme-statements-enter-as-sources.md)
(§1–2, source notes as the only way in). Issue #13; the Archivist side is archivist#25.

## Context

Bookwyrm only allowed small corrections. Anything bigger became a source note for Archivist's next
run, or the person was pointed to Archivist. In use, that gated the people who own the knowledge
from keeping it current, which is the point of the bundle. The split between the two tools should
be by workload, not by permission:

- **Archivist** is for large autonomous batches, such as a hundred inbox documents worked through
  the contracts.
- **Bookwyrm** is for anything a person wants to do interactively: fix, rewrite, add sections or
  documents or folders, move, delete, or sweep one change across many documents ("replace PHMS with
  KMS everywhere under claims").

People should never need to open GitHub to do any of this.

## Decision

1. **Bookwyrm can change anything; it suggests and never gates.** `SOUL.md` drops the hard rules
   (no direct knowledge edits, no engine fields, never move quarantine, never close issues). One
   principle replaces them: the person decides. When there's a better way (a contract, a source note
   so Archivist can cite it, leaving an engine field alone), Bookwyrm says so once, then does what
   the person chose. Skills: `edit-documents` (any change, including sweeps) and `knowledge-repo`
   (how an Archivist repo works) are new. `contracts` suggests a contract when a pattern repeats and
   drafts it on request. `small-correction` and `repo-changes` are gone; the others are rewritten
   without the gates.

2. **A local workspace, synced without git.** The voice service (it is really the app's local
   service now) keeps a copy of the repo's default branch in `~/.bookwyrm/workspace/<owner>__<repo>/main`.
   It downloads a tarball the first time, then only the files a compare says changed. It syncs at
   start, every few minutes (Settings, default 3), and before an edit begins if the last check was
   more than 30 seconds ago. It uses only the GitHub REST API and the token Bookwyrm already has, so
   no git install is needed on Mac or Windows. Search over the copy is local, fast and offline.

3. **Changes are overlays, per conversation.** An edit lands in `changes/<conversation>/new/<path>`.
   The file as it was when first touched is kept in `base/<path>`. Reads and searches in that
   conversation see its own unpublished edits. Each file is `pending` until the person approves or
   discards it.

4. **Bookwyrm's tools are its own MCP server.** `bookwyrm_voice.workspace_mcp` (stdio, about 100
   lines of JSON-RPC, no SDK) holds no state. It calls the local service:
   - `list_files`, `read_file`, `search`
   - `write_file`, `edit_file`, `delete_file`, `move_file`
   - `show_document`, `describe_change`, `change_status`, `discard`

   The conversation id is passed in each run's instructions. The GitHub MCP server keeps issues and
   pull-request reading. Its file, branch and pull-request writing tools are removed, so there is
   no way for the agent to publish without the person.

5. **The person approves in a rendered preview; approving publishes.** Edits appear live in the
   window's document pane:
   - Markdown is rendered, never shown raw.
   - Changed words are highlighted inside blocks, and removed blocks are struck through.
   - Multi-document changes are one queue, shown one document at a time ("3 of 12"), with Approve,
     Discard and Approve all.
   - When nothing is left waiting, the service publishes. It makes one branch and one commit through
     the Git Data API, opens one pull request (body: who approved it and how; `Closes #n` for linked
     gaps), merges it (squash, then merge, then rebase, whichever the repo allows), deletes the
     branch and closes linked issues with a link.
   - If branch protection refuses the merge, the pull request stays open for a reviewer and the
     person is told.

   The app opens the window when Bookwyrm edits during a call. Approving by voice is not in this
   change; the preview is the approval.

6. **Other people's changes are merged, not overwritten.** Before publishing, the copy syncs. A
   file someone else changed since Bookwyrm first touched it is merged three ways (`merge3`). If
   the edits overlap, that file becomes `conflict`. Reading it then returns GitHub's version, so the
   agent redoes its edit on top.

7. **The person can browse and edit directly.**
   - The window has a **Knowledge** tree of the repo. Opening a document renders it, and the open
     document is the conversation's context ("fix this section").
   - **Edit** opens a WYSIWYG editor (Milkdown Crepe), with frontmatter kept aside byte for byte.
   - Saving publishes at once: the person is the approver. Only the lines they changed change: the
     editor's rewrite is mapped back onto the file as written (`apply_preserving`).
   - Bookwyrm then reads the edit against the contracts and says, briefly, if anything is worth
     improving. It never undoes it.

8. **Gaps in the app.** The Gaps view lists gap issues with the concept each is about (from
   Archivist's issue body). It shows the person's own by default: issues carrying the labels they
   chose in Settings, because there is no sign-in yet. Label filters and "All" are there too. Each
   gap has:
   - **Work on it**: opens the concept and starts the conversation.
   - **Comment**, **Not applicable** (comment, then close as not planned) and **Snooze a week**.

   The robot shows the person's open-gap count.

9. **The human marker is an OKF `verified` stamp.** On publish, every changed concept under
   `knowledge/` gets `{by: "human:<Name> (<Team>)", at: <UTC>}` appended to `verified`.
   - Archivist's `check-concept` rejects undeclared frontmatter fields, so a new field would break
     every edited concept. `verified` is an OKF field the verifier already appends to, so this works
     today.
   - It means "a person stood behind this version". archivist#25 proposes that the verifier then
     neither removes unsourced content nor validates against sources older than the stamp.

## Not in this change

- Roles and sign-in: issue #13 §7 is post-MVP; the MVP runs without authentication. Until then,
  the fine-grained token and branch protection are still the fences. Short term, the people who
  approve are on the protection's bypass list; long term, a Bookwyrm GitHub App identity should be
  the only bypass actor.
- Containerising the service: §8, to be discussed again before any work.
- Voice approval ("yes, approve it" on a call).

## Consequences

- The window bundle is 2.7 MB because of the editor. It loads locally, so this is acceptable.
- Edits reach `knowledge/` at once rather than after an Archivist run. Until archivist#25 lands, the
  next run's verifier may remove what no source supports; the skills tell the person once when that
  matters, and offer a source note.
- A large knowledge repo with binary sources costs a tarball download the first time. After that,
  only changed files are fetched.
- This was tested against a fake GitHub (`voice/tests/test_workspace.py`) and live for syncing,
  search, gaps and the MCP tools. The publish calls (Git Data API, pulls, merge) need a live check
  with a real token, recorded in `docs/live-proof`.
