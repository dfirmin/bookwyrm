---
name: repo-changes
description: How Bookwyrm changes the knowledge repo — branch, write, pull request, link the issue. Read before the first change in a session.
version: 0.1.0
metadata:
  hermes:
    tags: [bookwyrm, github, pull-request]
    requires_toolsets: [mcp-github]
---

# Changing the knowledge repo

Every change Bookwyrm makes is one pull request with one purpose. Never write to `main`.

## 1. Check you are not repeating someone

`mcp_github_list_pull_requests` (state open). If an open PR already makes this change, point
the person to it instead of opening another.

## 2. Branch

`mcp_github_create_branch` from `main`, named for the job:

| Job | Branch |
|---|---|
| small correction | `bookwyrm/fix-<concept-slug>` |
| SME source note | `bookwyrm/note-<slug>` |
| document for the inbox | `bookwyrm/inbox-<slug>` |
| contract change | `bookwyrm/contract-<slug>` |
| requeue | `bookwyrm/requeue-<draft-slug>` |

If the name is taken, add `-2`, `-3`.

## 3. Write

- One file: `mcp_github_create_or_update_file` with `branch` set. To update an existing file
  you need its current `sha` from `mcp_github_get_file_contents` on that branch.
- Several files in one commit: `mcp_github_push_files`.
- Deletes (requeue only): `mcp_github_delete_file`.

Always pass `branch`. If a write call has no branch, do not make it.

Before writing, re-read the file from `main` so you edit what is there now, and change only the
lines the job needs. Keep frontmatter byte-for-byte except fields the skill says you may change.

Commit message: one line saying what and for whom, e.g.
`Fix return window in Remote Work Policy (per Priya Raman)`.

## 4. Pull request

`mcp_github_create_pull_request`, base `main`. Body:

```markdown
## What
<one or two sentences>

## Why
<who asked, when, and what they said — quote them briefly>

## Checks for the reviewer
- <what to compare against: the cited source, the issue, the contract>

<if an issue: "Related: #<n>" — never "Closes #<n>">

— Bookwyrm, on behalf of <person>
```

Never write "Closes", "Fixes" or "Resolves" with an issue number: those keywords close the issue
on merge, and gap and quarantine issues close only when the engine resolves them.

## 5. Link and report

If there is a related issue, `mcp_github_add_issue_comment` with the PR link and one line of
context. Then tell the person the PR link and what happens next (a reviewer merges it; for
source notes and requeues, the next Archivist run picks it up).
