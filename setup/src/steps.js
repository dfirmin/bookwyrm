// The install steps. Each one knows how to tell whether it's already done, what it would do
// (for --dry-run) and how to do it. They share one `ctx` (answers, found programs, flags).
//
// run(ctx, io) resolves to { note?, warn? } or throws a StepError with a plain-language hint.
// io = { log(line), progress({ label, done, total }) } feeds the checklist UI.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DEFAULT_REGISTRY, validateTarget } from './registry.js';
import {
  childEnv, download, fileHash, findHermes, findUv, httpAlive, isMac, isWin, npmCommand, parseEnv, paths,
  profileDir, readEnvFile, readJson, readText, run, secureFile, setEnvValues, sha256, sleep, tarBinary,
  writeIfChanged, writePrivate,
} from './sys.js';

export class StepError extends Error {
  constructor(message, hint, lines = []) {
    super(message);
    this.hint = hint;
    this.lines = lines;
  }
}

const HERMES_PORT = 8642;
const MODEL_MARKERS = {
  'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8': 'tokens.txt',
  'kokoro-multi-lang-v1_0': 'voices.bin',
};

// Run a command and turn a non-zero exit into a StepError carrying its last lines.
async function must(io, cmd, args, opts, message, hint) {
  const res = await run(cmd, args, { ...opts, onLine: io.log });
  if (res.code !== 0) throw new StepError(message, hint, res.lines.slice(-12));
  return res;
}

function requireHermes(ctx) {
  ctx.hermes = ctx.hermes || findHermes();
  if (!ctx.hermes) {
    throw new StepError('Hermes Agent isn\'t installed yet.', 'Run setup again and let it install Hermes (don\'t skip that step), or install Hermes from https://hermes-agent.nousresearch.com.');
  }
  return ctx.hermes;
}

const hermes = (ctx, io, args, message, hint) => must(io, requireHermes(ctx), args, {}, message, hint);

export function modelsPresent() {
  return Object.entries(MODEL_MARKERS).every(([m, f]) => fs.existsSync(path.join(paths.models, m, f)));
}

const appLockHash = () => fileHash(path.join(paths.app, 'package-lock.json')) || fileHash(path.join(paths.app, 'package.json'));
const APP_STAMP = path.join(paths.app, 'node_modules', '.bookwyrm-installed');
const VOICE_STAMP = path.join(paths.voice, '.venv', '.bookwyrm-installed');
const NATURAL_STAMP = path.join(paths.voice, '.venv', '.bookwyrm-natural-voice');

// The natural voice's model files, per engine (mirrors voice/bookwyrm_voice/models.py ENGINE_MODELS).
const ENGINE_DIRS = {
  kokoro: ['kokoro-multi-lang-v1_0/voices.bin'],
  'chatterbox-turbo-mlx': ['chatterbox-turbo-8bit-mlx/.bookwyrm-complete'],
  'chatterbox-turbo': ['chatterbox-turbo/.bookwyrm-complete'],
  'chatterbox-nano': ['chatterbox-nano/.bookwyrm-complete'],
};
export const VOICE_ENGINES = ['auto', ...Object.keys(ENGINE_DIRS)];

function engineDownloaded(engine) {
  return (ENGINE_DIRS[engine] || ['?']).every((f) => fs.existsSync(path.join(paths.models, f)));
}

/** Set one key in settings.json, keeping everything else. */
function setSetting(key, value) {
  const existing = readJson(paths.settings) || {};
  fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
  fs.writeFileSync(paths.settings, `${JSON.stringify({ ...existing, [key]: value }, null, 2)}\n`);
}

function electronInstalled() {
  const { electronBinary } = loadLauncher();
  return fs.existsSync(electronBinary(paths.app));
}

export function loadLauncher() {
  // CommonJS module shared with the Electron main process.
  return createRequire(import.meta.url)(path.join(paths.app, 'launcher.js'));
}

// ---- 4. profile rendering (port of the old scripts/install.sh) ----------------------------------

/** The profile's model: block for a company gateway (Hermes' "custom" provider). */
export function gatewayModelBlock({ gatewayUrl, gatewayModel }) {
  return [
    'model:',
    '  # Your company\'s gateway (LiteLLM or any OpenAI-compatible endpoint), chosen in Bookwyrm',
    '  # setup or Settings. Its key is LITELLM_API_KEY in this profile\'s .env.',
    '  provider: "custom"',
    `  default: ${JSON.stringify(gatewayModel)}`,
    `  base_url: ${JSON.stringify(gatewayUrl)}`,
    '  api_key_env: "LITELLM_API_KEY"',
    '',
  ].join('\n');
}

