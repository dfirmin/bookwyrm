# 0001 — Hermes runtime, GitHub MCP as the only tool surface, SQLite memory

Status: proposed, 2026-10-05. Provisional by design: each choice here is the cheapest one that
lets Bookwyrm start working on a real knowledge repo, and each names what replaces it.

## Context

Archivist issue #6 sets the direction: a librarian that repo owners, SMEs and product owners
talk to, which answers from the bundle, makes small corrections, resolves gaps and quarantined
drafts with a person, and remembers conversations so the next person benefits ("I talked to
Sam about this yesterday and we concluded…"). Archivist runs in enterprise environments:
open-source components only, no managed services.

Archivist today runs from a laptop or container; later it will run in the cloud with GitHub
Actions triggering its pipelines. Bookwyrm should not wait for that, and should not need an
Archivist-specific API to start.

## Decision

1. **Runtime: Hermes Agent, as a profile.** Bookwyrm is a Hermes profile named `bookwyrm`
   (`~/.hermes/profiles/bookwyrm/`), not a fork. This repo holds the profile template
   (`profile/`), the skills (`skills/`) and an installer. Hermes gives persistent memory, a
   SQLite session store with search, agent-created skills, model-agnostic providers (direct
   Anthropic and OpenAI-compatible gateways such as LiteLLM) and, later, messaging gateways
   (it ships a Teams platform) and local speech-to-text — the surfaces #6 wants, without
   building them.

2. **Tools: the GitHub MCP server, and nothing else.** The CLI toolset is
   `[mcp-github, skills, memory, session_search, todo, clarify]`. No terminal, file, web or
   browser tools. The MCP server's tools are allow-listed in `config.yaml`: read files and
   search code; create branches, write and delete files, open pull requests; read, comment on
   and update issues. Not merge, not repository settings, not workflow runs.

   The fences, strongest first:
   - a **fine-grained token** scoped to the one knowledge repo;
   - **branch protection** on that repo's `main` (pull request required);
   - the **allow-list** above;
   - the **rules in `SOUL.md`**: branch and pull request for every change, never `main`;
     never edit engine-owned fields (`okfx_*`, `status`, `generated`, `index.md`, `log.md`);
     never move a draft out of `quarantine/` by hand.

   Rules alone are not a fence — the token and branch protection are, so setup requires both.

3. **No engine runs in v0.** Bookwyrm does what a person with repo access does: edit files,
   open PRs, comment on issues. Where Archivist has a deterministic command Bookwyrm needs,
   the skill does the same file operations in a PR and says which command it mirrors — today
   only `archivist requeue` (two moves and a delete, ADR 0005 §5). Changes reach `knowledge/`
   through the next Archivist run, as any inbox document does.

   **Replaced by:** once Archivist runs from GitHub Actions, "run a gap pass on this concept"
   is a `workflow_dispatch` with inputs. That is one more allow-listed GitHub MCP tool
   (`actions` toolset) and one skill — still no Archivist-specific API.

4. **Memory: Hermes' defaults, per profile.** Built-in memory (`MEMORY.md`, `USER.md`) and the
   SQLite session store in the profile directory. Memory is per installation, so in v0 it is
   shared only among the people who use the same installation.

   **Replaced by:** a shared store (Postgres + pgvector — the organisation already keeps chat
   history there) with two parts: per-user conversation history, and a per-repo table of
   attributed statements (who, when, about which concept, in which conversation). That is what
   makes "I talked to Sam yesterday" work across users. Anything load-bearing still graduates
   into the repo as a source document (ADR 0002), so the bundle never depends on the memory
   store being up.

5. **Self-improvement is reviewable.** Shipped skills load through `skills.external_dirs`,
   which Hermes treats as read-only; skills Bookwyrm creates for itself land in the profile's
   own `skills/`. A learned skill worth keeping is promoted into this repo by pull request.

6. **Deployment: one installation, run by an owner.** v0 runs on the machine of whoever owns
   the knowledge repo. The direction is one always-on Bookwyrm per repo or per organisation,
   with the desktop companion, the Teams bot and voice as clients of it — so shared memory and
   always-on behaviour come from the service, not from syncing desktops.

## Consequences

- Setup has two steps outside this repo that cannot be skipped: a scoped token and branch
  protection on the knowledge repo.
- Docker is needed for the GitHub MCP server image. A desktop without Docker can use the
  server's release binary instead; only `command`/`args` change.
- A small correction is not validated by `archivist check-concept` before the PR, because
  Bookwyrm has no shell. The PR reviewer is the check in v0. A `check-concept` workflow on
  pull requests, shipped by Archivist's scaffold, is the follow-up (an Archivist issue).
- Nothing here locks in Hermes for the clients. If the runtime changes, the skills and
  `SOUL.md` are plain Markdown and move with it.
