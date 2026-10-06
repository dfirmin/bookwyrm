// Runs the selected steps in order and reports each step's state to whoever is watching
// (the Ink checklist or the plain-text printer).
import { STEPS } from './steps.js';
import { selectedSteps } from './state.js';
import { paths } from './sys.js';

const tilde = (line) => line.split(paths.home).join('~');

/**
 * hooks.update(id, patch) — status: pending | running | done | already | skipped | warn | failed | plan
 * hooks.onFailure(step, err) → 'retry' | 'skip' | 'quit'
 * Resolves to { quit: boolean }.
 */
export async function runSteps(ctx, hooks) {
  const chosen = selectedSteps(ctx.opts);
  for (const step of STEPS) {
    if (!chosen.includes(step.id)) {
      hooks.update(step.id, { status: 'skipped', note: 'not selected' });
      continue;
    }
    let found = step.detect(ctx);
    if (!found.done && step.detectAsync) found = await step.detectAsync(ctx);
    if (found.done) {
      hooks.update(step.id, { status: 'already', note: found.note });
      continue;
    }
    if (ctx.opts.dryRun) {
      hooks.update(step.id, { status: 'plan', plan: step.plan(ctx).map(tilde) });
      continue;
    }
    for (;;) {
      hooks.update(step.id, { status: 'running', line: '', progress: null, error: null });
      const io = {
        log: (line) => hooks.update(step.id, { line }),
        progress: (progress) => hooks.update(step.id, { progress }),
      };
      try {
        const result = (await step.run(ctx, io)) || {};
        hooks.update(step.id, result.warn
          ? { status: 'warn', note: result.warn, progress: null, line: '' }
          : { status: 'done', note: result.note && tilde(result.note), progress: null, line: '' });
        break;
      } catch (err) {
        const error = { message: err.message, hint: err.hint, lines: err.lines || [] };
        if (!err.hint) error.lines = [...error.lines, ...(err.stack || '').split('\n').slice(1, 4)];
        hooks.update(step.id, { status: 'failed', error, progress: null, line: '' });
        const choice = await hooks.onFailure(step, error);
        if (choice === 'retry') continue;
        if (choice === 'quit') return { quit: true };
        break; // skip: leave it marked failed and carry on
      }
    }
  }
  return { quit: false };
}
