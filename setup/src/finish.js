// The last bit: open at login, open now, and where to find Bookwyrm later.
import fs from 'node:fs';
import { loadLauncher } from './steps.js';
import { isMac, isWin, paths } from './sys.js';

export const needsAbout = (chosen) => chosen.includes('profile') || chosen.includes('settings');
export const needsKeys = (chosen) => chosen.includes('profile');

export function appReady() {
  try {
    return fs.existsSync(loadLauncher().electronBinary(paths.app));
  } catch {
    return false;
  }
}

/** Applies the two end-of-setup choices; returns lines to show. */
export function finish(ctx, { openAtLogin, openNow }) {
  const lines = [];
  if (ctx.opts.dryRun || !appReady()) return lines;
  const launcher = loadLauncher();
  if (openAtLogin !== undefined) {
    try {
      launcher.setOpenAtLogin(Boolean(openAtLogin), paths.app);
      lines.push(openAtLogin ? '✓ Bookwyrm will start when you log in.' : '✓ Bookwyrm won\'t start at login.');
    } catch (err) {
      lines.push(`! Couldn't change the start-at-login setting: ${err.message}`);
    }
  }
  if (openNow) {
    try {
      launcher.launchApp(paths.app);
      lines.push('✓ Opening Bookwyrm. Look for the dragon at the bottom right of your screen.');
    } catch (err) {
      lines.push(`! Couldn't open Bookwyrm: ${err.message}`);
    }
  }
  return lines;
}

export function openLaterHint() {
  if (!appReady()) return '';
  if (isMac) return 'Open it any time from Applications → Bookwyrm (or Spotlight: "Bookwyrm").';
  if (isWin) return 'Open it any time from the Start menu: Bookwyrm.';
  return 'Open it any time from your app menu: Bookwyrm.';
}