// The model: block and the lines indented under it, up to the next top-level line.
const MODEL_BLOCK = /^model:\n(?:(?:[ \t]+.*)?\n)*?(?=^\S)/m;

export function renderProfileFile(text, { skillsDir, repo, mcpBin, isConfig, model }) {
  text = text.replace(/\r\n/g, '\n');
  if (isConfig && model?.provider === 'gateway') {
    if (!MODEL_BLOCK.test(text)) throw new StepError('profile/config.yaml has changed shape: its model block is missing.', 'Tell whoever maintains Bookwyrm; this is a bug in the repo, not on your machine.');
    text = text.replace(MODEL_BLOCK, `${gatewayModelBlock(model)}\n`);
  }
  // JSON strings are valid YAML double-quoted strings, so Windows backslashes stay intact.
  text = text.split('"__BOOKWYRM_SKILLS__"').join(JSON.stringify(skillsDir));
  text = text.split('__BOOKWYRM_SKILLS__').join(skillsDir);
  text = text.split('{{TARGET_REPO}}').join(repo);
  if (isConfig && mcpBin) {
    const docker = /    command: "docker"\n    args:\n(?:      - .*\n)+/;
    if (!docker.test(text)) throw new StepError('profile/config.yaml has changed shape: its Docker launch block for GitHub is missing.', 'Tell whoever maintains Bookwyrm; this is a bug in the repo, not on your machine.');
    text = text.replace(docker, `    command: ${JSON.stringify(mcpBin)}\n    args: ["stdio"]\n`);
  }
  return text;
}

// ---- the steps ------------------------------------------------------------------------------------

