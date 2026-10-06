// What's already on this machine, what the person told us last time, and checking their keys.
import fs from 'node:fs';
import path from 'node:path';
import { STEP_IDS, loadLauncher, modelsPresent } from './steps.js';
import { findHermes, paths, profileDir, readEnvFile, readJson } from './sys.js';

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---- command line -------------------------------------------------------------------------------

export const HELP = `Bookwyrm setup

  node setup/dist/setup.mjs [options]

  --yes, -y              don't ask anything (for scripts and CI); keys come from the
                         ANTHROPIC_API_KEY (or LITELLM_API_KEY) and GITHUB_PERSONAL_ACCESS_TOKEN
                         environment variables
  --name "Dee Firmin"    your name            --team "Data Engineering"   your team
  --repo owner/name      the knowledge repo   --caller "Name, Team"       name and team in one
  --only a,b             run only these steps  --skip a,b                 skip these steps
  --dry-run              show what would happen, change nothing
  --open / --no-open     open Bookwyrm at the end (default: ask; --yes: don't)
  --open-at-login / --no-open-at-login
                         start Bookwyrm when you log in (default: ask, yes; --yes: leave as is)
  --provider anthropic|gateway
                         how Bookwyrm reaches Claude: Anthropic directly (default), or your
                         company's LiteLLM / OpenAI-compatible gateway
  --gateway-url URL      the gateway's base URL, e.g. https://litellm.example.com/v1
  --gateway-model NAME   the model name the gateway uses for Claude
  --github-mcp-bin PATH  use this GitHub MCP server binary instead of downloading one
  --profile NAME         Hermes profile name (default bookwyrm)
  --plain                plain text output, no animations
  --help

  Steps: ${STEP_IDS.join(', ')}
`;

export function parseArgs(argv) {
  const opts = { profile: 'bookwyrm', only: null, skip: [] };
  const take = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const list = (v, flag) => {
    const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((id) => !STEP_IDS.includes(id));
    if (bad.length) throw new Error(`${flag}: unknown step ${bad.join(', ')} (steps: ${STEP_IDS.join(', ')})`);
    return ids;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a.startsWith('--') && a.includes('=')) {
      const [k, ...v] = a.split('=');
      argv = [...argv.slice(0, i), k, v.join('='), ...argv.slice(i + 1)];
      a = k;
    }
    switch (a) {
      case '-y': case '--yes': opts.yes = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--plain': opts.plain = true; break;
      case '--open': opts.open = true; break;
      case '--no-open': opts.open = false; break;
      case '--open-at-login': opts.openAtLogin = true; break;
      case '--no-open-at-login': opts.openAtLogin = false; break;
      case '--name': opts.name = take(i++, a); break;
      case '--team': opts.team = take(i++, a); break;
      case '--repo': opts.repo = take(i++, a); break;
      case '--caller': Object.assign(opts, splitCaller(take(i++, a))); break;
      case '--profile': opts.profile = take(i++, a); break;
      case '--github-mcp-bin': opts.githubMcpBin = take(i++, a); break;
      case '--provider': {
        const v = take(i++, a).toLowerCase();
        if (!['anthropic', 'gateway', 'litellm'].includes(v)) throw new Error(`--provider is anthropic or gateway, got "${v}"`);
        opts.provider = v === 'litellm' ? 'gateway' : v;
        break;
      }
      case '--gateway-url': opts.gatewayUrl = normalizeGatewayUrl(take(i++, a)); break;
      case '--gateway-model': opts.gatewayModel = take(i++, a).trim(); break;
      case '--only': case '--skip': {
        // "a,b,c", or "a b c": PowerShell passes an unquoted a,b,c as separate arguments.
        let v = take(i++, a);
        while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) v += `,${argv[++i]}`;
        if (a === '--only') opts.only = list(v, a); else opts.skip = list(v, a);
        break;
      }
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown option: ${a} (try --help)`);
    }
  }
  if (opts.repo && !REPO_RE.test(opts.repo)) throw new Error(`--repo should look like owner/name, got "${opts.repo}"`);
  if ((opts.gatewayUrl || opts.gatewayModel) && !opts.provider) opts.provider = 'gateway';
  if (opts.gatewayUrl && !/^https?:\/\/[^\s/]+/.test(opts.gatewayUrl)) throw new Error(`--gateway-url should start with https:// (or http://), got "${opts.gatewayUrl}"`);
  if (opts.githubMcpBin && !fs.existsSync(opts.githubMcpBin)) throw new Error(`--github-mcp-bin: no such file: ${opts.githubMcpBin}`);
  return opts;
}

