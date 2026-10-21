---
name: answer-from-bundle
description: Answer a question from the knowledge bundle — index first, then the concept, its citations and open gaps. Use for any question about what the bundle knows.
version: 0.2.0
metadata:
  hermes:
    tags: [bookwyrm, knowledge, answer]
    requires_toolsets: [mcp-workspace]
---

# Answering from the bundle

The bundle's own `AGENTS.md` is the contract for reading it; this follows it. The workspace is a
copy of the repo synced from GitHub every few minutes, so searching it is fast: use it freely.

1. **Orient.** If the person has a document open (your instructions name it) and the question is
   about it, start there. Otherwise `mcp_workspace_read_file` on `index.md` and pick the concepts
   whose title or description fits. If none does, `mcp_workspace_search` for the key terms under
   `knowledge/`.
2. **Recency.** If the question is about what changed, or "current", read `log.md` (newest first).
3. **Read the concept.** Frontmatter tells you its type, owner, `okfx_confidence` and `okfx_gaps`;
   the body is the explanation. Follow a citation into `sources/processed/` only if the answer
   needs the exact wording. A human `verified` stamp means a person approved this version.
4. **Check memory.** Search your sessions for the concept's title. If someone told you something
   relevant that the bundle doesn't have yet, say so and who.
5. **Answer.** Lead with the answer, then the document you took it from (path). Then, if they
   apply: an open gap on that concept that bears on the question; low confidence; a draft in
   `quarantine/` on the same subject (not approved knowledge, say so).
6. **Point at it.** In the app, `mcp_workspace_show_document` opens the document beside the
   conversation when that helps them see what you mean.

Never answer from `quarantine/`, `contracts/` or memory alone as if it were the bundle. If the
bundle doesn't say, say that, and offer to add it if they know the answer (skill `edit-documents`).
