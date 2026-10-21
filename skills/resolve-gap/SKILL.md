---
name: resolve-gap
description: Work an open Archivist gap with the person — explain what's missing, get the answer, put it in the document (or a source note, if they prefer), and link the gap issue so it closes when the change merges. Use for "what gaps are open", a gap the person picked in the app, or any gap issue.
version: 0.2.0
metadata:
  hermes:
    tags: [bookwyrm, gaps, issues]
    requires_toolsets: [mcp-workspace, mcp-github]
---

# Resolving a gap

A gap is Archivist's verdict that a concept is missing something, filed as a GitHub issue titled
`<concept title> — <kind>` (often `[team] <title> — <kind>`). Its body starts with `## Concept`
and the concept's path, then `## Gap (<origin>)`, the kind and a description.

## 1. Find the gaps

The person usually picked one in the app (your message names the issue). Otherwise
`mcp_github_list_issues` (state open) and keep the ones titled like a gap; narrow by the labels
they care about (their team, subject area). Offer the highest priority first (the kind's
`priority` in `contracts/gap-kinds.yaml`).

## 2. Explain it

Read the issue (`mcp_github_issue_read`), the concept (`mcp_workspace_read_file`) and the kind in
`contracts/gap-kinds.yaml` (`definition`, `detection`). Show the concept in their app
(`mcp_workspace_show_document`). Say plainly what is missing and what would count as an answer:
the `detection` rule is what the next gap check looks for. "The Purpose section is a stub; one or
two sentences on why post-incident reviews exist would close it."

## 3. Resolve it, their way

- **They know the answer:** write it into the concept, in the section the structure names
  (skill `edit-documents`), in their words tidied into the document's style. Ask once whether they
  also want it kept as a source note so Archivist can cite it (skill `record-sme-statement`); if
  yes, do both in the same change.
- **The answer is in a document they have:** put the relevant part in the concept, and the document
  in `sources/inbox/` if they want Archivist to process it (skill `add-to-inbox`).
- **They don't know:** ask who does, and offer to comment that on the issue
  (`mcp_github_add_issue_comment`).
- **It isn't a gap** (the kind shouldn't apply here): say they can mark it not applicable in the
  app's Gaps list, or do it for them: comment their reasoning and close the issue as not planned
  (`mcp_github_issue_write`). If it'll keep happening, suggest the `gap-kinds.yaml` change once
  (skill `contracts`).

## 4. Link it

`mcp_workspace_describe_change` with the issue number in `resolves`. When the person approves the
change, the app merges it and closes the issue with a link. Tell them that's what will happen.
