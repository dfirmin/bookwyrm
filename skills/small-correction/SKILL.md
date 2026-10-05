---
name: small-correction
description: Fix a small mistake in a concept body — typo, broken link, formatting, or a value its own cited sources already support — as a pull request. Anything needing a new source is a source note instead.
version: 0.1.0
metadata:
  hermes:
    tags: [bookwyrm, correction, edit]
    requires_toolsets: [mcp-github]
---

# Small correction

## Is it small?

It is a small correction when a reviewer can check the fix against what the concept **already
cites**:

- typo, grammar, broken Markdown, a broken or stale link;
- a value the concept states wrongly when its cited source says otherwise (open the source in
  `sources/processed/` and confirm it before editing);
- a heading in the wrong place, a duplicated sentence.

It is **not** small — use skill `record-sme-statement` — when the fix needs something the cited
sources don't say: a new value, a new rule, a missing section, "that's out of date, it's 90 days
now". The person may be right; it still needs a source.

When unsure, it is not small.

## Make it

1. Read the concept from `main`. Find the exact lines.
2. Show the person the before and after for those lines. Get a yes.
3. Change the **body only**. Never touch frontmatter except fixing a typo in `title` or
   `description` — and never any `okfx_*` field, `status`, `generated` or `sources`.
4. Follow skill `repo-changes` (branch `bookwyrm/fix-<concept-slug>`). In "Checks for the
   reviewer", name the cited source that supports the fix and the line in it.
