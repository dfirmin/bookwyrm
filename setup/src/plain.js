// Plain line-by-line setup: used when there's no interactive terminal to draw on (CI, logs, piped
// input) or with --plain. Asks its questions as simple prompts unless --yes.
import readline from 'node:readline';
import { runSteps } from './engine.js';
import { STEPS } from './steps.js';
import {
  ANTHROPIC_KEY_URL, GITHUB_TOKEN_URL, checkAnthropic, checkGateway, checkGitHub, checkGitHubToken, detectState,
  existingKeys, normalizeGatewayUrl, selectedSteps,
} from './state.js';
import { listTargets, validateTarget } from './registry.js';
import { addSecret, mask } from './sys.js';
import { finish, needsAbout, needsKeys, openLaterHint } from './finish.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const QUIET_MS = 30_000;
const fmtDuration = (ms) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
};
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

function prompter() {
  const terminal = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal });
  const lines = rl[Symbol.asyncIterator]();
  let muted = false;
  if (terminal) {
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => (muted ? (s.includes('\n') ? write('\n') : undefined) : write(s));
  }
  return {
    async ask(question, { secret = false } = {}) {
      process.stdout.write(question);
      muted = secret;
      const { value, done } = await lines.next();
      muted = false;
      if (done) throw new Error('setup needs answers, but the input ended. Use --yes to run without questions.');
      if (!terminal) out();
      return value.trim();
    },
    close: () => rl.close(),
  };
}