/** "https://gw.example.com/v1/" → "https://gw.example.com/v1" (we add /v1 later only if needed). */
export function normalizeGatewayUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

function splitCaller(caller) {
  const i = caller.indexOf(',');
  return i < 0 ? { name: caller.trim() } : { name: caller.slice(0, i).trim(), team: caller.slice(i + 1).trim() };
}

export function selectedSteps(opts) {
  return STEP_IDS.filter((id) => (!opts.only || opts.only.includes(id)) && !opts.skip.includes(id));
}

// ---- what we knew before ----------------------------------------------------------------------------

/** Name/team/repo from flags, then ~/.bookwyrm/settings.json, then the old voice/.env. */
export function prefill(opts) {
  const settings = readJson(paths.settings) || {};
  const legacy = readEnvFile(path.join(paths.voice, '.env'));
  const fromLegacy = legacy.BOOKWYRM_CALLER ? splitCaller(legacy.BOOKWYRM_CALLER) : {};
  const saved = settings.model || {};
  return {
    name: opts.name ?? settings.name ?? fromLegacy.name ?? '',
    team: opts.team ?? settings.team ?? fromLegacy.team ?? '',
    repo: opts.repo ?? settings.repo ?? legacy.BOOKWYRM_REPO ?? '',
    // How Bookwyrm reaches Claude: flags, then what was chosen last time, then Anthropic directly.
    provider: opts.provider ?? saved.provider ?? 'anthropic',
    gatewayUrl: opts.gatewayUrl ?? saved.base_url ?? '',
    gatewayModel: opts.gatewayModel ?? saved.name ?? '',
  };
}

export function existingKeys(profile) {
  const env = readEnvFile(path.join(profileDir(profile), '.env'));
  return {
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    gatewayKey: env.LITELLM_API_KEY || '',
    githubToken: env.GITHUB_PERSONAL_ACCESS_TOKEN || '',
  };
}

/** The key that matters for the chosen provider. */
export const modelKeyField = (answers) => (answers.provider === 'gateway' ? 'gatewayKey' : 'anthropicKey');

/** A quick look around for the welcome screen. Only file checks: it must be instant. */
export function detectState(profile) {
  const keys = existingKeys(profile);
  const modelKey = (readJson(paths.settings)?.model?.provider === 'gateway') ? keys.gatewayKey : keys.anthropicKey;
  const { electronBinary } = loadLauncher();
  return [
    { label: 'Hermes Agent', ok: Boolean(findHermes()) },
    { label: `Bookwyrm profile (${profile})`, ok: fs.existsSync(profileDir(profile)) },
    { label: 'Model key and GitHub token', ok: Boolean(modelKey && keys.githubToken), partial: Boolean(modelKey || keys.githubToken) },
    { label: 'Voice service', ok: fs.existsSync(paths.venvPython) },
    { label: 'Speech models', ok: modelsPresent() },
    { label: 'Companion app', ok: fs.existsSync(electronBinary(paths.app)) && fs.existsSync(path.join(paths.app, 'dist')) },
  ];
}


// ---- checking keys --------------------------------------------------------------------------------

async function get(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, error: err.cause?.code || err.message };
  }
}

/** → { ok, message } in plain language. Never includes the key itself. */
export async function checkAnthropic(key) {
  const r = await get('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  if (r.status === 200) return { ok: true, message: 'Anthropic accepted the key.' };
  if (r.status === 401) return { ok: false, message: 'Anthropic didn\'t accept this key. Check you copied all of it (it starts with sk-ant-).' };
  if (r.status === 403) return { ok: false, message: 'This key isn\'t allowed to use the API. Ask whoever manages your Anthropic account.' };
  if (r.status === 0) return { ok: false, message: `Couldn't reach Anthropic to check the key (${r.error}). Your network may block it.` };
  return { ok: false, message: `Anthropic answered with an unexpected status (${r.status}).` };
}

export async function checkGitHub(token, repo) {
  const r = await get(`https://api.github.com/repos/${repo}`, {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'bookwyrm-setup',
  });
  if (r.status === 200) {
    if (r.body?.permissions && r.body.permissions.push === false) {
      return { ok: false, message: `The token can read ${repo} but not write to it. Give it Contents, Issues and Pull requests: Read and write.` };
    }
    return { ok: true, message: `GitHub accepted the token for ${repo}.` };
  }
  if (r.status === 401) return { ok: false, message: 'GitHub didn\'t accept this token. It may be mistyped or expired.' };
  if (r.status === 404 || r.status === 403) return { ok: false, message: `This token can't see ${repo}. When you make the token, pick "Only select repositories" and choose ${repo}.` };
  if (r.status === 0) return { ok: false, message: `Couldn't reach GitHub to check the token (${r.error}).` };
  return { ok: false, message: `GitHub answered with an unexpected status (${r.status}).` };
}

// A company gateway (LiteLLM or any OpenAI-compatible endpoint). One streamed request that must
// call a tool proves the four things Bookwyrm needs: the URL, the key, the model name, and
// streamed tool calls (every GitHub action is a tool call; calls speak while the reply streams).
const PING_TOOL = { type: 'function', function: { name: 'ping', description: 'Checks the connection.', parameters: { type: 'object', properties: {} } } };

async function post(url, headers, body, timeoutMs = 60000) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, error: err.cause?.code || err.message };
  }
}

