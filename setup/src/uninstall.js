// Removing Bookwyrm from this computer: `setup.mjs --uninstall` (or uninstall.sh / uninstall.ps1).
//
// What it removes, and what it leaves:
//   - the launcher (Applications / Start menu / .desktop) and "open at login";
//   - Bookwyrm's Hermes profile (its config, skills it learned, memory and keys);
//   - Hermes' background service, but only when no other Hermes profile uses it;
//   - ~/.bookwyrm (settings, history, the copy of the knowledge repo, speech models, Node, the
//     GitHub connector) and ~/bookwyrm (the program), unless it's a clone with local changes.
//   Hermes itself, uv, and anything on GitHub (pull requests, issues, the token) are left alone.
//
// It asks once, listing exactly what it will delete (--yes skips that; --dry-run only lists).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLauncher } from './steps.js';
import { findHermes, httpAlive, isWin, paths, profileDir, run } from './sys.js';

const VOICE = 'http://127.0.0.1:7865/health';

/** Is this folder the Bookwyrm program (not something else that happens to be called bookwyrm)? */
export function looksLikeBookwyrm(dir) {
  return ['app/launcher.js', 'setup/package.json', 'voice/pyproject.toml', 'profile/SOUL.md']
    .every((f) => fs.existsSync(path.join(dir, f)));
}

/** A folder it would be dangerous to delete whole, whatever it's called. */
export function tooBroad(dir) {
  const d = path.resolve(dir);
  const home = path.resolve(os.homedir());
  return d === path.parse(d).root || d === home || home.startsWith(d + path.sep);
}

/** Uncommitted or unpushed work in a git clone of the program: then it's kept. */
async function localWork(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const status = await run('git', ['-C', dir, 'status', '--porcelain'], { timeoutMs: 15_000 });
  if (status.code !== 0) return null;   // no git here: nothing to protect that we can see
  if (status.lines.some((l) => l.trim())) return 'it has uncommitted changes';
  const ahead = await run('git', ['-C', dir, 'rev-list', '--count', '@{upstream}..HEAD'], { timeoutMs: 15_000 });
  if (ahead.code === 0 && Number(ahead.lines.join('').trim()) > 0) return 'it has commits that aren\'t pushed';
  return null;
}

function otherProfiles(profile) {
  try {
    return fs.readdirSync(path.join(paths.hermesHome, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== profile).map((d) => d.name);
  } catch {
    return [];
  }
}

/** What uninstalling would do on this computer, in order. Nothing is changed. */
export async function plan(profile, launcherOpts) {
  const L = loadLauncher();
  const items = [];
  const add = (what, target, note = '') => items.push({ what, target, note });

  for (const [what, file] of [['App launcher', L.launcherPath(launcherOpts)], ['Open at login', L.loginItemPath(launcherOpts)]]) {
    if (fs.existsSync(file)) add(what, file);
  }
  const hermes = findHermes();
  const others = otherProfiles(profile);
  if (hermes && !others.length) add('Hermes background service', 'hermes gateway stop', '(no other Hermes profiles use it)');
  if (fs.existsSync(profileDir(profile))) add(`Hermes profile "${profile}"`, profileDir(profile), '(its keys and memory)');
  const keep = [];
  if (hermes && others.length) keep.push(`Hermes' background service: other Hermes profiles use it (${others.join(', ')}).`);

  if (fs.existsSync(paths.bookwyrm)) {
    if (tooBroad(paths.bookwyrm)) keep.push(`${paths.bookwyrm}: BOOKWYRM_HOME points at a folder too broad to delete.`);
    else add('Settings, history, repo copy, speech models', paths.bookwyrm);
  }
  if (paths.models !== path.join(paths.bookwyrm, 'models') && fs.existsSync(paths.models)) {
    keep.push(`${paths.models}: speech models in a folder of your choosing (BOOKWYRM_MODELS_DIR).`);
  }
  if (!looksLikeBookwyrm(paths.repo) || tooBroad(paths.repo)) {
    keep.push(`${paths.repo}: doesn't look like the Bookwyrm program folder.`);
  } else {
    const why = await localWork(paths.repo);
    if (why) keep.push(`${paths.repo}: ${why}. Delete it yourself when you're done with it.`);
    else add('The program', paths.repo);
  }
  return { items, keep };
}

/** Remove a folder this process may be running from. On Windows that can't be done while it runs,
 *  so it's handed to a short script that waits for this process to end. */
function removeDir(dir, later) {
  if (!isWin) { fs.rmSync(dir, { recursive: true, force: true }); return; }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    later.push(dir);
  }
}