async function yesNo(p, question, def = true) {
  const a = (await p.ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

async function askKey(p, ctx, { label, existing, url, explain, check }) {
  for (;;) {
    out();
    explain.forEach((l) => out(`  ${l}`));
    out(/^https?:/.test(url) ? `  Get one at: ${url}` : `  Don't have one? ${url[0].toUpperCase()}${url.slice(1)}.`);
    const keepHint = existing ? `Enter keeps the one you have (${mask(existing)})` : 'Enter skips it for now';
    const value = await p.ask(`  ${label} (${keepHint}): `, { secret: true });
    const key = value || existing;
    if (!key) {
      out('  Skipped. Bookwyrm needs this to work; run setup again to add it.');
      return null;
    }
    addSecret(key);
    const result = await check(key);
    out(`  ${result.ok ? '✓' : '!'} ${result.message}`);
    if (result.ok || ctx.opts.yes || !(await yesNo(p, '  Try a different one?', true))) return value ? key : null;
  }
}

export async function runPlain(ctx) {
  const interactive = !ctx.opts.yes;
  const p = interactive ? prompter() : null;
  const chosen = selectedSteps(ctx.opts);
  out('Bookwyrm setup');
  out(ctx.opts.dryRun ? '(dry run: nothing will be changed)' : '');
  for (const s of detectState(ctx.profile)) out(`  ${s.ok ? '✓' : '·'} ${s.label}${s.ok ? '' : ': not yet'}`);

  try {
    if (interactive && needsAbout(chosen)) {
      out();
      out('About you');
      const a = ctx.answers;
      a.name = (await p.ask(`  Your name${a.name ? ` [${a.name}]` : ''}: `)) || a.name;
      a.team = (await p.ask(`  Your team${a.team ? ` [${a.team}]` : ''}: `)) || a.team;
    }
    if (needsKeys(chosen)) await keys(ctx, p);
    if (interactive && needsAbout(chosen)) await chooseRepo(ctx, p);
    if (!ctx.answers.repo && needsAbout(chosen) && !ctx.opts.dryRun) out('! No knowledge repo given (--repo owner/name); the profile step will need one.');

    out();
    out(ctx.opts.dryRun ? 'What setup would do' : 'Installing');
    const total = STEPS.length;
    const lastPct = {};
    let failed = 0;
    // A heartbeat while a step is quiet, so a long silent download doesn't look like a hang.
    let current = null;   // { title, startedAt, lastAt, beatAt }
    const beat = setInterval(() => {
      if (!current) return;
      const now = Date.now();
      if (now - current.lastAt >= QUIET_MS && now - current.beatAt >= QUIET_MS) {
        current.beatAt = now;
        out(`    ... still working on ${current.title} (${fmtDuration(now - current.startedAt)}); nothing new for ${fmtDuration(now - current.lastAt)}`);
      }
    }, 5000);
    beat.unref?.();   // never keeps setup alive on its own
    const result = await runSteps(ctx, {
      update(id, patch) {
        const i = STEPS.findIndex((s) => s.id === id);
        const tag = `[${String(i + 1).padStart(2)}/${total}] ${STEPS[i].title}`;
        if (patch.lastAt && current) current.lastAt = patch.lastAt;
        if (patch.status && patch.status !== 'running') current = null;
        if (patch.status === 'done' && patch.tookMs >= 10_000) patch = { ...patch, note: `${patch.note ? `${patch.note} ` : ''}(${fmtDuration(patch.tookMs)})` };
        switch (patch.status) {
          case 'running':
            current = { title: STEPS[i].title, startedAt: patch.startedAt, lastAt: patch.lastAt, beatAt: patch.startedAt };
            out(`→ ${tag}`);
            if (patch.doing) out(`    ${patch.doing}`);
            break;
          case 'already': out(`✓ ${tag}: ${patch.note || 'already done'}`); break;
          case 'skipped': out(`– ${tag}: skipped`); break;
          case 'done': out(`✓ ${tag}${patch.note ? `: ${patch.note}` : ''}`); break;
          case 'warn': out(`! ${tag}: ${patch.note}`); break;
          case 'plan': out(`→ ${tag}`); patch.plan.forEach((l) => out(`      ${l}`)); break;
          case 'failed':
            failed++;
            out(`✗ ${tag}: ${patch.error.message}`);
            patch.error.lines.forEach((l) => out(`      | ${l}`));
            if (patch.error.hint) out(`    What to try: ${patch.error.hint}`);
            break;
          default:
            if (patch.progress) {
              const { label, done, total: t, bytes } = patch.progress;
              if (t > 0) {
                const pct = Math.floor((done / t) * 10) * 10;
                if (lastPct[label] !== pct) {
                  lastPct[label] = pct;
                  out(`    ${label}: ${pct}%${bytes ? ` (${fmtBytes(done)} of ${fmtBytes(t)})` : ''}`);
                }
              } else if (label.includes('unpacking') && lastPct[label] == null) {
                lastPct[label] = 0;
                out(`    ${label}`);
              }
            }
        }
      },
      async onFailure() {
        if (!interactive) return 'skip';
        const a = (await p.ask('    [r]etry, [s]kip this step, or [q]uit? ')).toLowerCase();
        return a.startsWith('r') ? 'retry' : a.startsWith('q') ? 'quit' : 'skip';
      },
    });
    clearInterval(beat);
    out();
    if (result.quit) {
      out('Setup stopped. Run it again any time; it picks up where it left off.');
      return 1;
    }
    if (ctx.opts.dryRun) {
      out('Dry run finished. Nothing was changed.');
      return 0;
    }
    const ready = chosen.includes('launcher') || chosen.includes('app');
    let openAtLogin = ctx.opts.openAtLogin;
    let openNow = ctx.opts.open;
    if (interactive && ready) {
      if (openAtLogin === undefined) openAtLogin = await yesNo(p, 'Start Bookwyrm when you log in?', true);
      if (openNow === undefined) openNow = await yesNo(p, 'Open Bookwyrm now?', true);
    }
    for (const line of finish(ctx, { openAtLogin, openNow })) out(line);
    out(failed ? `Finished, but ${failed} step${failed > 1 ? 's' : ''} need${failed > 1 ? '' : 's'} attention (see above).` : 'Bookwyrm is ready.');
    const hint = openLaterHint(ctx);
    if (hint && !failed) out(hint);
    return failed ? 1 : 0;
  } finally {
    p?.close();
  }
}

async function chooseModel(ctx, p) {
  const a = ctx.answers;
  if (!p) {
    if (a.provider === 'gateway' && !(a.gatewayUrl && a.gatewayModel)) {
      throw new Error('--provider gateway needs --gateway-url and --gateway-model');
    }
    return;
  }
  out();
  out('How should Bookwyrm reach Claude?');
  out('  1. Anthropic directly, with an Anthropic API key');
  out('  2. My company\'s gateway (LiteLLM, or another OpenAI-compatible endpoint)');
  const def = a.provider === 'gateway' ? '2' : '1';
  const pick = (await p.ask(`  Choose 1 or 2 [${def}]: `)) || def;
  a.provider = pick.startsWith('2') ? 'gateway' : 'anthropic';
  if (a.provider !== 'gateway') return;
  for (let tries = 0; ; tries++) {
    const url = normalizeGatewayUrl((await p.ask(`  Gateway address, e.g. https://litellm.yourcompany.com/v1${a.gatewayUrl ? ` [${a.gatewayUrl}]` : ''}: `)) || a.gatewayUrl);
    if (/^https?:\/\/\S+$/.test(url)) { a.gatewayUrl = url; break; }
    out('  That should be a web address starting with https://.');
    if (tries >= 4) throw new Error('no gateway address given');
  }
  for (;;) {
    a.gatewayModel = (await p.ask(`  Model name on the gateway (what it calls Claude)${a.gatewayModel ? ` [${a.gatewayModel}]` : ''}: `)) || a.gatewayModel;
    if (a.gatewayModel) break;
  }
}

/** The key for whichever way Bookwyrm reaches Claude. */
function modelKeySpec(ctx, have) {
  const a = ctx.answers;
  if (a.provider === 'gateway') {
    return {
      field: 'gatewayKey', env: 'LITELLM_API_KEY', label: 'Gateway key', existing: have.gatewayKey,
      url: 'ask whoever runs the gateway',
      explain: [`Your key for ${a.gatewayUrl}. I'll check "${a.gatewayModel}" answers, streams and calls tools.`],
      check: async (k) => {
        const r = await checkGateway(a.gatewayUrl, k, a.gatewayModel);
        if (r.baseUrl) a.gatewayUrl = r.baseUrl;
        return r;
      },
    };
  }
  return {
    field: 'anthropicKey', env: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', existing: have.anthropicKey,
    url: ANTHROPIC_KEY_URL,
    explain: ['Bookwyrm thinks with Claude, through your Anthropic API key (starts with sk-ant-).'],
    check: checkAnthropic,
  };
}

async function keys(ctx, p) {
  const have = existingKeys(ctx.profile);
  const a = ctx.answers;
  await chooseModel(ctx, p);
  const spec = modelKeySpec(ctx, have);
  if (!p) {
    // --yes: environment first, then what the profile already has.
    a[spec.field] = process.env[spec.env] || null;
    a.githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null;
    addSecret(a[spec.field]);
    addSecret(a.githubToken);
    const modelKey = a[spec.field] || spec.existing;
    const gh = a.githubToken || have.githubToken;
    if (ctx.opts.dryRun) return;
    if (modelKey) { const r = await spec.check(modelKey); out(`${r.ok ? '✓' : '! warning:'} ${r.message}`); } else out(`! warning: no ${spec.env}`);
    if (gh && a.repo) { const r = await checkGitHub(gh, a.repo); out(`${r.ok ? '✓' : '! warning:'} ${r.message}`); } else if (!gh) out('! warning: no GITHUB_PERSONAL_ACCESS_TOKEN');
    return;
  }
  out();
  out('Keys');
  a[spec.field] = await askKey(p, ctx, spec);
  a.githubToken = await askKey(p, ctx, {
    label: 'GitHub token',
    existing: have.githubToken,
    url: GITHUB_TOKEN_URL,
    explain: [
      'A fine-grained GitHub token for your knowledge repo only.',
      'Repository access: Only select repositories → the knowledge repo.',
      'Permissions: Contents, Issues, Pull requests → Read and write. Nothing else.',
    ],
    check: checkGitHubToken,   // the next question shows which repos it covers
  });
}

/** Pick an active target from the Archivist registry (numbered list). */
async function chooseRepo(ctx, p) {
  const a = ctx.answers;
  const token = a.githubToken || existingKeys(ctx.profile).githubToken;
  let showTest = Boolean(ctx.opts.showTest);
  out();
  out('Knowledge repo');
  for (;;) {
    let list;
    try {
      list = await listTargets({ registry: a.registry, token, current: a.repo || a.savedRepo, showTest });
    } catch (err) {
      out(`  ! ${err.message}`);
      if (a.savedRepo && await yesNo(p, `  Keep ${a.savedRepo} for now (it's checked again next time)?`, true)) { a.repo = a.savedRepo; return; }
      if (!(await yesNo(p, '  Try again?', true))) throw new Error('no knowledge repo chosen');
      continue;
    }
    out(`  The repos Archivist runs on, from its registry (${list.source}):`);
    const current = a.repo || a.savedRepo;
    list.targets.forEach((t, i) => {
      const note = t.access === 'none' ? '  (your token can\'t reach it)' : t.access === 'read' ? '  (read-only for your token)' : '';
      out(`  ${String(i + 1).padStart(2)}. ${t.name}  ${t.repo}${t.type === 'test' ? '  (test)' : ''}${note}`);
    });
    const more = list.hiddenTest && !showTest;
    if (more) out(`   t. show ${list.hiddenTest} test target${list.hiddenTest > 1 ? 's' : ''}`);
    const def = Math.max(0, list.targets.findIndex((t) => t.repo === current)) + 1;
    const pick = (await p.ask(`  Choose a number${list.targets.length ? ` [${def}]` : ''}: `)) || String(def);
    if (more && pick.toLowerCase() === 't') { showTest = true; continue; }
    const target = list.targets[Number(pick) - 1];
    if (!target) { out('  That isn\'t one of the numbers above.'); continue; }
    const v = await validateTarget(target.repo, { registry: a.registry, token, keepIfUnreachable: target.repo === a.savedRepo });
    if (!v.ok) { out(`  ! ${v.message}`); continue; }
    out(`  ${v.warn ? `! ${v.warn}` : `✓ ${v.message}`}`);
    a.repo = target.repo;
    return;
  }
}
