---
name: edit-documents
description: Make any change the person asks for in the knowledge repo — a fix, a rewrite, a new section or document, a new folder, a move or delete, or one change swept across many documents — through the workspace, for the person to approve in the app's preview. Use whenever the person wants something in the repo different.
version: 0.2.0
metadata:
  hermes:
    tags: [bookwyrm, edit, sweep, workspace]
    requires_toolsets: [mcp-workspace]
---

# Changing documents

The person decides what the bundle says. Your job is to make the change well, quickly, and in a
way they can check at a glance in the preview.

## 1. Understand the change

- Which documents? If they say "this document", it's the one open in their app (your
  instructions name it). For a sweep, find every document it touches first:
  `mcp_workspace_search` with the old value, narrowed with `path` (e.g. `knowledge/claims`), and
  `regex` for variants (`PHMS|P\.H\.M\.S`).
- Read each document before changing it (`mcp_workspace_read_file`).
- For a document a contract shapes, read its concept type and structure (skill
  `knowledge-repo`): a new section goes where the structure puts it; a new concept gets the type's
  frontmatter and sections.

## 2. Say what you'll do, briefly

- One small fix: just do it.
- Bigger: one sentence first ("I'll rewrite the Escalation section from what you told me").
- A sweep: say how many documents and list them (or the first few and the count), then do it
  unless they stop you. "Replace PHMS with KMS in the 14 documents under claims: Claims Intake,
  Claim Header, … — going ahead."

## 3. Make it

- Small and repeated edits: `mcp_workspace_edit_file` (exact text, `replace_all` for every
  occurrence in that file). Whole rewrites and new documents: `mcp_workspace_write_file`.
- Moves and renames: `mcp_workspace_move_file`. Deletes: `mcp_workspace_delete_file`.
- A new folder is just a file written under it. If they want an empty folder, add a short
  `README.md` saying what goes there.
- Keep frontmatter you aren't changing byte for byte. Don't add fields the concept type doesn't
  declare. Leave `verified` alone: the app stamps it when they approve.
- Write it the way the bundle writes: plain, specific, the document's existing style and headings.
- When the person gives you knowledge in their own words, use it. If it changes meaning, the pull
  request records that they said it; ask once whether they'd also like it kept as a source note
  (skill `record-sme-statement`) so Archivist can cite it. Their call.

## 4. Name it and hand it over

- `mcp_workspace_describe_change`: a short title ("Replace PHMS with KMS in claims"), and the issue
  numbers it resolves, if any.
- Tell them it's in the preview: what changed, in a sentence or two, and for a sweep how many
  documents. They approve or discard each one there, or approve all.
- On a call, keep it to one sentence: "Done, it's up on your screen to look over."

## 5. After

- `mcp_workspace_change_status` when they ask how it went, or before you change the same files
  again: it shows what's approved, discarded, in conflict, and the pull requests published.
- A conflict means someone changed that document on GitHub meanwhile in the same place. Read it
  again (that's GitHub's version now), redo your edit on it, and tell them it's ready to look at
  again.
- If they discard something and want it differently, just make the new edit.

## Suggestions, not gates

When you see something better — a contract would make this pattern repeatable (skill
`contracts`), an engine field the next Archivist run will rewrite, a source note so the change is
cited — say it in one sentence with the reason, then do what they choose. Never refuse a change to
the knowledge, and never send them to Archivist or GitHub to make it.
