// Bookwyrm companion: a small always-on-top dragon on the right edge of the screen.
// Click it to call Bookwyrm; right-click for settings.
//
// The window is transparent and resizes between two shapes:
//   docked   — just the dragon
//   open     — the call card to the left of the dragon
// The voice service (../voice) is started here if it isn't already running.

const { app, BrowserWindow, ipcMain, Menu, screen, session, systemPreferences, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const VOICE_URL = process.env.BOOKWYRM_VOICE_URL || "http://127.0.0.1:7865";
const VOICE_DIR = path.resolve(__dirname, "..", "voice");
const DOCKED = { width: 150, height: 176 };
const OPEN = { width: 470, height: 560 };
const MARGIN = 14;

let win = null;
let voiceProc = null;
let shape = "docked";

function place(size) {
  const { workArea } = screen.getPrimaryDisplay();
  const x = Math.round(workArea.x + workArea.width - size.width - MARGIN);
  const y = Math.round(workArea.y + workArea.height - size.height - MARGIN * 4);
  win.setBounds({ x, y, width: size.width, height: size.height }, false);
}

function createWindow() {
  win = new BrowserWindow({
    ...DOCKED,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  place(DOCKED);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Clicks pass through the transparent parts to whatever is behind; the renderer turns
  // clicks back on while the pointer is over the dragon or the card.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on("closed", () => (win = null));
}

// ---- voice service ---------------------------------------------------------------------------

async function voiceHealth() {
  try {
    const r = await fetch(`${VOICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return null;
  }
}

function startVoiceService() {
  const py = path.join(VOICE_DIR, ".venv", "bin", "python");
  if (!fs.existsSync(py)) return false; // not set up; the card explains how
  voiceProc = spawn(py, ["-m", "bookwyrm_voice.server"], { cwd: VOICE_DIR, stdio: "ignore" });
  voiceProc.on("exit", () => (voiceProc = null));
  return true;
}

ipcMain.handle("voice:health", async () => voiceHealth());
ipcMain.handle("voice:url", () => VOICE_URL);

// ---- window shape and menus ------------------------------------------------------------------

ipcMain.on("window:shape", (_e, next) => {
  if (!win || next === shape) return;
  shape = next;
  place(next === "open" ? OPEN : DOCKED);
});

ipcMain.on("window:interactive", (_e, on) => {
  if (win) win.setIgnoreMouseEvents(!on, { forward: true });
});

ipcMain.on("menu:dragon", async () => {
  let prefs = { calls_you: false, watch_configured: false };
  try {
    prefs = await (await fetch(`${VOICE_URL}/api/prefs`)).json();
  } catch {}
  const menu = Menu.buildFromTemplate([
    {
      label: "Let Bookwyrm call me about new quarantine and gaps",
      type: "checkbox",
      checked: !!prefs.calls_you,
      enabled: !!prefs.watch_configured,
      click: async (item) => {
        await fetch(`${VOICE_URL}/api/prefs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calls_you: item.checked }),
        }).catch(() => {});
      },
    },
    ...(prefs.watch_configured ? [] : [{ label: "Set BOOKWYRM_REPO and BOOKWYRM_GITHUB_TOKEN to enable calls", enabled: false }]),
    { type: "separator" },
    { label: "Hide for an hour", click: () => { win.hide(); setTimeout(() => win && win.showInactive(), 3600e3); } },
    { label: "Open setup guide", click: () => shell.openExternal("https://github.com/dfirmin/bookwyrm/blob/main/docs/setup-macos.md") },
    { type: "separator" },
    { label: "Quit Bookwyrm", role: "quit" },
  ]);
  menu.popup({ window: win });
});

// ---- lifecycle --------------------------------------------------------------------------------

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock.hide();
    await systemPreferences.askForMediaAccess("microphone");
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  if (!(await voiceHealth())) startVoiceService();
  createWindow();
});

app.on("before-quit", () => {
  if (voiceProc) voiceProc.kill();
});

app.on("window-all-closed", () => app.quit());
