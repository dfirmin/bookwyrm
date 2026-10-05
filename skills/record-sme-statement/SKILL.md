---
name: record-sme-statement
description: Turn knowledge a person gives you into an attributed source note in sources/inbox/, so the next Archivist run adds it to the right concept. Use whenever someone supplies content the bundle lacks or gets wrong.
version: 0.1.0
metadata:
  hermes:
    tags: [bookwyrm, sme, source, inbox]
    requires_toolsets: [mcp-github]
---

# Recording what a person tells you

Why a note and not an edit: a concept body only restates its sources (docs/adr/0002 in the
Bookwyrm repo). The note is the source; the engine places it on the concept, writes it in,
verifies it, re-judges gaps and re-scores.

## 1. Know who is speaking

You need a name and a team or role. If you don't have them, ask. Never record an unattributed
statement.

## 2. Find the concept it is about

Usually you already have it (the question, the gap, the quarantine draft). Otherwise find it
via `index.md`. Read its frontmatter: you need its title, its owning team (or subject area) and
— if its concept type declares `identity` in `contracts/concept-types.yaml` — its identity
values (for example `okfx_physical_views`). If there is no concept yet, the note can still go
in; name the subject and owner clearly so intake can place it.

## 3. Get the statement in their words

Ask until you have the knowledge itself, stated plainly: values, rules, exceptions, who to
contact. Quote what they said. You may drop filler ("um", "so basically"); you may not reword,
summarise or add to it. If they correct themselves, quote both, in order.

## 4. Write the note

Path: `sources/inbox/sme-<YYYY-MM-DD>-<slug>.md`.

```markdown
---
title: "<Concept title> — <topic> (SME statement)"
about: <knowledge/... path, or omit when there is no concept yet>
stated_by: "<Name>, <team or role>"
recorded_by: "Bookwyrm, in conversation with <Name>"
recorded_on: <YYYY-MM-DD>
resolves: "<gap issue title>"     # only when it answers a gap
---

About: <one line naming the concept, its owning team, and identity values if any>.

> <Name>: <their words>
> <Name>: <their words>
```

Read the full note back to the person. Write it only after they confirm it says what they mean.

## 5. Open the PR

Follow skill `repo-changes`, branch `bookwyrm/note-<slug>`. Tell the person: once the PR is
merged, the next Archivist run adds it to the concept; until then the bundle doesn't say it.

Remember the conclusion, who gave it and the PR number, so you can tell the next person who
asks.
