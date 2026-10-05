# Bookwyrm

The librarian for [Archivist](https://github.com/dfirmin/archivist) knowledge repos.

Archivist turns messy documents into a curated knowledge bundle in a git repo. Bookwyrm is the
assistant the people who own that bundle talk to — repo owners, SMEs and product owners. It
answers questions from the bundle, takes corrections, helps resolve open gaps and quarantined
drafts, and remembers what it was told so the next person who asks gets the benefit.

Bookwyrm is a **client of Archivist, not part of it.** It never runs the engine and never
writes engine-owned fields. Everything it changes goes to the knowledge repo as a pull request
that a person merges.

## What it does (v0)

| Ask | What Bookwyrm does |
|---|---|
| "What's our policy on X?" | Answers from `index.md` → the concept → its cited sources, and says when a gap is open |
| "That value is wrong, it's 90 days" | Small correction: edits the concept, opens a PR citing who said so |
| "Here's the answer to that gap" | Records the SME's statement as an attributed source document in `sources/inbox/`; the next Archivist run enriches the concept and re-judges the gap |
| "What's stuck in quarantine?" | Reads `okfx_quarantine.needs`, gets the missing contract value from the owner, opens the contract PR, then the requeue PR |
| "Here's the transcript from today's call" | Drops it in `sources/inbox/`; Archivist's extractor (ADR 0006) splits it by topic |

Why SME answers go in as sources rather than straight into the concept: Archivist's rule is
that a concept body restates its sources and adds nothing to them. A source note keeps that
true, keeps who-said-what auditable, and lets the engine's verifier, gap and scoring stages run
on the new content. See [ADR 0002](docs/adr/0002-sme-statements-enter-as-sources.md).

Not in v0: the Teams bot, a meeting bot, the desktop mascot and voice, Postgres memory, and
dispatching Archivist runs. Each can attach later without changing the core (see
[ADR 0001](docs/adr/0001-hermes-runtime-github-tools-sqlite-memory.md)).

## How it's built

- **Runtime:** [Hermes Agent](https://github.com/NousResearch/hermes-agent), as a Hermes
  *profile* named `bookwyrm`. Model-agnostic: direct Anthropic, or any OpenAI-compatible
  endpoint such as a LiteLLM gateway.
- **Tools:** the [GitHub MCP server](https://github.com/github/github-mcp-server), limited to
  reading the repo, branches, file writes, pull requests and issues. No terminal, no local file
  access, no web.
- **Behaviour:** `profile/SOUL.md` (who Bookwyrm is and its hard rules) and the skills in
  `skills/` (one per job above). Shipped skills are read-only to the agent; skills it learns
  on its own land in the profile and are promoted here by pull request.
- **Memory:** Hermes' built-in memory and SQLite session store, per profile.

## Setup

Requirements: Python 3.11+, Docker or the GitHub MCP server's release binary (see below), and
Hermes Agent installed so `hermes` is on your PATH.

1. **Protect the knowledge repo's `main`.** Require a pull request before merging. Bookwyrm's
   rules say it only works through PRs; branch protection is what makes that true.
2. **Create a fine-grained GitHub token** scoped to *only* the knowledge repo, with
   Contents, Issues and Pull requests set to read and write. The token is the real fence on
   what Bookwyrm can touch.
3. **Install the profile:**

   ```bash
   ./scripts/install.sh --repo dfirmin/archivist-knowledge-01
   ```

   This creates the `bookwyrm` Hermes profile (and a `bookwyrm` command), points it at this
   repo's `skills/`, and writes the target repo into `SOUL.md`.
4. **Add secrets** to `~/.hermes/profiles/bookwyrm/.env` (template: `profile/.env.example`):
   `GITHUB_PERSONAL_ACCESS_TOKEN`, plus `ANTHROPIC_API_KEY` or your gateway key.
5. **Pick a model:** edit `model:` in `~/.hermes/profiles/bookwyrm/config.yaml` — direct
   Anthropic is the default; the LiteLLM block is there commented out.
6. **Check the GitHub tools connect:**

   ```bash
   hermes -p bookwyrm mcp test github
   ```

   It should list the server's tools. If it says the `mcp` Python SDK is not installed, run
   `hermes setup` and turn on MCP support (Hermes keeps it optional), then test again. Without
   it Bookwyrm still starts, but with no GitHub tools: it will tell you it can't reach the repo.
7. **Talk to it:**

   ```bash
   bookwyrm chat
   ```

   At startup Hermes may print `Warning: Unknown toolsets: mcp-github`. That is a start-up
   ordering message (the toolset is named before the MCP server has connected); the tools are
   there once the server connects. `mcp test github` above is the real check.

Re-run `install.sh` after pulling changes to `profile/`; it keeps your `.env` and memory.

**No Docker?** Use the GitHub MCP server's release binary
([releases](https://github.com/github/github-mcp-server/releases)) and pass its path to the
installer, which wires it in place of Docker (and keeps doing so on every re-run):

```bash
./scripts/install.sh --repo dfirmin/archivist-knowledge-01 --github-mcp-bin ~/bin/github-mcp-server
```

## Layout

```
profile/            Hermes profile template: config.yaml, SOUL.md, .env.example
skills/             Bookwyrm's skills (loaded read-only via skills.external_dirs)
scripts/install.sh  Creates or refreshes the bookwyrm profile
docs/adr/           Decisions
```