export const STEPS = [
  {
    id: 'uv',
    doing: "Installing uv, the tool that sets up Bookwyrm's Python parts. Usually under a minute.",
    title: 'Python tools (uv)',
    detect(ctx) {
      ctx.uv = findUv();
      return ctx.uv ? { done: true, note: 'already installed' } : { done: false };
    },
    plan: () => [isWin
      ? 'powershell: irm https://astral.sh/uv/install.ps1 | iex'
      : 'curl -LsSf https://astral.sh/uv/install.sh | sh'],
    async run(ctx, io) {
      if (isWin) {
        await must(io, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://astral.sh/uv/install.ps1 | iex'], {},
          'Couldn\'t install uv.', 'Check your internet connection (and any proxy), then retry.');
      } else {
        await must(io, 'sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {},
          'Couldn\'t install uv.', 'Check your internet connection (and any proxy), then retry.');
      }
      ctx.uv = findUv();
      if (!ctx.uv) throw new StepError('uv installed, but I can\'t find it.', 'Open a new terminal and run this setup again.');
      return {};
    },
  },

  {
    id: 'hermes',
    doing: "Installing Hermes Agent, Bookwyrm's brain. Usually 3 to 8 minutes; it downloads its own Python.",
    title: 'Hermes Agent',
    detect(ctx) {
      ctx.hermes = findHermes();
      return ctx.hermes ? { done: true, note: 'already installed' } : { done: false };
    },
    plan: () => [isWin
      ? 'powershell: & ([scriptblock]::Create((irm https://hermes-agent.nousresearch.com/install.ps1))) -NonInteractive -SkipBrowser -SkipComputerUse'
      : 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive --skip-browser --skip-computer-use'],
    async run(ctx, io) {
      const hint = 'Check your internet connection and retry. If it keeps failing, install Hermes by hand from https://hermes-agent.nousresearch.com and run this setup again.';
      if (isWin) {
        // Strip a UTF-8 BOM if one came along; [scriptblock]::Create chokes on it.
        const script = '$ErrorActionPreference = "Stop"; $s = (irm https://hermes-agent.nousresearch.com/install.ps1).TrimStart([char]0xFEFF); '
          + '& ([scriptblock]::Create($s)) -NonInteractive -SkipBrowser -SkipComputerUse';
        await must(io, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {}, 'The Hermes installer failed.', hint);
      } else {
        await must(io, 'bash', ['-c', 'set -o pipefail; curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive --skip-browser --skip-computer-use'],
          {}, 'The Hermes installer failed.', hint);
      }
      ctx.hermes = findHermes();
      if (!ctx.hermes) throw new StepError('Hermes installed, but I can\'t find the hermes command.', 'Open a new terminal and run this setup again.');
      return { note: ctx.hermes };
    },
  },

  {
    id: 'github-mcp',
    doing: "Downloading the GitHub connector (about 10 MB). A few seconds.",
    title: 'GitHub connector',
    detect(ctx) {
      if (ctx.opts.githubMcpBin) return { done: true, note: `using ${ctx.opts.githubMcpBin}` };
      return fs.existsSync(paths.mcpBin) ? { done: true, note: 'already installed' } : { done: false };
    },
    plan: () => [`download ${mcpAsset()} → ${paths.mcpBin}`],
    async run(ctx, io) {
      const asset = mcpAsset();
      const url = `https://github.com/github/github-mcp-server/releases/latest/download/${asset}`;
      const tmp = path.join(paths.bin, '.download');
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      try {
        const archive = path.join(tmp, asset);
        try {
          await download(url, archive, (done, total) => io.progress({ label: 'downloading', done, total }));
        } catch (err) {
          throw new StepError(`Couldn't download the GitHub connector: ${err.message}`, 'Check your internet connection (GitHub must be reachable), then retry.');
        }
        await must(io, tarBinary(), ['-xf', archive, '-C', tmp], { cwd: tmp }, 'Couldn\'t unpack the GitHub connector.', 'Retry; if it fails again, the download may be damaged.');
        const name = path.basename(paths.mcpBin);
        const found = path.join(tmp, name);
        if (!fs.existsSync(found)) throw new StepError(`The download didn't contain ${name}.`, 'GitHub may have changed the release layout; tell whoever maintains Bookwyrm.');
        fs.copyFileSync(found, paths.mcpBin);
        if (!isWin) fs.chmodSync(paths.mcpBin, 0o755);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      const res = await run(paths.mcpBin, ['--version']);
      return { note: (res.lines.find((l) => /version/i.test(l)) || '').trim() };
    },
  },

  {
    id: 'profile',
    doing: "Checking the knowledge repo against Archivist's registry, then writing Bookwyrm's Hermes profile. A few seconds.",
    title: 'Bookwyrm\'s Hermes profile',
    detect: () => ({ done: false }), // cheap and must follow repo changes: always refreshed
    plan(ctx) {
      const dir = profileDir(ctx.profile);
      const out = [];
      if (!fs.existsSync(dir)) out.push(`hermes profile create ${ctx.profile} --no-skills --description "…"`);
      const a = ctx.answers;
      const via = a.provider === 'gateway' ? `your gateway ${a.gatewayUrl || '?'} as "${a.gatewayModel || '?'}"` : 'Anthropic directly';
      out.push(`render profile/config.yaml and SOUL.md into ${dir} (repo ${a.repo || '?'}, Claude via ${via}, GitHub connector ${mcpBinFor(ctx)})`);
      const keys = [a.anthropicKey && 'ANTHROPIC_API_KEY', a.gatewayKey && 'LITELLM_API_KEY', a.githubToken && 'GITHUB_PERSONAL_ACCESS_TOKEN'].filter(Boolean);
      out.push(keys.length ? `write ${keys.join(', ')} into ${path.join(dir, '.env')} (other lines kept)` : `keep the keys in ${path.join(dir, '.env')}`);
      return out;
    },
    async run(ctx, io) {
      const repo = ctx.answers.repo;
      if (!repo) throw new StepError('I need the knowledge repo (owner/name) for the profile.', 'Run setup again and fill in "About you", or pass --repo owner/name.');
      // Only an active target in the Archivist registry, whose repo carries Archivist's marker.
      const token = ctx.answers.githubToken || readEnvFile(path.join(profileDir(ctx.profile), '.env')).GITHUB_PERSONAL_ACCESS_TOKEN;
      const verdict = await validateTarget(repo, {
        registry: ctx.answers.registry, token, keepIfUnreachable: repo === ctx.answers.savedRepo,
      });
      if (!verdict.ok) {
        throw new StepError(verdict.message, 'Pick a knowledge repo from the Archivist registry: run setup again, or use Settings → Knowledge repo in the app.');
      }
      io.log(verdict.warn || verdict.message);
      const dir = profileDir(ctx.profile);
      if (!fs.existsSync(dir)) {
        await hermes(ctx, io, ['profile', 'create', ctx.profile, '--no-skills', '--description',
          `Librarian for the Archivist knowledge repo ${repo}: answers from it, records SME knowledge, resolves gaps and quarantine by pull request.`],
        'Hermes couldn\'t create the bookwyrm profile.', 'Read the lines above; running `hermes doctor` may explain more.');
      }
      if (!fs.existsSync(dir)) throw new StepError(`The profile folder wasn't created: ${dir}`, 'Check HERMES_HOME points where Hermes keeps its data.');

      const mcpBin = mcpBinFor(ctx);
      const useBin = fs.existsSync(mcpBin);
      if (!useBin) io.log(`GitHub connector not found at ${mcpBin}; keeping the Docker launch`);
      const a = ctx.answers;
      if (a.provider === 'gateway' && !(a.gatewayUrl && a.gatewayModel)) {
        throw new StepError('To use your company\'s gateway I need its address and the model name.', 'Run setup again and fill them in, or pass --gateway-url and --gateway-model.');
      }
      const model = { provider: a.provider, gatewayUrl: a.gatewayUrl, gatewayModel: a.gatewayModel };
      const vars = { skillsDir: path.join(paths.repo, 'skills'), repo, mcpBin: useBin ? mcpBin : '', model };
      let changed = false;
      for (const [file, isConfig] of [['config.yaml', true], ['SOUL.md', false]]) {
        const text = renderProfileFile(readText(path.join(paths.repo, 'profile', file)), { ...vars, isConfig });
        changed = writeIfChanged(path.join(dir, file), text) || changed;
      }

      const envFile = path.join(dir, '.env');
      const values = {};
      if (ctx.answers.anthropicKey) values.ANTHROPIC_API_KEY = ctx.answers.anthropicKey;
      if (ctx.answers.gatewayKey) values.LITELLM_API_KEY = ctx.answers.gatewayKey;
      if (ctx.answers.githubToken) values.GITHUB_PERSONAL_ACCESS_TOKEN = ctx.answers.githubToken;
      const current = readText(envFile) ?? '';
      if (!/^GITHUB_PERSONAL_ACCESS_TOKEN=/m.test(current)) {
        // First time: bring in the commented template once, minus any key the file already has.
        const have = parseEnv(current);
        const template = readText(path.join(paths.repo, 'profile', '.env.example')).replace(/\r\n/g, '\n').split('\n')
          .filter((line) => { const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line); return !(m && m[1] in have); })
          .join('\n');
        writePrivate(envFile, `${current}${current && !current.endsWith('\n') ? '\n' : ''}\n${template}`);
        changed = true;
      }
      if (Object.keys(values).length) changed = setEnvValues(envFile, values) || changed;
      secureFile(envFile);
      if (changed) ctx.gatewayRestart = true;

      const env = readEnvFile(envFile);
      const modelKey = a.provider === 'gateway' ? 'LITELLM_API_KEY' : 'ANTHROPIC_API_KEY';
      const missing = [modelKey, 'GITHUB_PERSONAL_ACCESS_TOKEN'].filter((k) => !env[k]);
      if (missing.length) return { warn: `No ${missing.join(' or ')} yet: Bookwyrm can't work without ${missing.length > 1 ? 'them' : 'it'}. Run setup again to add ${missing.length > 1 ? 'them' : 'it'}.` };
      return { note: changed ? `updated ${dir}` : 'up to date' };
    },
  },

  {
    id: 'api',
    doing: "Starting Hermes' background service so the app can talk to it. Up to a minute.",
    title: 'Hermes\' local connection for the voice',
    async detectAsync(ctx) {
      const rootEnv = readEnvFile(path.join(paths.hermesHome, '.env'));
      const profEnv = readEnvFile(path.join(profileDir(ctx.profile), '.env'));
      const configured = rootEnv.API_SERVER_ENABLED === 'true' && rootEnv.API_SERVER_KEY && profEnv.API_SERVER_KEY;
      if (configured && !ctx.gatewayRestart && await httpAlive(`http://127.0.0.1:${HERMES_PORT}/`)) {
        return { done: true, note: 'already running' };
      }
      return { done: false };
    },
    detect: () => ({ done: false }),
    plan: (ctx) => [
      `add API_SERVER_ENABLED / API_SERVER_KEY (once) to ${path.join(paths.hermesHome, '.env')} and the profile .env`,
      'hermes config set gateway.multiplex_profiles true',
      'hermes pm install --extra sms   (the API server\'s web package)',
      'hermes gateway install --if-missing; hermes gateway restart (or start)',
      `wait for http://127.0.0.1:${HERMES_PORT}/p/${ctx.profile}/v1`,
    ],
    async run(ctx, io) {
      requireHermes(ctx);
      const profEnv = path.join(profileDir(ctx.profile), '.env');
      if (!fs.existsSync(profileDir(ctx.profile))) throw new StepError('The bookwyrm profile doesn\'t exist yet.', 'Run setup again including the "profile" step.');
      const key = () => crypto.randomBytes(24).toString('base64url');
      setEnvValues(path.join(paths.hermesHome, '.env'), { API_SERVER_ENABLED: 'true', API_SERVER_KEY: key() }, { onlyIfMissing: true });
      setEnvValues(profEnv, { API_SERVER_KEY: key() }, { onlyIfMissing: true });
      await hermes(ctx, io, ['config', 'set', 'gateway.multiplex_profiles', 'true'], 'Hermes couldn\'t change its settings.', 'Read the lines above; `hermes doctor` may explain more.');
      await hermes(ctx, io, ['pm', 'install', '--extra', 'sms'], 'Hermes couldn\'t add its API server package.',
        'Check your internet connection and retry. By hand: hermes pm install --extra sms && hermes gateway restart');
      // Service managers differ per OS; none of these may hang setup.
      const minutes = 2 * 60_000;
      await run(ctx.hermes, ['gateway', 'install', '--if-missing'], { onLine: io.log, timeoutMs: minutes });
      const restarted = await run(ctx.hermes, ['gateway', 'restart'], { onLine: io.log, timeoutMs: minutes });
      if (restarted.code !== 0) await run(ctx.hermes, ['gateway', 'start'], { onLine: io.log, timeoutMs: minutes });
      ctx.gatewayRestart = false;
      for (let i = 0; i < 30; i++) {
        if (await httpAlive(`http://127.0.0.1:${HERMES_PORT}/`)) return { note: `serving http://127.0.0.1:${HERMES_PORT}/p/${ctx.profile}/v1` };
        io.progress({ label: 'waiting for Hermes to start', done: i, total: 30 });
        await sleep(1000);
      }
      return { warn: 'Hermes\' background service didn\'t answer yet. If calls say Bookwyrm\'s brain isn\'t running, run: hermes gateway restart' };
    },
  },

  {
    id: 'check',
    doing: "Connecting to GitHub, then asking Bookwyrm to say \"ready\". About 30 seconds.",
    title: 'Check Bookwyrm can think and reach your repo',
    detect: () => ({ done: false }),
    plan: (ctx) => [
      `hermes -p ${ctx.profile} mcp test github   (installs Hermes' MCP extra if needed: hermes pm install --extra mcp)`,
      `ask Bookwyrm to say "ready" through http://127.0.0.1:${HERMES_PORT}/p/${ctx.profile}/v1/runs (proves the model setting works)`,
    ],
    async run(ctx, io) {
      requireHermes(ctx);
      const test = () => run(ctx.hermes, ['-p', ctx.profile, 'mcp', 'test', 'github'], { onLine: io.log, timeoutMs: 3 * 60_000 });
      let res = await test();
      const authFailed = (r) => /\b401\b|\b403\b|bad credentials|unauthori[sz]ed|sign-in/i.test(r.lines.join('\n'));
      if (res.code !== 0 && !authFailed(res)) {
        // Most often: the `mcp` Python SDK, which Hermes keeps optional. Add it and try again.
        io.log('Adding Hermes\' MCP support (hermes pm install --extra mcp)…');
        await hermes(ctx, io, ['pm', 'install', '--extra', 'mcp'], 'Hermes couldn\'t add MCP support.', 'Check your internet connection and retry. By hand: hermes pm install --extra mcp');
        res = await test();
      }
      if (res.code !== 0) {
        throw new StepError('Bookwyrm couldn\'t connect to GitHub.', authFailed(res)
          ? 'GitHub didn\'t accept the token. Run setup again and enter a new token that includes the knowledge repo.'
          : `Check the token in ${path.join(profileDir(ctx.profile), '.env')} covers the repo, then retry.`, res.lines.slice(-12));
      }
      const tools = res.lines.find((l) => /Tools discovered/i.test(l));
      const think = await thinkCheck(ctx, io);
      if (think.warn) return { warn: `${tools ? 'GitHub connected. ' : ''}${think.warn}` };
      return { note: `${tools ? tools.replace(/^[^A-Za-z]*/, '') : 'GitHub connected'}; ${think.note}` };
    },
  },

  {
    id: 'voice',
    doing: "Installing the voice service's Python packages (speech, audio and web parts, several hundred MB). Usually 2 to 5 minutes.",
    title: 'Voice service',
    detect() {
      const stamp = readText(VOICE_STAMP);
      return fs.existsSync(paths.venvPython) && stamp === voiceHash() ? { done: true, note: 'already installed' } : { done: false };
    },
    plan: () => [
      'uv venv --allow-existing --python 3.12 voice/.venv',
      `uv pip install --python ${path.relative(paths.repo, paths.venvPython)} -e voice`,
    ],
    async run(ctx, io) {
      ctx.uv = ctx.uv || findUv();
      if (!ctx.uv) throw new StepError('uv isn\'t installed.', 'Run setup again without skipping the "uv" step.');
      const venv = path.join(paths.voice, '.venv');
      const hint = 'Check your internet connection (Python packages come from pypi.org), then retry.';
      await must(io, ctx.uv, ['venv', '--allow-existing', '--python', '3.12', venv], { cwd: paths.repo }, 'Couldn\'t create the voice service\'s Python environment.', hint);
      await must(io, ctx.uv, ['pip', 'install', '--python', paths.venvPython, '-e', paths.voice], { cwd: paths.repo }, 'Couldn\'t install the voice service.', hint);
      fs.writeFileSync(VOICE_STAMP, voiceHash());
      return { note: 'installed into voice/.venv' };
    },
  },

  {
    id: 'models',
    doing: "Downloading the speech models. The bar shows how far along it is.",
    title: 'Speech models (about 1 GB, one time)',
    detect: () => (modelsPresent() ? { done: true, note: 'already downloaded' } : { done: false }),
    plan: () => [`python -m bookwyrm_voice.models --progress   → ${paths.models}`],
    async run(ctx, io) {
      if (!fs.existsSync(paths.venvPython)) throw new StepError('The voice service isn\'t installed yet.', 'Run setup again without skipping the "voice" step.');
      const names = { 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8': 'listening model', 'kokoro-multi-lang-v1_0': 'speaking model' };
      const res = await run(paths.venvPython, ['-m', 'bookwyrm_voice.models', '--progress', '--dir', paths.models], {
        cwd: paths.voice,
        onLine(line) {
          const [kind, model, done, total] = line.split(' ');
          const label = names[model] || model;
          if (kind === 'PROGRESS') io.progress({ label, done: Number(done), total: Number(total), bytes: true });
          else if (kind === 'UNPACK') io.progress({ label: `${label}: unpacking`, done: 1, total: 0 });
          else if (kind !== 'DONE') io.log(line);
        },
      });
      if (res.code !== 0) {
        throw new StepError('The speech models didn\'t finish downloading.', 'Check your internet connection (GitHub must be reachable) and free disk space (~2 GB), then retry. Finished models are kept.', res.lines.slice(-8));
      }
      return { note: paths.models };
    },
  },

  {
    id: 'natural-voice',
    doing: (ctx) => ctx.naturalDoing || "Checking which voice this computer can run.",
    title: 'Natural voice (optional)',
    detect(ctx) {
      if (ctx.opts.voiceEngine === 'kokoro') return { done: true, note: 'Standard voice, as asked (--voice-engine kokoro)' };
      const stamp = (readText(NATURAL_STAMP) || '').trim().split(' ');
      const [hash, engine] = stamp;
      const wanted = ctx.opts.voiceEngine && ctx.opts.voiceEngine !== 'auto' ? ctx.opts.voiceEngine : engine;
      if (hash === voiceHash() && engine && engine === wanted && engineDownloaded(engine)) {
        return { done: true, note: engine === 'kokoro' ? 'this computer runs the Standard voice' : `${engine} installed` };
      }
      return { done: false };
    },
    plan: (ctx) => [
      'python -m bookwyrm_voice.hardware --json   → pick the best voice this computer can run',
      `uv pip install -e "voice[mlx|torch]"   (only the one it needs; ${ctx.opts.voiceEngine || 'auto'})`,
      `python -m bookwyrm_voice.models --progress --engine <it>   → ${paths.models}`,
    ],
    async run(ctx, io) {
      if (!fs.existsSync(paths.venvPython)) throw new StepError('The voice service isn\'t installed yet.', 'Run setup again without skipping the "voice" step.');
      const hw = await run(paths.venvPython, ['-m', 'bookwyrm_voice.hardware', '--json'], { cwd: paths.voice });
      let info;
      try { info = JSON.parse(hw.lines.filter((l) => l.startsWith('{')).pop()); } catch { info = null; }
      if (hw.code !== 0 || !info) throw new StepError('Couldn\'t check this computer\'s hardware.', 'Retry, or skip this step: Bookwyrm keeps the Standard voice.', hw.lines.slice(-8));
      const asked = ctx.opts.voiceEngine && ctx.opts.voiceEngine !== 'auto' ? ctx.opts.voiceEngine : null;
      if (asked && info.unsupported[asked]) {
        throw new StepError(`This computer can't run ${asked}: ${info.unsupported[asked]}.`, `Run setup with --voice-engine ${info.recommended} (or auto) instead.`);
      }
      const engine = asked || info.recommended;
      const done = (note) => {
        setSetting('voice_engine', engine);
        fs.writeFileSync(NATURAL_STAMP, `${voiceHash()} ${engine}\n`);
        return { note };
      };
      if (engine === 'kokoro') {
        const why = Object.values(info.unsupported).filter(Boolean).pop() || '';
        return done(`${info.machine.summary}. Standard voice${why ? `: the natural one ${why}` : ''}`);
      }
      const spec = info.install[engine];
      const gb = info.download_gb[engine];
      ctx.naturalDoing = `Installing the natural voice (${engine}, about ${gb} GB, one time). Usually 3 to 10 minutes.`;
      io.log(ctx.naturalDoing);
      io.progress({ label: `${engine}: installing its libraries`, done: 0, total: 0 });
      ctx.uv = ctx.uv || findUv();
      if (!ctx.uv) throw new StepError('uv isn\'t installed.', 'Run setup again without skipping the "uv" step.');
      const keep = 'Bookwyrm keeps the Standard voice meanwhile. Retry, or skip this step to stay on Standard.';
      try {
        const extra = ['pip', 'install', '--python', paths.venvPython, '-e', `${paths.voice}[${spec.extra}]`];
        if (spec.torch_backend) extra.push('--torch-backend', spec.torch_backend);
        await must(io, ctx.uv, extra, { cwd: paths.repo }, 'Couldn\'t install the natural voice\'s libraries.', `Check your internet connection (pypi.org${spec.torch_backend ? ' and download.pytorch.org' : ''}). ${keep}`);
        if (spec.no_deps.length) {
          await must(io, ctx.uv, ['pip', 'install', '--python', paths.venvPython, '--no-deps', ...spec.no_deps], { cwd: paths.repo }, 'Couldn\'t install Chatterbox.', `Check that github.com is reachable. ${keep}`);
        }
      } catch (err) {
        if (err instanceof StepError) throw err;
        throw new StepError(err.message, keep);
      }
      const res = await run(paths.venvPython, ['-m', 'bookwyrm_voice.models', '--progress', '--dir', paths.models, '--engine', engine], {
        cwd: paths.voice,
        onLine(line) {
          const [kind, model, got, total] = line.split(' ');
          if (kind === 'PROGRESS') io.progress({ label: `natural voice (${model})`, done: Number(got), total: Number(total), bytes: true });
          else if (kind !== 'DONE' && kind !== 'UNPACK') io.log(line);
        },
      });
      if (res.code !== 0) {
        throw new StepError('The natural voice didn\'t finish downloading.', `It comes from huggingface.co, which some company networks block; check you can open https://huggingface.co, and that there's ${gb} GB free. Finished files are kept. ${keep}`, res.lines.slice(-8));
      }
      return done(`${engine} (${info.machine.summary})`);
    },
  },

  {
    id: 'app',
    doing: "Installing the app's parts and downloading Electron (about 100 MB). Usually 1 to 3 minutes; this part prints little while it downloads.",
    title: 'Companion app',
    detect: () => ({ done: false }), // the build is quick and must follow repo changes
    plan: () => ['npm ci   (in app/, skipped when unchanged), then fetch Electron', 'npm run build'],
    async run(ctx, io) {
      const [npm, pre] = npmCommand();
      const hint = 'Check your internet connection (npm and GitHub must be reachable), then retry. If it keeps failing, delete app/node_modules and retry.';
      const env = childEnv();
      let note = 'up to date';
      if (readText(APP_STAMP) !== appLockHash() || !electronInstalled()) {
        // `npm ci` follows the lock file exactly and never rewrites it (a dirty clone can't `git pull`).
        const verb = fs.existsSync(path.join(paths.app, 'package-lock.json')) ? 'ci' : 'install';
        await must(io, npm, [...pre, verb, '--no-audit', '--no-fund'], { cwd: paths.app, env }, 'Couldn\'t install the companion app\'s parts.', hint);
        // Electron 44 fetches its binary on first use rather than at install; fetch it now.
        const getElectron = path.join(paths.app, 'node_modules', 'electron', 'install.js');
        if (!electronInstalled() && fs.existsSync(getElectron)) {
          io.progress({ label: 'downloading Electron', done: 0, total: 0 });
          await must(io, process.execPath, [getElectron], { cwd: paths.app, env }, 'Couldn\'t download Electron.', hint);
        }
        if (!electronInstalled()) throw new StepError('Electron didn\'t finish installing.', hint);
        fs.writeFileSync(APP_STAMP, appLockHash());
        note = 'installed and built';
      }
      await must(io, npm, [...pre, 'run', 'build'], { cwd: paths.app, env }, 'Couldn\'t build the companion app.', 'Read the lines above; this is most likely a bug in the repo.');
      return { note };
    },
  },

  {
    id: 'launcher',
    doing: "Adding Bookwyrm to your apps. A second.",
    title: isMac ? 'Bookwyrm in your Applications' : isWin ? 'Bookwyrm in the Start menu' : 'Bookwyrm in your app menu',
    detect: () => ({ done: false }),
    plan: () => [`installLauncher(${paths.app}) → ${loadLauncher().launcherPath()}`],
    async run(ctx) {
      if (!electronInstalled()) throw new StepError('The companion app isn\'t installed yet.', 'Run setup again without skipping the "app" step.');
      try {
        ctx.launcher = loadLauncher().installLauncher(paths.app);
      } catch (err) {
        throw new StepError(`Couldn't create the launcher: ${err.message}`, 'You can still start Bookwyrm with: cd app && npm start');
      }
      return { note: ctx.launcher };
    },
  },

  {
    id: 'settings',
    doing: "Saving your settings. A second.",
    title: 'Your settings',
    detect: () => ({ done: false }),
    plan: (ctx) => [`merge ${JSON.stringify(settingsPatch(ctx))} into ${paths.settings}`],
    async run(ctx) {
      writeSettings(ctx);
      return { note: paths.settings };
    },
  },
];

export const STEP_IDS = STEPS.map((s) => s.id);

/**
 * One tiny Hermes run on the profile: proves the model settings (Anthropic or the gateway) work
 * end to end, through Hermes itself. Hermes not answering yet is a warning, not a failure: the
 * api step already said so. A run that fails is a real problem with the model settings.
 */
async function thinkCheck(ctx, io) {
  const key = readEnvFile(path.join(profileDir(ctx.profile), '.env')).API_SERVER_KEY;
  const base = `http://127.0.0.1:${HERMES_PORT}/p/${ctx.profile}/v1`;
  if (!key || !(await httpAlive(`http://127.0.0.1:${HERMES_PORT}/`))) {
    return { warn: 'Hermes\' background service isn\'t answering, so I couldn\'t check Bookwyrm can think. Run: hermes gateway restart' };
  }
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  try {
    io.log('Asking Bookwyrm to say "ready"…');
    const start = await fetch(`${base}/runs`, {
      method: 'POST', headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ input: 'Reply with the single word: ready', session_id: `setup-check-${Date.now()}`, instructions: 'This is an automated setup check. Do not use any tools.' }),
    });
    if (!start.ok) return { warn: `Hermes wouldn't start a check run (HTTP ${start.status}). Try: hermes gateway restart` };
    const { run_id: runId } = await start.json();
    const events = await fetch(`${base}/runs/${runId}/events`, { headers, signal: AbortSignal.timeout(120_000) });
    let said = '';
    for (const line of (await events.text()).split('\n')) {
      if (!line.startsWith('data:')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.event === 'message.delta' && ev.delta) said += ev.delta;
      if (ev.event === 'run.failed') {
        const why = String(ev.error?.message || ev.error || ev.message || 'no reason given').split('\n')[0].slice(0, 300);
        throw new StepError(`Bookwyrm couldn't think: the model call failed (${why}).`, ctx.answers.provider === 'gateway'
          ? 'Check the gateway address, model name and key (Settings → Model in the app, or run setup again).'
          : 'Check the Anthropic key (Settings in the app, or run setup again).');
      }
    }
    if (!said.trim()) return { warn: 'Bookwyrm\'s check run finished without saying anything. If it doesn\'t answer on a call, check the model settings.' };
    return { note: `Bookwyrm answered "${said.trim().slice(0, 40)}"` };
  } catch (err) {
    if (err instanceof StepError) throw err;
    return { warn: `Couldn't finish the thinking check (${err.message}).` };
  }
}

