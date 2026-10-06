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

**Call it, or message it.** A small robot sits at the edge of your screen, quietly, in your
system's colours. Drag it wherever it's out of the way. Click it for a menu: **Call Bookwyrm**
and it rings, picks up and talks, in a natural voice with live captions, and you can cut in
whenever you like. **Send a message** to type instead. It can also call *you* when something new
lands in quarantine or a new gap is filed (off unless you switch it on). Speech is heard and
spoken on your machine; only text goes to the model. See [ADR 0003](docs/adr/0003-voice-companion.md)
and [ADR 0004](docs/adr/0004-companion-v2-window-installer.md).

<p>
  <img src="docs/img/robot.png" alt="The Bookwyrm robot at the edge of the screen" height="120">
  <img src="docs/img/call.png" alt="A call in progress: live captions as message bubbles, mute, type, open, hang up" height="320">
  <img src="docs/img/incoming.png" alt="Bookwyrm calling about a new quarantined document" height="320">
</p>

**Open Bookwyrm** for the full window: every call and conversation (pick one up again by text
or by voice), the **Library** of what needs you in the repo (quarantined drafts, gaps, open pull
requests, each with *Ask Bookwyrm*), and **Settings** (your name and team, the repo, keys, voice,
calls, open at login). Quit any time from the robot's menu or the menu-bar / tray icon.

<p>
  <img src="docs/img/window-library.png" alt="The Library: quarantine, gaps and pull requests" width="49%">
  <img src="docs/img/window-chat-dark.png" alt="A call, saved in the conversation history (dark mode)" width="49%">
</p>

Not yet: the Teams bot, a meeting bot, Postgres memory, and dispatching Archivist runs. Each can
attach later without changing the core (see
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

Before you start, have two things ready:

- **An Anthropic API key** ([console.anthropic.com](https://console.anthropic.com/settings/keys)).
- **A fine-grained GitHub token** ([make one](https://github.com/settings/personal-access-tokens/new))
  that can reach *only* the knowledge repo, with Contents, Issues and Pull requests set to
  read and write. The token is the real fence on what Bookwyrm can touch.

Then run one line. **macOS or Linux** (Terminal):

```bash
curl -fsSL https://raw.githubusercontent.com/dfirmin/bookwyrm/main/install.sh | bash
```

**Windows 10/11** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/dfirmin/bookwyrm/main/install.ps1 | iex
```

A setup wizard asks for your name, team, knowledge repo and the two keys (it checks them as you
go), then installs everything with a checklist: Hermes Agent, the GitHub MCP server, the
`bookwyrm` Hermes profile, Hermes' local API, the voice service and its speech models (about
1 GB, once), and the companion app, which it adds to Applications / the Start menu / your app
menu. It fetches Node.js 22 for itself if you don't have it, and keeps Bookwyrm in `~/bookwyrm`
(`BOOKWYRM_DIR` to change). Your settings go to `~/.bookwyrm/settings.json`; the keys only to the
profile's own `.env`.

Run the same line again any time, for example after an update: it skips what's done. From a
clone, `./install.sh` (or `.\install.ps1`) does the same with that clone.

For scripts and CI:

```bash
ANTHROPIC_API_KEY=... GITHUB_PERSONAL_ACCESS_TOKEN=... \
  ./install.sh --yes --name "Dee Firmin" --team "Data Engineering" --repo dfirmin/archivist-knowledge-01
./install.sh --yes --only voice,models,app,launcher     # just some steps
./install.sh --dry-run                                  # show what it would do
```

`./install.sh --help` lists every option and step. One more thing to do yourself: **protect the
knowledge repo's `main`** (require a pull request before merging). Bookwyrm's rules say it only
works through PRs; branch protection is what makes that true.

**Using Bookwyrm.** Open it like any app (Applications, the Start menu, or your app menu), then
click the robot. [docs/setup.md](docs/setup.md) walks through it, with what to do if something's
off. Bookwyrm also works in a terminal: `hermes -p bookwyrm chat`.

**Anthropic directly, or your company's gateway.** Setup asks how Bookwyrm should reach
Claude: with an Anthropic API key, or through a LiteLLM (or other OpenAI-compatible) gateway,
given its address, the model name it uses for Claude, and your key. It checks the gateway before
using it: the key works, the model exists, and it streams and calls tools, which Bookwyrm needs.
Switch any time in the app under Settings → Model, or with
`./install.sh --provider gateway --gateway-url https://… --gateway-model claude-sonnet` (key in
`LITELLM_API_KEY`). The choice is kept in `~/.bookwyrm/settings.json`, so updates keep it. See
[ADR 0005](docs/adr/0005-company-gateway.md).

## Layout

```
profile/                 Hermes profile template: config.yaml, SOUL.md, .env.example
skills/                  Bookwyrm's skills (loaded read-only via skills.external_dirs)
voice/                   The call service: Pipecat pipeline, Hermes adapter, local speech models
voice/prompts/           How Bookwyrm talks on a call
app/                     The desktop app (Electron): the robot, its call card, the Bookwyrm window
install.sh, install.ps1  One-line installers: get Node.js and the source, start the wizard
setup/                   The setup wizard (Ink): every install step, safe to re-run
docs/setup.md            Installing, using, troubleshooting, removing
docs/adr/                Decisions
.github/workflows/       CI: install and test on macOS, Windows and Linux
docs/live-proof/         What was run and what it showed
```
