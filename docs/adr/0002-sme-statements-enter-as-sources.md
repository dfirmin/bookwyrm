# 0002 — What a person tells Bookwyrm enters the bundle as a source, not as concept text

Status: proposed, 2026-10-05.

## Context

The most valuable thing Bookwyrm hears is an owner or SME supplying knowledge the bundle lacks:
the answer to an open gap ("escalate to the security on-call, #sec-oncall"), a missing value,
the rule behind a view. The obvious move is to write that answer into the concept. Three
things in Archivist say no:

- **Grounding.** A concept body restates its sources and adds nothing to them
  (*document-structure* §3). Text with no source behind it breaks the one property that makes
  the bundle trustworthy.
- **Engine-owned stages.** Verification, gap verdicts (`okfx_gaps`, written only through
  `record-gap`) and confidence (`okfx_confidence`) are engine judgements. A hand-filled section
  would sit beside a stale `missing_section` verdict and a stale score until someone reran the
  engine — and nothing would tell them to.
- **Who said it.** "Bookwyrm changed this" is not provenance. "Daniel Okafor, Finance
  Operations, said this on 2026-10-05" is.

Archivist already has the path for new knowledge about an existing concept: an inbox document
that identity placement (ADR 0005) matches to the concept, which the author ENRICHes, the
verifier checks, the gap fleet re-judges and the scorer re-scores; the gap's issue closes when
its verdict clears (ADR 0004 §7). On the handbook target this is exactly a `policy-amendment`.

## Decision

1. **Substantive knowledge becomes a source note.** When a person supplies content — a gap
   answer, a missing section, a rule, a correction that changes meaning — Bookwyrm writes it to
   `sources/inbox/sme-<YYYY-MM-DD>-<slug>.md` in a pull request, and does not touch the
   concept. The next Archivist run does the rest.

   ```markdown
   ---
   title: "Expense Policy — travel meal cap (SME statement)"
   about: knowledge/policies/expense-policy.md
   stated_by: "Daniel Okafor, Finance Operations"
   recorded_by: "Bookwyrm, in conversation with Daniel Okafor"
   recorded_on: 2026-10-05
   resolves: "Expense Policy — missing_section"   # the gap issue title, when there is one
   ---

   About: the travel meal cap in the Expense Policy. Finance Operations owns this policy.

   > Daniel Okafor: The travel meal cap is $75 a day from November 1. It was $60.
   > Daniel Okafor: Contractors are not covered; they follow their contracts.
   ```

   The rules mirror Archivist's transcript extracts (ADR 0006): the body **quotes** what the
   person said — tidied of filler only, never reworded — under a one-line "About" that names
   the concept, its owning team and, for identity-keyed types, the identity values (for example
   the physical view names), so intake scope and placement find it. Before opening the PR,
   Bookwyrm shows the person the note and gets their confirmation that it says what they meant.

2. **Small corrections edit the concept directly.** A typo, a broken link, a formatting fault,
   or a value that the concept's own cited sources already support but the concept got wrong.
   The test: a reviewer can check the fix against what the concept already cites. Bookwyrm
   edits the body only, never frontmatter it does not own (see the rules in `SOUL.md`), and the
   PR body says who asked and why. Anything that needs a new source to be true is a source note
   instead.

3. **Gap issues are commented on, not closed.** Bookwyrm comments on the gap issue with the PR
   link. The engine closes the issue when its re-judged verdict clears. If an owner says the gap
   is not a gap (the kind does not apply), that is a contract question: Bookwyrm records it on
   the issue and, if asked, proposes the `gap-kinds.yaml` change as its own PR.

4. **Memory keeps the conversation; the repo keeps the conclusion.** The conversation that
   produced a note stays in Bookwyrm's memory. The note is what other people, other agents and
   the engine see.

## Consequences

- New knowledge from a conversation reaches `knowledge/` one Archivist run later, not at merge.
  That is the cost of keeping verification, gaps and scores honest.
- `sources/processed/` accumulates SME notes alongside emails and transcripts, each cited by
  the concepts it informed — the audit trail for "who told us this".
- Bookwyrm needs no write access to engine-owned fields, which keeps ADR 0004's write fence
  meaningful.
- If Archivist ever wants a first-class class for these notes (an intake class such as
  `sme-statement`, `mode: enrich-only`), the note format above is the starting point. Until a
  target's intake contract would route them wrongly, the existing classes do: an amendment to a
  policy is already `policy-amendment`.
