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
                         ANTHROPIC_API_KEY and GITHUB_PERSONAL_ACCESS_TOKEN environment variables
  --name "Dee Firmin"    your name            --team "Data Engineering"   your team
  --repo owner/name      the knowledge repo   --caller "Name, Team"       name and team in one
  --only a,b             run only these steps  --skip a,b                 skip these steps
  --dry-run              show what would happen, change nothing
  --open / --no-open     open Bookwyrm at the end (default: ask; --yes: don't)
  --open-at-login / --no-open-at-login
                         start Bookwyrm when you log in (default: ask, yes; --yes: leave as is)
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
  if (opts.githubMcpBin && !fs.existsSync(opts.githubMcpBin)) throw new Error(`--github-mcp-bin: no such file: ${opts.githubMcpBin}`);
  return opts;
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
  return {
    name: opts.name ?? settings.name ?? fromLegacy.name ?? '',
    team: opts.team ?? settings.team ?? fromLegacy.team ?? '',
    repo: opts.repo ?? settings.repo ?? legacy.BOOKWYRM_REPO ?? '',
  };
}

export function existingKeys(profile) {
  const env = readEnvFile(path.join(profileDir(profile), '.env'));
  return { anthropicKey: env.ANTHROPIC_API_KEY || '', githubToken: env.GITHUB_PERSONAL_ACCESS_TOKEN || '' };
}

/** A quick look around for the welcome screen. Only file checks: it must be instant. */
export function detectState(profile) {
  const keys = existingKeys(profile);
  const { electronBinary } = loadLauncher();
  return [
    { label: 'Hermes Agent', ok: Boolean(findHermes()) },
    { label: `Bookwyrm profile (${profile})`, ok: fs.existsSync(profileDir(profile)) },
    { label: 'Anthropic key and GitHub token', ok: Boolean(keys.anthropicKey && keys.githubToken), partial: Boolean(keys.anthropicKey || keys.githubToken) },
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

export const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
export const ANTHROPIC_KEY_URL = 'https://console.anthropic.com/settings/keys';
