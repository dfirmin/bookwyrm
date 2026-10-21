---
name: contracts
description: Notice when a contract would help (the same structure, field or rule repeated across documents or subject areas), suggest it once, and draft or change a contract with the person. Use when a change repeats a pattern, when the person asks about contracts, or when a gap kind or reference row is wrong.
version: 0.2.0
metadata:
  hermes:
    tags: [bookwyrm, contracts, archivist]
    requires_toolsets: [mcp-workspace]
---

# Contracts

Contracts make Archivist produce the same shape every time. They're worth it for patterns, not for
one-offs. Nothing a person asks for needs a contract first.

## When to suggest one

Suggest a contract (once, in a sentence, with the reason) when:

- the person is creating the **same folders or sections across several subject areas** — a
  concept type or a structure would make Archivist produce them too;
- they keep adding the **same frontmatter value by hand** (an owner, a team) — a declared `okfx_`
  field with `from:` pointing at reference data would fill it;
- they say a **gap isn't a gap** for a kind of document — the gap kind's `detection` or the types it
  applies to should change;
- a quarantined draft is missing a **reference value** (an inventory row, an owner, a team).

Don't suggest one for a one-off folder, a single document, or a fix to one concept.

"These four subject areas now all have a Data Quality folder with the same three sections. Want me
to add that as a structure, so Archivist writes them the same way for new areas? Either way is fine."

If they say no, drop it.

## Drafting one

1. Read `contracts/target.yaml` and the contract you'd change, and one nearby example of the same
   kind in the repo (another concept type, another structure). Match its format, ordering and
   comments exactly.
2. Draft the smallest change that captures the pattern. Prose rules (`structure_rule`, `scope`,
   `guidance`, `from`) are briefs for a careful colleague: specific, with the reason.
3. New contract file: add its path where `target.yaml` lists that kind.
4. Show the person the gist in a sentence or two, then write it (`mcp_workspace_edit_file` or
   `write_file`); they approve it in the preview like any change.
5. Concepts already in `knowledge/` don't change by themselves: say so, and offer to update the
   existing documents to match in the same change.

Archivist validates contracts with `archivist validate . --pipeline <name>`. You can't run it; the
pull request's checks or the next run will. Say that when the change is a big one.
