// Plain line-by-line setup: used when there's no interactive terminal to draw on (CI, logs, piped
// input) or with --plain. Asks its questions as simple prompts unless --yes.
import readline from 'node:readline';
import { runSteps } from './engine.js';
import { STEPS } from './steps.js';
import {
  ANTHROPIC_KEY_URL, GITHUB_TOKEN_URL, REPO_RE, checkAnthropic, checkGitHub, detectState, existingKeys, selectedSteps,
} from './state.js';
import { addSecret, mask } from './sys.js';
import { finish, needsAbout, needsKeys, openLaterHint } from './finish.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
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
    out(`  Get one at: ${url}`);
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
      for (let tries = 0; ; tries++) {
        const repo = (await p.ask(`  Knowledge repo, owner/name${a.repo ? ` [${a.repo}]` : ''}: `)) || a.repo;
        if (REPO_RE.test(repo)) { a.repo = repo; break; }
        out('  That should look like owner/name, for example dfirmin/archivist-knowledge-01.');
        if (tries >= 4) throw new Error('no valid knowledge repo given');
      }
    }
    if (needsKeys(chosen)) await keys(ctx, p);
    if (!ctx.answers.repo && needsAbout(chosen) && !ctx.opts.dryRun) out('! No knowledge repo given (--repo owner/name); the profile step will need one.');

    out();
    out(ctx.opts.dryRun ? 'What setup would do' : 'Installing');
    const total = STEPS.length;
    const lastPct = {};
    let failed = 0;
    const result = await runSteps(ctx, {
      update(id, patch) {
        const i = STEPS.findIndex((s) => s.id === id);
        const tag = `[${String(i + 1).padStart(2)}/${total}] ${STEPS[i].title}`;
        switch (patch.status) {
          case 'running': out(`→ ${tag}`); break;
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

async function keys(ctx, p) {
  const have = existingKeys(ctx.profile);
  const a = ctx.answers;
  if (!p) {
    // --yes: environment first, then what the profile already has.
    a.anthropicKey = process.env.ANTHROPIC_API_KEY || null;
    a.githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null;
    addSecret(a.anthropicKey);
    addSecret(a.githubToken);
    const anth = a.anthropicKey || have.anthropicKey;
    const gh = a.githubToken || have.githubToken;
    if (ctx.opts.dryRun) return;
    if (anth) { const r = await checkAnthropic(anth); out(`${r.ok ? '✓' : '! warning:'} ${r.message}`); } else out('! warning: no ANTHROPIC_API_KEY');
    if (gh && a.repo) { const r = await checkGitHub(gh, a.repo); out(`${r.ok ? '✓' : '! warning:'} ${r.message}`); } else if (!gh) out('! warning: no GITHUB_PERSONAL_ACCESS_TOKEN');
    return;
  }
  out();
  out('Keys');
  a.anthropicKey = await askKey(p, ctx, {
    label: 'Anthropic API key',
    existing: have.anthropicKey,
    url: ANTHROPIC_KEY_URL,
    explain: ['Bookwyrm thinks with Claude, through your Anthropic API key (starts with sk-ant-).'],
    check: checkAnthropic,
  });
  a.githubToken = await askKey(p, ctx, {
    label: 'GitHub token',
    existing: have.githubToken,
    url: GITHUB_TOKEN_URL,
    explain: [
      `A fine-grained GitHub token for ${a.repo || 'the knowledge repo'} only.`,
      'Repository access: Only select repositories → the knowledge repo.',
      'Permissions: Contents, Issues, Pull requests → Read and write. Nothing else.',
    ],
    check: (t) => (a.repo ? checkGitHub(t, a.repo) : Promise.resolve({ ok: true, message: 'Not checked (no repo yet).' })),
  });
}
