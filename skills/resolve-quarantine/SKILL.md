---
name: resolve-quarantine
description: Clear a draft in quarantine/ with its owner — read what it needs, get the contract fix by PR, then requeue it by PR (mirrors `archivist requeue`). Use for "what's in quarantine" or any `Quarantined:` issue.
version: 0.1.0
metadata:
  hermes:
    tags: [bookwyrm, quarantine, contracts, requeue]
    requires_toolsets: [mcp-github]
---

# Resolving quarantine

A draft is in `quarantine/` because the engine could not place it in `knowledge/` (Archivist
ADR 0005). Its frontmatter says why:

- `okfx_quarantine.reason` — what stopped it;
- `okfx_quarantine.needs` — what would resolve it, written for the owner;
- `okfx_quarantine.candidates` — existing concepts it might belong to, when that was the question.

Its source documents are in `sources/quarantine/`, listed in the draft's `sources`. It has an
open issue titled `Quarantined: <file name>`, labelled `quarantine`.

**Never move the draft into `knowledge/`**, by hand or otherwise. Resolution is always: fix
what `needs` asks, then requeue so the engine authors it properly.

## 1. List and explain

`mcp_github_list_issues` (open, label `quarantine`), or list `quarantine/` with
`mcp_github_get_file_contents`. For one draft, read it and explain `reason` and `needs` in plain
words. If it has `candidates`, read them and tell the person how they differ.

## 2. Decide with the owner

| The owner says | You do |
|---|---|
| It belongs in the bundle; here is the missing thing (an inventory row, an owner, a team) | Step 3, then step 4 |
| It belongs to candidate X / it is a new concept, and the grouping rule should say so | Step 3 with a `grouping` or identity change, then step 4 |
| It should never be knowledge | Step 5 |
| Not sure / someone else owns it | Comment on the issue naming who to ask. Stop. |

## 3. Contract PR

The fix is almost always in `contracts/`: a row in a reference file under `contracts/reference/`
(for example `inventory.csv`, `owners.yaml`, `teams.yaml`), or a sharper `grouping` rule in
`contracts/intake.yaml`. Read the file, keep its format and ordering exactly, and add or change
only what `needs` asks. Show the person the diff and get a yes.

Open it with skill `repo-changes` (branch `bookwyrm/contract-<slug>`). Comment on the
`Quarantined:` issue with the link. **Stop here until that PR is merged** — requeuing before the
contract changes just quarantines the draft again.

## 4. Requeue PR (after the contract PR is merged)

This is exactly what `archivist requeue quarantine/<file>.md` does, as a pull request. Check
first, then do it:

1. Read the draft on `main`. Confirm `status: quarantined` and that every entry in `sources`
   has a `resource` directly under `sources/quarantine/`. If not, stop and tell the person.
2. For each resource, confirm `sources/inbox/<same file name>` does not exist. If it does,
   stop: there is a clash a person must resolve.
3. Branch `bookwyrm/requeue-<draft-slug>`. For each resource: read its content and write it to
   `sources/inbox/<file name>` (`mcp_github_push_files`, all in one commit), then
   `mcp_github_delete_file` the original under `sources/quarantine/`. Then delete the draft.
   If a source is not a text file, do not attempt it: ask someone to run
   `archivist requeue quarantine/<file>.md` instead.
4. Open the PR. Title `Requeue quarantine/<file>.md`; in the body name the contract PR that
   resolved the need. Comment on the issue: "requeued; the next Archivist run authors it and
   closes this issue."

## 5. Never knowledge

If the owner says the document should not become knowledge: one PR deleting the draft and its
documents in `sources/quarantine/`, with the owner's reason in the body. Comment on the issue
with the PR link and ask the owner to close the issue once it merges (this is the one case the
engine will not close it).