function finishOnWindows(dirs) {
  if (!dirs.length) return;
  const script = path.join(os.tmpdir(), `bookwyrm-uninstall-${process.pid}.cmd`);
  const lines = [
    '@echo off',
    // Wait for this setup process (and the Node it runs on) to exit.
    `:wait`,
    `tasklist /FI "PID eq ${process.pid}" 2>NUL | find "${process.pid}" >NUL && (timeout /t 1 /nobreak >NUL & goto wait)`,
    ...dirs.map((d) => `rmdir /s /q "${d}"`),
    'del "%~f0"',
  ];
  fs.writeFileSync(script, `${lines.join('\r\n')}\r\n`);
  spawn('cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export async function uninstall(ctx, { ask, out }) {
  const { profile } = ctx;
  out('Uninstall Bookwyrm');
  out('');

  // The app has to be closed first: its files are in use while it runs.
  while (!ctx.opts.dryRun && await httpAlive(VOICE)) {
    out('Bookwyrm is running. Quit it first: click the robot and choose Quit Bookwyrm (or use its');
    out(`${process.platform === 'darwin' ? 'menu-bar' : 'tray'} icon).`);
    if (ctx.opts.yes) { out('Stopped: quit Bookwyrm, then run this again.'); return 1; }
    const a = (await ask('Press Enter once it has quit, or type q to stop: ')).trim().toLowerCase();
    if (a === 'q') return 1;
  }

  const { items, keep } = await plan(profile);
  if (!items.length) {
    out('Nothing of Bookwyrm is left on this computer.');
    for (const k of keep) out(`  Kept: ${k}`);
    return 0;
  }
  out('This removes:');
  for (const it of items) out(`  - ${it.what}: ${it.target}${it.note ? ` ${it.note}` : ''}`);
  out('');
  out('And leaves:');
  for (const k of keep) out(`  - ${k}`);
  out('  - Hermes itself and uv, which other tools may use (remove them from their own docs if not).');
  out('  - Everything on GitHub: your pull requests, issues and the knowledge repo itself.');
  out('');
  if (ctx.opts.dryRun) { out('Dry run: nothing was removed.'); return 0; }
  if (!ctx.opts.yes) {
    const a = (await ask('Remove all of that? Type yes to continue: ')).trim().toLowerCase();
    if (a !== 'yes' && a !== 'y') { out('Nothing was removed.'); return 1; }
  }

  const L = loadLauncher();
  const later = [];
  let failed = 0;
  for (const it of items) {
    try {
      if (it.what === 'Hermes background service') {
        const hermes = findHermes();
        const help = await run(hermes, ['gateway', '--help'], { timeoutMs: 30_000 });
        await run(hermes, ['gateway', 'stop'], { timeoutMs: 60_000 });
        // Older Hermes builds have no uninstall; stopping it is the most that can be done then.
        if (/\buninstall\b/.test(help.lines.join('\n'))) await run(hermes, ['gateway', 'uninstall'], { timeoutMs: 60_000 });
      } else if (it.what === 'Open at login') {
        L.setOpenAtLogin(false);
      } else if (it.what === 'App launcher') {
        fs.rmSync(it.target, { recursive: true, force: true });
      } else {
        removeDir(it.target, later);
      }
      out(`  ✓ ${it.what}`);
    } catch (err) {
      failed++;
      out(`  ✗ ${it.what}: ${err.message}`);
    }
  }
  finishOnWindows(later);
  out('');
  out(later.length ? 'Done. The last folders are removed as soon as this window closes.' : 'Done. Bookwyrm is removed from this computer.');
  out('Last step, on the web: revoke the GitHub token you made for Bookwyrm');
  out('  (https://github.com/settings/personal-access-tokens), and the Anthropic key or gateway key if it was only for Bookwyrm.');
  return failed ? 1 : 0;
}
