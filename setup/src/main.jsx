// Bookwyrm setup: entry point. Picks the interactive wizard or plain output, then runs.
import { spawnSync } from 'node:child_process';
import { HELP, parseArgs, prefill } from './state.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Bookwyrm setup needs Node.js 22.12 or newer; this is ${process.version}. Run install.sh / install.ps1, which fetches one for you.`);
  process.exit(1);
}

// Behind a proxy, Node's fetch only uses HTTPS_PROXY when NODE_USE_ENV_PROXY is set at start-up.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (proxy && !process.env.NODE_USE_ENV_PROXY) {
  const res = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
  });
  process.exit(res.status ?? 1);
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`Bookwyrm setup: ${err.message}`);
  process.exit(2);
}
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const ctx = { opts, profile: opts.profile, answers: prefill(opts), hermes: null, uv: null, gatewayRestart: false };
const plain = opts.plain || opts.yes || !process.stdout.isTTY || !process.stdin.isTTY;

if (plain) {
  const { runPlain } = await import('./plain.js');
  try {
    process.exitCode = await runPlain(ctx);
  } catch (err) {
    console.error(`Bookwyrm setup stopped: ${err.message}`);
    process.exitCode = 1;
  }
} else {
  const [{ render }, React, { Wizard }] = await Promise.all([import('ink'), import('react'), import('./ui.jsx')]);
  const app = render(React.createElement(Wizard, { ctx }), { exitOnCtrlC: true, interactive: true });
  await app.waitUntilExit();
  process.exitCode = ctx.quit || ctx.failedCount ? 1 : 0;
}
