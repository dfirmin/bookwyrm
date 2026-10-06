// Paths, finding programs, running commands, small file helpers. No UI here.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const exe = (name) => (isWin ? `${name}.exe` : name);

const HOME = os.homedir();
// setup/dist/setup.mjs (or setup/src/*.js) → the repo root two levels up.
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Bookwyrm's own folder; BOOKWYRM_HOME moves it (the voice service and app honour it too).
const DATA = process.env.BOOKWYRM_HOME || path.join(HOME, '.bookwyrm');

export const paths = {
  home: HOME,
  repo: REPO,
  app: path.join(REPO, 'app'),
  voice: path.join(REPO, 'voice'),
  bookwyrm: DATA,
  bin: path.join(DATA, 'bin'),
  settings: path.join(DATA, 'settings.json'),
  models: process.env.BOOKWYRM_MODELS_DIR || path.join(DATA, 'models'),
  mcpBin: path.join(DATA, 'bin', exe('github-mcp-server')),
  hermesHome: process.env.HERMES_HOME
    || (isWin ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'hermes') : path.join(HOME, '.hermes')),
  venvPython: path.join(REPO, 'voice', '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python'),
};
export const profileDir = (profile) => path.join(paths.hermesHome, 'profiles', profile);

// ---- finding programs ----------------------------------------------------------------------------

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function which(name) {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name + ext.toLowerCase());
      if (isFile(p)) return p;
    }
  }
  return null;
}

export function findIn(name, dirs) {
  const names = isWin ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of dirs) for (const n of names) if (isFile(path.join(dir, n))) return path.join(dir, n);
  return null;
}

export function findUv() {
  return which('uv') || findIn('uv', [
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, '.cargo', 'bin'),
    path.join(paths.hermesHome, 'bin'),
  ]);
}

export function findHermes() {
  const h = paths.hermesHome;
  return which('hermes') || findIn('hermes', isWin
    ? [path.join(h, 'bin'), path.join(h, 'hermes-agent', 'venv', 'Scripts'), path.join(h, 'hermes-agent', '.venv', 'Scripts')]
    : [path.join(HOME, '.local', 'bin'), path.join(h, 'hermes-agent', '.hermes', 'bin'), path.join(h, 'bin'), '/usr/local/bin']);
}

// Windows' own bsdtar unpacks .zip too; Git for Windows' GNU tar (often first on PATH) cannot.
export function tarBinary() {
  if (isWin) {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (isFile(sys)) return sys;
  }
  return 'tar';
}

// npm run by the same Node that runs this wizard (so a portable Node needs nothing on PATH).
export function npmCommand() {
  const dir = path.dirname(process.execPath);
  for (const cli of [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),          // Windows zip, Windows installer
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // macOS/Linux tarball, Homebrew-ish
  ]) {
    if (isFile(cli)) return [process.execPath, [cli]];
  }
  return [isWin ? 'npm.cmd' : 'npm', []];
}

// ---- running commands ----------------------------------------------------------------------------

const secrets = new Set();
export function addSecret(value) {
  if (value && value.length >= 8) secrets.add(value);
}
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{8,}/g, /github_pat_[A-Za-z0-9_]{8,}/g, /gh[pousr]_[A-Za-z0-9]{8,}/g];
export function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('••••');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '••••');
  return out;
}
export function mask(value) {
  if (!value) return '';
  return value.length > 12 ? `••••${value.slice(-4)}` : '••••';
}

// Strip ANSI colour codes and carriage-return progress noise from a child's output line.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const clean = (line) => line.replace(ANSI, '').split('\r').filter(Boolean).pop() || '';

export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // The same Node first, then the places uv/Hermes put their commands.
  const dirs = [path.dirname(process.execPath), path.join(HOME, '.local', 'bin')];
  if (isWin) dirs.push(path.join(paths.hermesHome, 'bin'));
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = [...dirs, env[key] || ''].join(path.delimiter);
  delete env.NODE_NO_WARNINGS;
  return env;
}

function quoteCmdArg(a) {
  return /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

/**
 * Run a command; resolve { code, lines } (never reject). Output lines are redacted, kept (last 300)
 * and passed to onLine as they arrive. timeoutMs kills a command that hangs (exit code 124).
 */
export function run(cmd, args = [], { cwd, env, onLine, input, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const lines = [];
    const push = (raw) => {
      const line = redact(clean(raw)).trimEnd();
      if (!line.trim()) return;
      lines.push(line);
      if (lines.length > 300) lines.shift();
      if (onLine) onLine(line);
    };
    let child;
    const opts = { cwd, env: env || childEnv(), windowsHide: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] };
    try {
      if (isWin && /\.(cmd|bat)$/i.test(cmd)) {
        // .cmd files need cmd.exe; quote every part ourselves.
        const line = [cmd, ...args].map(quoteCmdArg).join(' ');
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
      } else {
        child = spawn(cmd, args, opts);
      }
    } catch (err) {
      push(String(err.message));
      resolve({ code: 127, lines });
      return;
    }
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        const parts = buf.split('\n');
        buf = parts.pop();
        parts.forEach(push);
      });
      stream.on('end', () => { if (buf) push(buf); buf = ''; });
    }
    if (input != null) child.stdin.end(input);
    let timedOut = false;
    const timer = timeoutMs && setTimeout(() => {
      timedOut = true;
      push(`(stopped waiting after ${Math.round(timeoutMs / 1000)}s)`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => { push(err.code === 'ENOENT' ? `${cmd}: not found` : err.message); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? 1, lines, timedOut });
    });
  });
}

// ---- files ---------------------------------------------------------------------------------------

export function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function readJson(file) {
  const text = readText(file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function fileHash(file) {
  const text = readText(file);
  return text == null ? null : sha256(text);
}

// KEY=VALUE files: read values, and set values while keeping every other line as it was.
export function parseEnv(text) {
  const out = {};
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function readEnvFile(file) {
  return parseEnv(readText(file));
}

/** Set KEY=VALUE pairs in an env file (in place where the key exists, else appended). */
export function setEnvValues(file, values, { onlyIfMissing = false } = {}) {
  const original = readText(file) ?? '';
  const lines = original === '' ? [] : original.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
    if (idx >= 0) {
      if (!onlyIfMissing) lines[idx] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  const text = lines.join('\n') + '\n';
  const changed = text !== original;
  if (changed) writePrivate(file, text);
  else secureFile(file);
  return changed;
}

export function secureFile(file) {
  if (!isWin) {
    try { fs.chmodSync(file, 0o600); } catch { /* not ours to fix */ }
  }
}

export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  secureFile(file);
}

/** Write only when the content differs; returns whether it changed. */
export function writeIfChanged(file, text) {
  if (readText(file) === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

// ---- network ------------------------------------------------------------------------------------

export async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let done = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    done += chunk.length;
    if (onProgress) onProgress(done, total);
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
}

// Is anything answering HTTP on this local URL? Plain node:http, so no proxy gets in the way.
export function httpAlive(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
