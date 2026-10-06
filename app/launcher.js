// How people open Bookwyrm without a terminal: a launcher per OS, plus "open at login".
//
// Plain Node (fs, child_process) and CommonJS so both the installer (setup/) and Electron's main
// process can require it. Every function takes an optional `opts` ({ platform, home, env }) so the
// macOS/Windows/Linux branches can be exercised in tests with a temporary home directory.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const APP_NAME = 'Bookwyrm';
const BUNDLE_ID = 'com.dfirmin.bookwyrm';
const MIC_REASON = 'Bookwyrm listens when you call it.';

function ctx(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return { platform, env, home, appData };
}

// Path of the Electron executable installed in app/node_modules/electron/dist.
function electronBinary(appDir, opts) {
  const { platform } = ctx(opts);
  const dist = path.join(appDir, 'node_modules', 'electron', 'dist');
  if (platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (platform === 'win32') return path.join(dist, 'electron.exe');
  return path.join(dist, 'electron');
}

function launcherPath(opts) {
  const { platform, home, appData } = ctx(opts);
  if (platform === 'darwin') return path.join(home, 'Applications', `${APP_NAME}.app`);
  if (platform === 'win32') return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`);
  return path.join(home, '.local', 'share', 'applications', 'bookwyrm.desktop');
}

function loginItemPath(opts) {
  const { platform, home, appData } = ctx(opts);
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${BUNDLE_ID}.plist`);
  if (platform === 'win32') return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${APP_NAME}.lnk`);
  return path.join(home, '.config', 'autostart', 'bookwyrm.desktop');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Desktop Entry Exec= quoting: wrap in double quotes, backslash-escape " ` $ and \.
const desktopQuote = (s) => `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
}

function plist(dict) {
  const body = Object.entries(dict).map(([k, v]) => {
    let value;
    if (v === true || v === false) value = `<${v}/>`;
    else if (Array.isArray(v)) value = `<array>\n${v.map((x) => `\t\t<string>${xml(x)}</string>`).join('\n')}\n\t</array>`;
    else value = `<string>${xml(v)}</string>`;
    return `\t<key>${xml(k)}</key>\n\t${value}`;
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function desktopEntry(appDir, opts, extra = '') {
  const icon = path.join(appDir, 'build', 'icon.png');
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=Call your knowledge librarian',
    `Exec=${desktopQuote(electronBinary(appDir, opts))} ${desktopQuote(appDir)}`,
    `Path=${appDir}`,
    fs.existsSync(icon) ? `Icon=${icon}` : 'Icon=accessories-dictionary',
    'Terminal=false',
    'Categories=Office;Utility;',
    'StartupWMClass=bookwyrm-companion',
    extra,
  ].filter(Boolean).join('\n') + '\n';
}

// Windows shortcuts are made through WScript.Shell. Values travel in environment variables so
// no path ever needs PowerShell quoting.
function writeShortcut(lnk, target, args, workDir, icon, opts) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:BW_LNK) | Out-Null',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BW_LNK)',
    '$s.TargetPath = $env:BW_TARGET',
    '$s.Arguments = $env:BW_ARGS',
    '$s.WorkingDirectory = $env:BW_WORKDIR',
    '$s.Description = "Bookwyrm"',
    'if ($env:BW_ICON) { $s.IconLocation = "$($env:BW_ICON),0" }',
    '$s.Save()',
  ].join('; ');
  const env = { ...ctx(opts).env, BW_LNK: lnk, BW_TARGET: target, BW_ARGS: args, BW_WORKDIR: workDir, BW_ICON: icon || '' };
  const run = (opts && opts.spawnSync) || spawnSync;
  const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { env, encoding: 'utf8', windowsHide: true });
  if (res.error || res.status !== 0) {
    throw new Error(`Couldn't create the shortcut ${lnk}: ${(res.error && res.error.message) || (res.stderr || '').trim()}`);
  }
}

