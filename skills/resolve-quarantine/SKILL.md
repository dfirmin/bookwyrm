---
name: resolve-quarantine
description: Clear a draft in quarantine/ with its owner — explain why Archivist couldn't place it, then fix what it needs and requeue it, or place it by hand, or drop it, as the owner chooses. Use for "what's in quarantine" or any `Quarantined:` issue.
version: 0.2.0
metadata:
  hermes:
    tags: [bookwyrm, quarantine, contracts, requeue]
    requires_toolsets: [mcp-workspace, mcp-github]
---

# Resolving quarantine

A draft is in `quarantine/` because Archivist couldn't place it in `knowledge/` (Archivist ADR
0005). Its frontmatter says why:

- `okfx_quarantine.reason` — what stopped it;
- `okfx_quarantine.needs` — what would resolve it, written for the owner;
- `okfx_quarantine.candidates` — existing concepts it might belong to, when that was the question.

Its source documents are in `sources/quarantine/`, listed in the draft's `sources`. It has an open
issue titled `Quarantined: <file name>`, labelled `quarantine`.

## 1. Explain it

Read the draft, show it in their app (`mcp_workspace_show_document`), and explain `reason` and
`needs` in plain words. If it has `candidates`, read them and say how they differ.

## 2. The owner chooses

| They want | You do (all in one change unless they say otherwise) |
|---|---|
| Archivist to place it properly | Make the fix `needs` names — usually a row in `contracts/reference/…` or a sharper rule in `contracts/intake.yaml` — and **requeue** (step 3) |
| It placed now, by hand | Move the draft to where it belongs under `knowledge/` (or merge its content into a candidate), drop `status: quarantined` and `okfx_quarantine`, and move its documents to `sources/processed/`. Mention once that Archivist would otherwise do this on its next run after a requeue, and that it may re-place it then; then do it |
| It should never be knowledge | Delete the draft and its documents in `sources/quarantine/` |
| Not sure / someone else owns it | Comment on the issue naming who to ask |

When the fix is a contract change, keep the file's format and ordering exactly (skill `contracts`).
Name the change and put the `Quarantined:` issue in `resolves` (`mcp_workspace_describe_change`):
it closes when the change merges.

## 3. Requeue

What `archivist requeue quarantine/<file>.md` does, as part of the change:

1. Every entry in the draft's `sources` should be a file directly under `sources/quarantine/`.
2. For each one, `mcp_workspace_move_file` it to `sources/inbox/<same name>`; if that name is taken,
   ask the person what to do.
3. `mcp_workspace_delete_file` the draft.

The contract fix and the requeue can go in the same change: both land in one merge, before
Archivist's next run. Tell them the next run authors the document and that its issue closes.
