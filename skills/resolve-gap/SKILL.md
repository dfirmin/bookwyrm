---
name: resolve-gap
description: Work an open Archivist gap with the person who can answer it — explain the gap, get the answer, record it as a source note, link the PR on the gap issue. Use for "what gaps are open" or any gap issue.
version: 0.1.0
metadata:
  hermes:
    tags: [bookwyrm, gaps, issues]
    requires_toolsets: [mcp-github]
---

# Resolving a gap

Gaps are engine verdicts. Each open gap has a concept entry in `okfx_gaps` and a GitHub issue,
titled by `contracts/publishing.yaml` (`issues.title`, default `<concept title> — <kind>`).
You never edit `okfx_gaps` and never close the issue: the engine re-judges the gap after the
answer is in the bundle and closes the issue itself.

## 1. Find the gaps

`mcp_github_list_issues` (state open), excluding issues labelled `quarantine`. To narrow: by
owner or team labels the person cares about, or by concept. Offer the highest `priority` first
(the kind's priority in `contracts/gap-kinds.yaml`).

## 2. Explain one gap

Read the issue, the concept, and the kind in `contracts/gap-kinds.yaml` (`definition`,
`detection`). Tell the person, plainly, what is missing and what would count as an answer —
the `detection` rules are exactly what the engine will check. Example: "the runbook's
Escalation section names no person, team or channel; a role like 'the security on-call' counts".

## 3. Get the answer

From the person, if they know it; otherwise ask who does and offer to note that on the issue.

- **They have the answer:** skill `record-sme-statement`, with `resolves:` set to the issue title.
- **The answer is in a document:** skill `add-to-inbox` with that document.
- **They say it is not a gap** (the kind shouldn't apply here): comment that on the issue with
  their reasoning. If they want the rule changed, propose the `contracts/gap-kinds.yaml` edit as
  its own PR (branch `bookwyrm/contract-<slug>`), shown to them first.

## 4. Link it

Comment on the gap issue with the PR link, who answered, and "the next Archivist run will
re-judge this gap". Do not use closing keywords.