// Creates the normal way to open Bookwyrm for this OS and returns its path.
function installLauncher(appDir, opts) {
  appDir = path.resolve(appDir);
  const { platform } = ctx(opts);
  const electron = electronBinary(appDir, opts);
  const target = launcherPath(opts);

  if (platform === 'darwin') {
    // A tiny wrapper bundle, so Bookwyrm has its own name in Finder, Spotlight and the
    // microphone prompt. Its executable just hands over to Electron with the app folder.
    const contents = path.join(target, 'Contents');
    const icon = path.join(appDir, 'build', 'icon.icns');
    const info = {
      CFBundleName: APP_NAME,
      CFBundleDisplayName: APP_NAME,
      CFBundleIdentifier: BUNDLE_ID,
      CFBundleExecutable: APP_NAME,
      CFBundlePackageType: 'APPL',
      CFBundleVersion: '1',
      CFBundleShortVersionString: '0.1',
      LSUIElement: true,
      NSMicrophoneUsageDescription: MIC_REASON,
    };
    fs.rmSync(path.join(contents, 'Resources'), { recursive: true, force: true });
    if (fs.existsSync(icon)) {
      fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
      fs.copyFileSync(icon, path.join(contents, 'Resources', 'icon.icns'));
      info.CFBundleIconFile = 'icon';
    }
    writeFile(path.join(contents, 'Info.plist'), plist(info));
    writeFile(path.join(contents, 'MacOS', APP_NAME),
      `#!/bin/sh\n# Opens the Bookwyrm companion. Made by the Bookwyrm installer.\nexec ${shQuote(electron)} ${shQuote(appDir)} "$@"\n`, 0o755);
    return target;
  }

  if (platform === 'win32') {
    const icon = path.join(appDir, 'build', 'icon.ico');
    writeShortcut(target, electron, `"${appDir}"`, appDir, fs.existsSync(icon) ? icon : electron, opts);
    return target;
  }

  writeFile(target, desktopEntry(appDir, opts), 0o755);
  return target;
}

function setOpenAtLogin(on, appDir, opts) {
  const { platform } = ctx(opts);
  const item = loginItemPath(opts);
  if (!on) {
    fs.rmSync(item, { force: true });
    return item;
  }
  appDir = path.resolve(appDir || path.join(__dirname));

  if (platform === 'darwin') {
    const app = launcherPath(opts);
    const program = fs.existsSync(app)
      ? ['/usr/bin/open', '-a', app]
      : [electronBinary(appDir, opts), appDir];
    writeFile(item, plist({ Label: BUNDLE_ID, ProgramArguments: program, RunAtLoad: true, ProcessType: 'Interactive' }));
    return item;
  }

  if (platform === 'win32') {
    const icon = path.join(appDir, 'build', 'icon.ico');
    const electron = electronBinary(appDir, opts);
    writeShortcut(item, electron, `"${appDir}"`, appDir, fs.existsSync(icon) ? icon : electron, opts);
    return item;
  }

  writeFile(item, desktopEntry(appDir, opts, 'X-GNOME-Autostart-enabled=true'));
  return item;
}

function isOpenAtLogin(opts) {
  return fs.existsSync(loginItemPath(opts));
}

// Opens Bookwyrm the way a person would, detached from whatever started it.
function launchApp(appDir, opts) {
  appDir = path.resolve(appDir);
  const { platform } = ctx(opts);
  const launcher = launcherPath(opts);
  let cmd, args;
  if (platform === 'darwin' && fs.existsSync(launcher)) [cmd, args] = ['open', [launcher]];
  else if (platform === 'win32' && fs.existsSync(launcher)) [cmd, args] = ['cmd.exe', ['/d', '/c', 'start', '""', `"${launcher}"`]];
  else [cmd, args] = [electronBinary(appDir, opts), [appDir]];
  const child = spawn(cmd, args, {
    cwd: appDir, detached: true, stdio: 'ignore', windowsHide: true,
    windowsVerbatimArguments: platform === 'win32' && cmd === 'cmd.exe',
  });
  child.on('error', () => {});
  child.unref();
  return child;
}

module.exports = {
  electronBinary,
  installLauncher,
  setOpenAtLogin,
  isOpenAtLogin,
  launchApp,
  launcherPath,
  loginItemPath,
};
