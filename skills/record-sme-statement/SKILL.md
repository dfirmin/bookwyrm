---
name: record-sme-statement
description: Keep what a person tells you as an attributed source note in sources/inbox/, so Archivist can cite it. Use when the person wants their statement on record as a source, alongside or instead of editing the concept directly.
version: 0.2.0
metadata:
  hermes:
    tags: [bookwyrm, sme, source, inbox]
    requires_toolsets: [mcp-workspace]
---

# Recording what a person tells you as a source

Editing the concept directly is the default (skill `edit-documents`). A source note is the extra
step for when the person wants it: Archivist's concepts cite sources, so a note means the knowledge
is cited, the next run's verifier keeps it, and who-said-what is in the repo, not only in a pull
request. Offer it once when someone supplies knowledge the sources don't have; do it when they say
yes, or when they ask for it.

## 1. Know who is speaking

A name and a team or role. The app usually tells you; if not, ask.

## 2. Get the statement in their words

Values, rules, exceptions, who to contact. Quote what they said. You may drop filler ("um", "so
basically"); don't reword or add to it. If they correct themselves, quote both, in order.

## 3. Write the note

Path: `sources/inbox/sme-<YYYY-MM-DD>-<slug>.md`, with `mcp_workspace_write_file`:

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

The "About" line is how Archivist's intake finds the concept: name it, its owning team and, for
identity-keyed types (`identity` in `contracts/concept-types.yaml`), the identity values.

It shows up in their preview like any change; they approve it there. If you also edited the
concept, both go in the same change.

Remember the conclusion and who gave it, so you can tell the next person who asks.
