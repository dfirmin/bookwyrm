// Unit tests for launcher.js, run against a temporary home: node --test app/tests/launcher.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const launcher = require('../launcher.js');

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-launcher-'));
  const appDir = path.join(home, 'my bookwyrm', 'app'); // a space, like real home folders
  fs.mkdirSync(path.join(appDir, 'build'), { recursive: true });
  return { home, appDir, env: { APPDATA: path.join(home, 'AppData', 'Roaming') } };
}

test('electronBinary per platform', () => {
  const dist = path.join('/x/app', 'node_modules', 'electron', 'dist');
  assert.equal(launcher.electronBinary('/x/app', { platform: 'darwin' }), path.join(dist, 'Electron.app/Contents/MacOS/Electron'));
  assert.equal(launcher.electronBinary('/x/app', { platform: 'linux' }), path.join(dist, 'electron'));
  assert.equal(launcher.electronBinary('/x/app', { platform: 'win32' }), path.join(dist, 'electron.exe'));
});

test('linux: desktop entry, quoted Exec, autostart on and off', () => {
  const { home, appDir } = tempHome();
  const opts = { platform: 'linux', home };
  const file = launcher.installLauncher(appDir, opts);
  assert.equal(file, path.join(home, '.local/share/applications/bookwyrm.desktop'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\[Desktop Entry\]$/m);
  assert.ok(text.includes(`Exec="${path.join(appDir, 'node_modules/electron/dist/electron')}" "${appDir}"`));
  assert.match(text, /^Icon=accessories-dictionary$/m);

  assert.equal(launcher.isOpenAtLogin(opts), false);
  const item = launcher.setOpenAtLogin(true, appDir, opts);
  assert.equal(item, path.join(home, '.config/autostart/bookwyrm.desktop'));
  assert.equal(launcher.isOpenAtLogin(opts), true);
  assert.match(fs.readFileSync(item, 'utf8'), /X-GNOME-Autostart-enabled=true/);
  launcher.setOpenAtLogin(false, appDir, opts);
  assert.equal(launcher.isOpenAtLogin(opts), false);
  launcher.setOpenAtLogin(false, appDir, opts); // idempotent
});

test('linux: uses build/icon.png when present', () => {
  const { home, appDir } = tempHome();
  fs.writeFileSync(path.join(appDir, 'build', 'icon.png'), 'png');
  const text = fs.readFileSync(launcher.installLauncher(appDir, { platform: 'linux', home }), 'utf8');
  assert.ok(text.includes(`Icon=${path.join(appDir, 'build', 'icon.png')}`));
});

// The macOS bundle is simulated with POSIX paths and file modes, which a Windows host doesn't
// have; these run on the macOS and Linux CI runners.
const POSIX_ONLY = { skip: process.platform === 'win32' && 'needs POSIX paths and file modes' };

test('macOS: wrapper bundle with Info.plist, executable script, icon, login agent', POSIX_ONLY, () => {
  const { home, appDir } = tempHome();
  fs.writeFileSync(path.join(appDir, 'build', 'icon.icns'), 'icns');
  const opts = { platform: 'darwin', home };
  const app = launcher.installLauncher(appDir, opts);
  assert.equal(app, path.join(home, 'Applications', 'Bookwyrm.app'));

  const info = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
  for (const s of ['<key>CFBundleName</key>\n\t<string>Bookwyrm</string>',
    '<key>CFBundleIdentifier</key>\n\t<string>com.dfirmin.bookwyrm</string>',
    '<key>LSUIElement</key>\n\t<true/>',
    '<key>NSMicrophoneUsageDescription</key>\n\t<string>Bookwyrm listens when you call it.</string>',
    '<key>CFBundleIconFile</key>\n\t<string>icon</string>',
    '<key>CFBundleExecutable</key>\n\t<string>Bookwyrm</string>']) {
    assert.ok(info.includes(s), `Info.plist lacks ${s}`);
  }
  assert.ok(fs.existsSync(path.join(app, 'Contents', 'Resources', 'icon.icns')));

  const exe = path.join(app, 'Contents', 'MacOS', 'Bookwyrm');
  assert.equal(fs.statSync(exe).mode & 0o777, 0o755);
  const script = fs.readFileSync(exe, 'utf8');
  assert.ok(script.startsWith('#!/bin/sh\n'));
  assert.ok(script.includes(`exec '${launcher.electronBinary(appDir, opts)}' '${appDir}' "$@"`));

  const agent = launcher.setOpenAtLogin(true, appDir, opts);
  assert.equal(agent, path.join(home, 'Library', 'LaunchAgents', 'com.dfirmin.bookwyrm.plist'));
  const plist = fs.readFileSync(agent, 'utf8');
  assert.ok(plist.includes('<string>/usr/bin/open</string>'));
  assert.ok(plist.includes(`<string>${app}</string>`));
  assert.ok(plist.includes('<key>RunAtLoad</key>\n\t<true/>'));
  assert.equal(launcher.isOpenAtLogin(opts), true);
  launcher.setOpenAtLogin(false, appDir, opts);
  assert.equal(launcher.isOpenAtLogin(opts), false);
});

test('macOS: re-running replaces the bundle cleanly (icon removed later)', () => {
  const { home, appDir } = tempHome();
  const icon = path.join(appDir, 'build', 'icon.icns');
  fs.writeFileSync(icon, 'icns');
  const opts = { platform: 'darwin', home };
  launcher.installLauncher(appDir, opts);
  fs.rmSync(icon);
  const app = launcher.installLauncher(appDir, opts);
  assert.ok(!fs.existsSync(path.join(app, 'Contents', 'Resources')));
  assert.ok(!fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes('CFBundleIconFile'));
});

test('macOS: shell quoting survives an apostrophe in the path', POSIX_ONLY, () => {
  const { home } = tempHome();
  const appDir = path.join(home, "Dee's stuff", 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const app = launcher.installLauncher(appDir, { platform: 'darwin', home });
  const script = fs.readFileSync(path.join(app, 'Contents', 'MacOS', 'Bookwyrm'), 'utf8');
  assert.ok(script.includes(`'${home}/Dee'\\''s stuff/app'`));
});

test('windows: Start Menu and Startup shortcuts via WScript.Shell', () => {
  const { home, appDir, env } = tempHome();
  const calls = [];
  const fakeSpawnSync = (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    fs.mkdirSync(path.dirname(o.env.BW_LNK), { recursive: true });
    fs.writeFileSync(o.env.BW_LNK, 'lnk');
    return { status: 0, stdout: '', stderr: '' };
  };
  const opts = { platform: 'win32', home, env, spawnSync: fakeSpawnSync };
  const lnk = launcher.installLauncher(appDir, opts);
  assert.equal(lnk, path.join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Bookwyrm.lnk'));
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.ok(calls[0].args.at(-1).includes('WScript.Shell'));
  assert.equal(calls[0].env.BW_TARGET, launcher.electronBinary(appDir, opts));
  assert.equal(calls[0].env.BW_ARGS, `"${appDir}"`);

  const startup = launcher.setOpenAtLogin(true, appDir, opts);
  assert.equal(startup, path.join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/Bookwyrm.lnk'));
  assert.equal(launcher.isOpenAtLogin(opts), true);
  launcher.setOpenAtLogin(false, appDir, opts);
  assert.equal(launcher.isOpenAtLogin(opts), false);
});

test('windows: a failing PowerShell is reported, not swallowed', () => {
  const { home, appDir, env } = tempHome();
  const opts = { platform: 'win32', home, env, spawnSync: () => ({ status: 1, stderr: 'COM blocked' }) };
  assert.throws(() => launcher.installLauncher(appDir, opts), /COM blocked/);
});

test('defaults to the real platform and os.homedir() (HOME)', () => {
  const { home, appDir } = tempHome();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    if (process.platform === 'linux') {
      assert.equal(launcher.installLauncher(appDir), path.join(home, '.local/share/applications/bookwyrm.desktop'));
    }
  } finally {
    process.env.HOME = saved;
  }
});
