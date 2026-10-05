---
name: answer-from-bundle
description: Answer a question from the knowledge bundle — index first, then the concept, its citations and open gaps. Use for any question about what the bundle knows.
version: 0.1.0
metadata:
  hermes:
    tags: [bookwyrm, knowledge, answer]
    requires_toolsets: [mcp-github]
---

# Answering from the bundle

The bundle's own `AGENTS.md` is the contract for reading it; this follows it.

1. **Orient.** `mcp_github_get_file_contents` on `index.md`. Pick the concepts whose title or
   description fits the question. If none does, `mcp_github_search_code` in the repo for the key
   terms under `knowledge/`.
2. **Recency.** If the question is about what changed, or "current", read `log.md` (newest
   first).
3. **Read the concept.** Frontmatter tells you its type, owner, `okfx_confidence` and
   `okfx_gaps`; the body is the explanation. Follow a citation into `sources/processed/` only if
   the answer needs the exact wording.
4. **Check memory.** Search your sessions for the concept's title. If someone told you
   something relevant that the bundle doesn't have yet, say so and who: "Daniel told me on
   Oct 5 that the cap is $75 — that's waiting to be added (PR #18)."
5. **Answer.** Lead with the answer, then the concept you took it from (path). Then, if they
   apply:
   - an open gap on that concept that bears on the question ("the runbook has no escalation
     contact yet — gap issue #12");
   - low confidence (`okfx_confidence` band below the top band);
   - a draft in `quarantine/` on the same subject: not approved knowledge, say so.

Never answer from `quarantine/`, `contracts/` or memory alone as if it were the bundle. If the
bundle doesn't say, say that, and offer to record the answer if the person knows it
(skill `record-sme-statement`).
