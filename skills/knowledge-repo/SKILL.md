---
name: knowledge-repo
description: How an Archivist knowledge repo works — layout, concepts and their frontmatter, contracts, quarantine, gaps, the engine's stages and what it rewrites, and how Bookwyrm's changes reach GitHub. Read before the first change in a session.
version: 0.2.0
metadata:
  hermes:
    tags: [bookwyrm, archivist, okf, contracts, workspace]
    requires_toolsets: [mcp-workspace]
---

# How a knowledge repo works

Summarised from Archivist's own docs (its `CONTEXT.md`, `docs/contracts.md` and ADRs 0001–0012).
The repo you're on says the specifics: read its `AGENTS.md` and `contracts/target.yaml` once per
session (`mcp_workspace_read_file`).

## Layout

| Path | What it is |
|---|---|
| `index.md` | The map of the bundle, by group. Archivist writes it. |
| `log.md` | What changed, newest first. Archivist writes it. |
| `knowledge/` | The concepts: one Markdown file each, its path is its id. |
| `sources/inbox/` | Documents waiting for Archivist's next run. |
| `sources/processed/` | Documents concepts were written from (their `sources` cite these). |
| `sources/quarantine/` | Documents of drafts Archivist couldn't place. |
| `quarantine/` | Those drafts: `status: quarantined`, `okfx_quarantine: {reason, needs, candidates}`. |
| `contracts/` | The rules that shape the bundle (below). Not knowledge to answer from. |

## A concept

OKF frontmatter, then the body in sections:

- OKF fields: `type`, `title`, `description`, `tags`, `sources` (what it was written from),
  `status`, `generated` (Archivist's last authoring), `verified` (a list of `{by, at}` stamps).
- `okfx_*` fields: the target's own (declared on the concept type, e.g. `okfx_team`) and the
  engine's: `okfx_structure` (which structure it follows), `okfx_placement`, `okfx_quarantine`,
  `okfx_gaps` (open gap verdicts), `okfx_confidence` (the score).
- Archivist's `check-concept` refuses any other field. **Don't add new frontmatter fields** unless
  the concept type declares them; propose a contract change instead (skill `contracts`).
- When the person approves a change to a concept, the app appends a `verified` stamp
  `{by: "human:<Name> (<Team>)", at: <time>}`. That is how Archivist knows a person stood behind
  this version. Don't write it yourself.

## Contracts

`contracts/target.yaml` is the index: slug, pinned engine release, pipelines, and the path of every
other contract.

| Contract | Says |
|---|---|
| `concept-types.yaml` | Each kind of document: OKF `type`, path pattern, allowed structures and the rule for choosing, tags, declared `okfx_` fields (with `required` and `from`), `identity` (when two documents are the same instance) |
| `structures/*.yaml` | A document's sections in order; each owned by `author` (from sources), `enricher` (an engine method) or `placeholder`; `required: false` when optional |
| `intake.yaml` | Which inbox documents are in scope, how they group, their classes, which concept type each becomes; `mode: extract` classes split transcripts |
| `gap-kinds.yaml` | What counts as a gap, per concept type: `definition`, `detection`, `priority` |
| `scoring.yaml` | How gaps become `okfx_confidence` |
| `catalog.yaml` | How `index.md` groups concepts |
| `publishing.yaml` | How gap issues are titled, labelled and routed |
| `reference:` entries | The target's own data (owners, teams, inventories, glossaries) with `guidance` on using it |

Prose rules in contracts (`scope`, `grouping`, `structure_rule`, `from`, `guidance`) are binding on
Archivist exactly like fields. When you write one, write it as a brief to a careful colleague.

## The engine's run, and what it may rewrite

Inbox documents go through: intake (scope, class, group) → the author (places each group: update
the concept with the same identity, write a new one, or quarantine it) → the enricher → the
verifier (restores what a cited source says and the concept lost, reconciles conflicting values to
the latest source, removes what no cited source supports, then stamps `verified`) → one gap-agent
per gap kind → the scorer. Gap verdicts become GitHub issues titled `<title> — <kind>` (often
`[team] <title> — <kind>`), whose body starts `## Concept` and the concept's path; quarantined
drafts get `Quarantined: <file>` issues. The run closes an issue when its verdict clears.

So the next run on a concept can change what you changed: index and log are rebuilt, engine fields
rewritten, and today's verifier may remove text no source supports. A human `verified` stamp is the
signal for Archivist to keep a person's edit (archivist#25). Tell the person this only when it
matters for what they're doing, once.

## How your changes reach GitHub

1. Edit with `mcp_workspace_write_file` / `edit_file` / `delete_file` / `move_file`. Pass the
   conversation id from your instructions every time. Reads and searches show your unpublished
   edits.
2. Each edited document opens in the person's app, rendered, beside the conversation. The person
   approves or discards each one; "approve all" is there for sweeps.
3. When nothing is left waiting, the app publishes: one branch, one commit, one pull request,
   merged. Gap and quarantine issues named with `describe_change` are closed with a link.
4. If someone else changed a document on GitHub meanwhile, the app merges both edits. When they
   overlap, `change_status` shows a conflict: read the file again and redo the edit.
5. If the repo's branch protection won't let the merge through, the pull request stays open for a
   reviewer, and `change_status` says so.
