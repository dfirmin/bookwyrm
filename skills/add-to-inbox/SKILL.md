---
name: add-to-inbox
description: Put a document someone hands you — pasted text, an email, notes, a meeting transcript — into sources/inbox/ for Archivist's next run. Use when the person gives you a document to be processed, or a big batch that suits Archivist.
version: 0.2.0
metadata:
  hermes:
    tags: [bookwyrm, inbox, intake, transcript]
    requires_toolsets: [mcp-workspace]
---

# Adding a document to the inbox

Archivist takes documents as they are; messy is fine. Don't clean, summarise or restructure: the
engine's value is doing that well, and a cleaned copy loses what the original said.

If the person wants what's in the document **in the bundle now**, you can also edit the concept
directly (skill `edit-documents`) in the same change; ask which they'd like when it isn't obvious.

1. **Text only.** You can add Markdown or plain text the person pastes or describes. For a file
   (PDF, Word), ask them to paste the text.
2. **Scope.** Read `contracts/intake.yaml` (`scope`, `classes`). If the document is clearly out of
   scope — its owning team isn't in the reference data, say — tell them once that Archivist will
   quarantine it and what would fix that. Add it anyway if they want.
3. **Name it** `sources/inbox/<YYYY-MM-DD>-<slug>.md` (`.txt` for plain text that isn't
   Markdown). Check the name is free (`mcp_workspace_list_files` on `sources/inbox`).
4. **Write it verbatim** (`mcp_workspace_write_file`). If the document has no line saying where it
   came from, add one at the top: `Added by Bookwyrm for <person>, <date>. Original: <where it came
   from>.` Nothing else.
5. **Transcripts** go in the same way. If the intake contract has a class with `mode: extract`
   (Archivist ADR 0006), Archivist splits the transcript into topic extracts itself. If not, tell
   them it'll be treated as one document, and offer to put the parts they care about into the
   concepts directly instead.
6. They approve it in the preview. It's processed on Archivist's next run.
