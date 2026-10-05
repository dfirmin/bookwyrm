---
name: add-to-inbox
description: Put a document someone hands you — pasted text, an email, notes, a meeting transcript — into sources/inbox/ as a pull request, for the next Archivist run. Use when the person gives you a document rather than a statement.
version: 0.1.0
metadata:
  hermes:
    tags: [bookwyrm, inbox, intake, transcript]
    requires_toolsets: [mcp-github]
---

# Adding a document to the inbox

Archivist takes documents as they are; messy is fine. Don't clean, summarise or restructure:
the engine's value is doing that well, and a cleaned copy loses what the original said.

1. **Text only.** v0 can add Markdown or plain text the person pastes or describes. For a file
   (PDF, Word), ask them to paste the text or add it to `sources/inbox/` themselves.
2. **In scope?** Read `contracts/intake.yaml` (`scope`, `classes`). If the document clearly falls
   outside scope — for example its owning team isn't in the reference data — tell the person
   before adding it: the engine will quarantine it. Add it anyway if they want; quarantine is how
   they find out what contract change is needed.
3. **Name it** `sources/inbox/<YYYY-MM-DD>-<slug>.md` (`.txt` for plain text that isn't
   Markdown). Check the name is free.
4. **Write it verbatim.** If the document has no line saying where it came from, add one at the
   top: `Added by Bookwyrm for <person>, <date>. Original: <where it came from>.` Nothing else.
5. **Transcripts** go in the same way. If the target's intake contract has a class with mode
   `extract` (Archivist ADR 0006), the engine splits the transcript into topic extracts itself.
   If it has none, tell the person the transcript will be treated as one document, and offer
   skill `record-sme-statement` for the parts they care about instead.
6. Open the PR with skill `repo-changes` (branch `bookwyrm/inbox-<slug>`).