function voiceHash() {
  return sha256(readText(path.join(paths.voice, 'pyproject.toml')) || '');
}

function mcpAsset() {
  const os = isMac ? 'Darwin' : isWin ? 'Windows' : 'Linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  return `github-mcp-server_${os}_${arch}.${isWin ? 'zip' : 'tar.gz'}`;
}

function mcpBinFor(ctx) {
  return ctx.opts.githubMcpBin ? path.resolve(ctx.opts.githubMcpBin) : paths.mcpBin;
}

// ---- settings.json --------------------------------------------------------------------------------

const SETTINGS_DEFAULTS = { voice: 'af_heart', voice_speed: 1.0, calls_you: false, watch_minutes: 5 };

function settingsPatch(ctx) {
  const { name, team, repo, provider, gatewayUrl, gatewayModel, registry } = ctx.answers;
  const patch = { profile: ctx.profile };
  // A company registry (a fork of Archivist, say) is remembered; the default isn't written.
  if (registry && registry !== DEFAULT_REGISTRY) patch.registry = registry;
  if (name) patch.name = name;
  if (team) patch.team = team;
  if (repo) patch.repo = repo;
  // Remembered so the next setup run (and every update) keeps the same way of reaching Claude.
  if (provider === 'gateway') patch.model = { provider, base_url: gatewayUrl, name: gatewayModel };
  else if (provider) patch.model = { provider: 'anthropic' };
  return patch;
}

export function writeSettings(ctx) {
  const existing = readJson(paths.settings) || {};
  // Defaults only fill gaps; existing values (and keys we don't know) are kept.
  const merged = { name: '', team: '', repo: '', ...SETTINGS_DEFAULTS, profile: ctx.profile, ...existing, ...settingsPatch(ctx) };
  fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
  fs.writeFileSync(paths.settings, `${JSON.stringify(merged, null, 2)}\n`);
}
