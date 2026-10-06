# 0006 — The knowledge repo comes from Archivist's registry

Status: proposed, 2026-10-06.

## Context

Setup asked for the knowledge repo as typed `owner/name` text and only checked that the GitHub
token could write to it. Any repo the token reached would do. That includes repos Archivist
doesn't run on, which have none of the layout Bookwyrm's skills expect (contracts, `index.md`,
quarantine, `sources/inbox`). A typo or a misunderstanding would give an agent that opens pull
requests against the wrong thing.

Archivist already says which repos are its own, in two places:

- **The target registry**, `targets.yaml` in the Archivist repo. It has one entry per onboarded
  knowledge repo: slug, name, description, `type` (warehouse, docs, test), `status`
  (active / inactive) and the GitHub URL.
- **The marker in each target**, `contracts/target.yaml`. Archivist scaffolds it into every
  target, carrying the same slug and the pinned engine release.

## Decision

1. **Pick from the registry, don't type.** Setup (after the keys) and Settings → Knowledge repo
   list the registry's **active** targets by name and repo. For each one, the list shows what
   the GitHub token can do there, and repos the token can't reach or can only read are marked
   and can't be chosen.
2. **Test targets are hidden by default** behind "Show test targets", except a test target
   that's already the chosen repo, which stays listed and selected.
3. **One validation, enforced where the repo is written.** Setup's profile step refuses the repo
   unless all of these hold, and then changes nothing:
   - it is an active registry target;
   - the token can write to it;
   - its `contracts/target.yaml` names the same slug.

   Every route passes through that step: the wizard, `--yes`/CI, and Settings. The rules mirror
   `archivist/targets.py`: the slug pattern, `active`/`inactive`, and https GitHub URLs.
4. **Repos that look like Archivist's but aren't registered are refused.** The registry is the
   list of what Archivist runs on; adding a repo there is one pull request.
5. **Offline.** If the registry can't be read, a *new* repo can't be chosen, but the saved repo
   is kept, with a warning, and checked again next time. Setup shouldn't fail on a train.
6. **Retired targets.** The Library re-checks the saved repo. If it's no longer an active target,
   it says so and offers to choose another.
7. **Where the registry lives.** `dfirmin/archivist` by default. A company fork can be used with
   `--registry owner/repo[@branch]`, `BOOKWYRM_REGISTRY`, or `registry` in `settings.json`
   (setup remembers a non-default one). A public registry is read from raw.githubusercontent.com
   with no token. A private one is read through the GitHub API, which then needs a token that
   can read it.
8. **One implementation.** The rules live in `setup/src/registry.js`. The app asks for the list
   through the wizard (`--targets-json`, run with Electron's own Node) rather than keeping a
   second copy.

## Consequences

- This guards against mistakes; it isn't a security boundary. Bookwyrm runs on each person's
  machine, and its files can be edited. The fine-grained token's scope, and branch protection
  on each knowledge repo, are what actually limit what it can change.
- A repo has to be onboarded to Archivist (scaffolded, then registered) before anyone can point
  Bookwyrm at it. That's the intended order.
