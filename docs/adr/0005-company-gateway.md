# 0005 — Reaching Claude through a company gateway

Status: proposed, 2026-10-06. Builds on [0001](0001-hermes-runtime-github-tools-sqlite-memory.md).

## Context

Some people who'll use Bookwyrm don't have an Anthropic API key. Their company gives them a
LiteLLM gateway instead: an address, a key, and a model name for Claude. Hermes already supports
this (its `custom` provider: an OpenAI-compatible `base_url`, with the key named by
`api_key_env`), but Bookwyrm's setup asked only for an Anthropic key. It also re-rendered the
profile's `config.yaml` from the template on every run, so a hand edit didn't survive an update.

## Decision

1. **A choice, made in setup and in Settings.** "How should Bookwyrm reach Claude?" has two
   answers:
   - **Anthropic directly**, with an API key;
   - **my company's gateway**, given its address, the model name and a key.

   Flags do the same for scripts: `--provider gateway --gateway-url … --gateway-model …`, with
   the key in `LITELLM_API_KEY`. Settings → Model runs the same setup steps with Electron's own
   Node, so a switch needs no terminal (as with the repo and keys in 0004).
2. **Remembered, so updates keep it.** The choice is saved in `~/.bookwyrm/settings.json` as
   `model: {provider, base_url, name}`. Setup writes the profile's `model:` block from it on
   every run: Hermes' `custom` provider, `default` set to the model name, `base_url`, and
   `api_key_env: LITELLM_API_KEY`. The gateway key sits in the profile's `.env` next to the
   others.
3. **Checked before it's used.** The gateway check makes one streamed `chat/completions` request
   that must call a tool, which proves everything Bookwyrm depends on:
   - the address;
   - the key;
   - that the model exists (when the name isn't in `/models`, the check lists what the gateway
     offers);
   - streamed tool calls, which every GitHub action and every spoken answer needs.

   It uses `tool_choice: auto` with an instruction rather than forcing the tool, because current
   Claude models reject forced tool use through LiteLLM. The check also adds `/v1` when the
   gateway only answers there.
4. **Setup now checks Bookwyrm can think.** After the GitHub check, setup asks Bookwyrm, through
   Hermes' runs API, to reply "ready". That proves the model settings end to end, through
   Hermes itself, whichever route is chosen.

## Consequences

- Tested here against a real LiteLLM proxy (1.104) fronting Claude, with the direct Anthropic
  key removed from the profile:
  - the setup checks passed;
  - Bookwyrm answered repo questions with GitHub tool calls through the gateway;
  - switching back to Anthropic from Settings worked;
  - with the gateway then stopped, Bookwyrm still answered.
- The speech models stay local whichever route is chosen; only text goes to the gateway.
- A gateway reachable only on the company network means Bookwyrm can only think while
  connected.