function gatewayError(r, what) {
  try {
    const e = JSON.parse(r.text).error;
    return (typeof e === 'string' ? e : e?.message || '').split('\n')[0].slice(0, 220);
  } catch {
    return (r.text || '').slice(0, 220) || what;
  }
}

/** → { ok, message, baseUrl, models? }. baseUrl may gain /v1 if the gateway only answers there. */
export async function checkGateway(baseUrl, key, model) {
  baseUrl = normalizeGatewayUrl(baseUrl);
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, message: 'The gateway address should start with https://.' };
  const auth = { Authorization: `Bearer ${key}` };
  let models = await get(`${baseUrl}/models`, auth);
  if (models.status === 404 && !/\/v1$/.test(baseUrl)) {
    const withV1 = await get(`${baseUrl}/v1/models`, auth);
    if (withV1.status === 200) { baseUrl = `${baseUrl}/v1`; models = withV1; }
  }
  if (models.status === 0) return { ok: false, message: `Couldn't reach the gateway at ${baseUrl} (${models.error}). Are you on the company network or VPN?`, baseUrl };
  if (models.status === 401 || models.status === 403) return { ok: false, message: 'The gateway didn\'t accept this key.', baseUrl };
  const ids = Array.isArray(models.body?.data) ? models.body.data.map((m) => m.id).filter(Boolean) : [];
  if (models.status === 200 && ids.length && !ids.includes(model)) {
    return { ok: false, message: `The gateway has no model called "${model}". It offers: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}.`, baseUrl, models: ids };
  }

  const r = await post(`${baseUrl}/chat/completions`, auth, {
    model, stream: true, max_tokens: 200, tool_choice: 'auto', tools: [PING_TOOL],
    messages: [
      { role: 'system', content: 'You are a connection check. Call the ping tool once and say nothing else.' },
      { role: 'user', content: 'Check the connection.' },
    ],
  });
  if (r.status === 0) return { ok: false, message: `Couldn't reach the gateway at ${baseUrl} (${r.error}).`, baseUrl, models: ids };
  if (r.status === 401 || r.status === 403) return { ok: false, message: 'The gateway didn\'t accept this key.', baseUrl, models: ids };
  if (r.status === 404) return { ok: false, message: `The gateway answered 404 at ${baseUrl}/chat/completions. Check the address (it usually ends in /v1).`, baseUrl, models: ids };
  if (r.status !== 200) return { ok: false, message: `The gateway refused the test request: ${gatewayError(r, `status ${r.status}`)}`, baseUrl, models: ids };
  const streamed = r.text.split('\n').some((l) => l.startsWith('data:'));
  if (!streamed) return { ok: false, message: 'The gateway answered, but not as a stream. Bookwyrm needs streaming to talk while it thinks.', baseUrl, models: ids };
  if (!/"tool_calls"\s*:\s*\[\s*\{/.test(r.text) || !r.text.includes('"ping"')) {
    return { ok: false, message: `"${model}" answered, but didn't call a tool. Bookwyrm needs tool calls for everything it does in GitHub; use a Claude model.`, baseUrl, models: ids };
  }
  return { ok: true, message: `The gateway accepted the key, and "${model}" streams and calls tools.`, baseUrl, models: ids };
}

export const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
export const ANTHROPIC_KEY_URL = 'https://console.anthropic.com/settings/keys';
