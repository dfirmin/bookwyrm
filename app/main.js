// Bookwyrm: a small robot that sits at the edge of the screen, and the Bookwyrm window.
//
// - The companion window is transparent and always on top. It holds the robot and, when open,
//   the call card beside it. Drag the robot anywhere; click it for its menu.
// - The menu-bar (macOS) / tray (Windows, Linux) icon is always there: call, open the window,
//   show or hide the robot, quit.
// - The Bookwyrm window has conversation history, the library (what needs you in the repo) and
//   settings.
// - The voice service (../voice) is started here if it isn't already running.

const {
  app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, nativeTheme, screen, session,
  shell, systemPreferences,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const launcher = require("./launcher.js");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const VOICE_URL = process.env.BOOKWYRM_VOICE_URL || "http://127.0.0.1:7865";
const REPO_DIR = path.resolve(__dirname, "..");
const VOICE_DIR = path.join(REPO_DIR, "voice");
const DATA_DIR = process.env.BOOKWYRM_HOME || path.join(os.homedir(), ".bookwyrm");
const VOICE_LOG = path.join(DATA_DIR, "voice.log");
const COMPANION_STATE = path.join(DATA_DIR, "companion.json");
const SETUP_SCRIPT = path.join(REPO_DIR, "setup", "dist", "setup.mjs");

// The robot's box (the docked window) and the window when the card is open beside it.
const ROBOT = 76;
const OPEN = { width: 394, height: 540 };
const EDGE = 12;

let companion = null;
let bookwyrmWindow = null;
let tray = null;
let voiceProc = null;
let voiceExit = null;     // why the service we started stopped, if it did
let shape = "docked";
let layout = { side: "left", v: "up" };
let robotPos = null;      // top-left of the robot's box, in screen coordinates
let onCall = false;
let state = readJson(COMPANION_STATE) || {};

// ---- small helpers ----------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function saveState(patch) {
  state = { ...state, ...patch };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COMPANION_STATE, JSON.stringify(state, null, 2));
  } catch {}
}
function lastLines(file, n) {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").slice(-n).join("\n"); } catch { return ""; }
}
async function api(pathname, init) {
  const r = await fetch(`${VOICE_URL}${pathname}`, { signal: AbortSignal.timeout(5000), ...init });
  return r.json();
}

// ---- where the robot sits -----------------------------------------------------------------------

function clampToDisplay(p, size = { width: ROBOT, height: ROBOT }) {
  const { workArea: wa } = screen.getDisplayNearestPoint({ x: p.x + size.width / 2, y: p.y + size.height / 2 });
  return {
    x: Math.round(Math.min(Math.max(p.x, wa.x), wa.x + wa.width - size.width)),
    y: Math.round(Math.min(Math.max(p.y, wa.y), wa.y + wa.height - size.height)),
  };
}

function defaultRobotPos() {
  const { workArea: wa } = screen.getPrimaryDisplay();
  return { x: wa.x + wa.width - ROBOT - EDGE, y: wa.y + wa.height - ROBOT - EDGE * 4 };
}

// Window bounds for a shape. The robot stays where it is; the card opens toward the middle of
// the screen (left of a robot on the right half, above a robot on the bottom half).
function boundsFor(next) {
  if (next !== "open") return { ...robotPos, width: ROBOT, height: ROBOT };
  const { workArea: wa } = screen.getDisplayNearestPoint({ x: robotPos.x + ROBOT / 2, y: robotPos.y + ROBOT / 2 });
  layout = {
    side: robotPos.x + ROBOT / 2 > wa.x + wa.width / 2 ? "left" : "right",
    v: robotPos.y + ROBOT / 2 > wa.y + wa.height / 2 ? "up" : "down",
  };
  const x = layout.side === "left" ? robotPos.x + ROBOT - OPEN.width : robotPos.x;
  const y = layout.v === "up" ? robotPos.y + ROBOT - OPEN.height : robotPos.y;
  return { ...clampToDisplay({ x, y }, OPEN), ...OPEN };
}

function applyShape(next) {
  shape = next;
  if (!companion) return;
  const b = boundsFor(next);
  companion.webContents.send("layout", layout);
  companion.setBounds(b, false);
}

// Where the robot's box is inside the window right now.
function robotOffset() {
  if (shape !== "open") return { x: 0, y: 0 };
  const b = companion.getBounds();
  return { x: layout.side === "left" ? b.width - ROBOT : 0, y: layout.v === "up" ? b.height - ROBOT : 0 };
}

let dragTimer = null;
ipcMain.on("drag:start", () => {
  if (!companion || dragTimer) return;
  const start = screen.getCursorScreenPoint();
  const [wx, wy] = companion.getPosition();
  const grab = { x: start.x - wx, y: start.y - wy };
  dragTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    companion.setPosition(Math.round(p.x - grab.x), Math.round(p.y - grab.y), false);
  }, 16);
});
ipcMain.on("drag:end", () => {
  clearInterval(dragTimer);
  dragTimer = null;
  if (!companion) return;
  const [wx, wy] = companion.getPosition();
  const off = robotOffset();
  robotPos = clampToDisplay({ x: wx + off.x, y: wy + off.y });
  saveState({ robot: robotPos });
  applyShape(shape);   // settle on screen; an open card may flip to the other side
});

// ---- the companion window ---------------------------------------------------------------------

function createCompanion() {
  robotPos = state.robot ? clampToDisplay(state.robot) : defaultRobotPos();
  companion = new BrowserWindow({
    ...boundsFor("docked"),
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: "Bookwyrm",
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  companion.setAlwaysOnTop(true, "floating");
  if (IS_MAC) companion.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  companion.loadFile(path.join(__dirname, "renderer", "index.html"));
  companion.once("ready-to-show", () => { if (!state.hidden) companion.showInactive(); });
  // Clicks pass through the transparent parts to whatever is behind; the renderer turns
  // clicks back on while the pointer is over the robot or the card.
  companion.setIgnoreMouseEvents(true, { forward: true });
  companion.on("closed", () => (companion = null));
  screen.on("display-removed", () => { robotPos = clampToDisplay(robotPos); applyShape(shape); });
  screen.on("display-metrics-changed", () => { robotPos = clampToDisplay(robotPos); applyShape(shape); });
}

function setCompanionVisible(visible) {
  if (!companion) return;
  if (visible) companion.showInactive();
  else {
    companion.webContents.send("action", { action: "close-card" });
    companion.hide();
    if (!state.toldAboutHide && Notification.isSupported()) {
      new Notification({
        title: "Bookwyrm is still here",
        body: IS_MAC ? "Click its icon in the menu bar to bring the robot back." : "Click its icon in the system tray to bring the robot back.",
        silent: true,
      }).show();
      saveState({ toldAboutHide: true });
    }
  }
  saveState({ hidden: !visible });
  refreshTray();
}

function act(action, extra = {}) {
  if (!companion) return;
  if (!companion.isVisible()) setCompanionVisible(true);
  companion.webContents.send("action", { action, ...extra });
}

ipcMain.on("window:shape", (_e, next) => { if (next !== shape) applyShape(next); });
ipcMain.on("window:interactive", (_e, on) => { companion?.setIgnoreMouseEvents(!on, { forward: true }); });
ipcMain.on("call:state", (_e, on) => {
  onCall = !!on;
  bookwyrmWindow?.webContents.send("call:state", onCall);
  refreshTray();
});
ipcMain.on("call:continue", (_e, sessionId) => act("continue-call", { session_id: sessionId }));

async function callsYouItem() {
  let prefs = { calls_you: false, watch_configured: false };
  try { prefs = await api("/api/prefs"); } catch {}
  return {
    label: "Let Bookwyrm call me",
    type: "checkbox",
    checked: !!prefs.calls_you,
    enabled: !!prefs.watch_configured,
    toolTip: "When something new lands in quarantine or a new gap is filed",
    click: (item) => api("/api/prefs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ calls_you: item.checked }),
    }).catch(() => {}),
  };
}

const QUIT = { label: "Quit Bookwyrm", accelerator: IS_MAC ? "Cmd+Q" : undefined, click: () => app.quit() };

ipcMain.on("menu:robot", async (_e, s) => {
  let items;
  if (s.phase === "on-call") {
    items = [
      { label: "Hang up", click: () => act("hangup") },
      s.muted ? { label: "Unmute", click: () => act("unmute") } : { label: "Mute", click: () => act("mute") },
      { type: "separator" },
      { label: "Open Bookwyrm", click: () => openBookwyrmWindow() },
      { type: "separator" },
      QUIT,
    ];
  } else if (s.phase === "ringing" || s.phase === "connecting") {
    items = [{ label: "Cancel call", click: () => act("hangup") }, { type: "separator" }, QUIT];
  } else {
    items = [
      { label: "Call Bookwyrm", click: () => act("call") },
      { label: "Send a message", click: () => act("message") },
      ...(s.cardOpen ? [{ label: "Close card", click: () => act("close-card") }] : []),
      { type: "separator" },
      { label: "Open Bookwyrm", click: () => openBookwyrmWindow() },
      { label: "Library", click: () => openBookwyrmWindow({ view: "library" }) },
      await callsYouItem(),
      { type: "separator" },
      { label: "Hide robot", click: () => setCompanionVisible(false) },
      QUIT,
    ];
  }
  Menu.buildFromTemplate(items).popup({ window: companion });
});

// ---- menu bar / system tray ---------------------------------------------------------------------

function trayImage() {
  const dir = path.join(__dirname, "build");
  if (IS_MAC) {
    const img = nativeImage.createFromPath(path.join(dir, "trayTemplate.png"));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(dir, IS_WIN ? "tray.ico" : "tray.png"));
}

async function refreshTray() {
  if (!tray) return;
  const visible = !!companion?.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    onCall ? { label: "Hang up", click: () => act("hangup") } : { label: "Call Bookwyrm", click: () => act("call") },
    { label: "Send a message", enabled: !onCall, click: () => act("message") },
    { label: "Open Bookwyrm", click: () => openBookwyrmWindow() },
    { type: "separator" },
    { label: "Show robot", type: "checkbox", checked: visible, click: (i) => setCompanionVisible(i.checked) },
    await callsYouItem(),
    { label: "Settings…", click: () => openBookwyrmWindow({ view: "settings" }) },
    { type: "separator" },
    QUIT,
  ]));
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch {
    return;   // some Linux desktops have no tray; the robot's own menu still has everything
  }
  tray.setToolTip("Bookwyrm");
  if (IS_WIN) tray.on("click", () => tray.popUpContextMenu());
  refreshTray();
  setInterval(refreshTray, 60_000);   // pick up "calls you" changes made elsewhere
}

// ---- the Bookwyrm window --------------------------------------------------------------------------

function openBookwyrmWindow(opts = {}) {
  if (bookwyrmWindow) {
    if (bookwyrmWindow.isMinimized()) bookwyrmWindow.restore();
    bookwyrmWindow.show();
    bookwyrmWindow.focus();
    bookwyrmWindow.webContents.send("window:show", opts);
    return;
  }
  const dark = nativeTheme.shouldUseDarkColors;
  bookwyrmWindow = new BrowserWindow({
    width: 1040, height: 700, minWidth: 720, minHeight: 460,
    title: "Bookwyrm",
    show: false,
    icon: path.join(__dirname, "build", "icon.png"),
    ...(IS_MAC ? {
      titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 },
      vibrancy: "sidebar", visualEffectState: "followWindow", backgroundColor: "#00000000",
    } : IS_WIN ? {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#00000000", symbolColor: dark ? "#ffffff" : "#000000", height: 40 },
      backgroundMaterial: "mica", backgroundColor: "#00000000",
    } : { backgroundColor: dark ? "#1e1e1e" : "#f6f6f6", autoHideMenuBar: true }),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  const query = new URLSearchParams(Object.entries(opts).filter(([, v]) => v)).toString();
  bookwyrmWindow.loadFile(path.join(__dirname, "renderer", "window.html"), { search: query });
  bookwyrmWindow.once("ready-to-show", () => bookwyrmWindow.show());
  bookwyrmWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  bookwyrmWindow.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); shell.openExternal(url); } });
  if (IS_MAC) app.dock.show();
  bookwyrmWindow.on("closed", () => {
    bookwyrmWindow = null;
    if (IS_MAC) app.dock.hide();
  });
}

ipcMain.on("window:open", (_e, opts) => openBookwyrmWindow(opts));
ipcMain.on("open:external", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

nativeTheme.on("updated", () => {
  if (IS_WIN && bookwyrmWindow) {
    bookwyrmWindow.setTitleBarOverlay({ color: "#00000000", symbolColor: nativeTheme.shouldUseDarkColors ? "#ffffff" : "#000000" });
  }
});

// ---- OS look --------------------------------------------------------------------------------------

function osInfo() {
  let accent = null;
  try {
    const raw = systemPreferences.getAccentColor?.();   // "RRGGBBAA" on macOS and Windows
    if (raw && /^[0-9a-f]{6}/i.test(raw)) accent = `#${raw.slice(0, 6)}`;
  } catch {}
  let accentText = "#ffffff";
  if (accent) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255);
    if (0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6) accentText = "#000000";
  }
  return { platform: process.platform, accent, accentText };
}
ipcMain.handle("os:info", () => osInfo());
function broadcastOsInfo() {
  const info = osInfo();
  for (const w of [companion, bookwyrmWindow]) w?.webContents.send("os:info", info);
}
if (IS_WIN) systemPreferences.on?.("accent-color-changed", broadcastOsInfo);

// ---- voice service --------------------------------------------------------------------------------

async function voiceHealth() {
  try {
    const r = await fetch(`${VOICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return null;
  }
}

const voicePython = () => IS_WIN
  ? path.join(VOICE_DIR, ".venv", "Scripts", "python.exe")
  : path.join(VOICE_DIR, ".venv", "bin", "python");

function startVoiceService() {
  if (!fs.existsSync(voicePython())) return false; // not set up; the card explains how
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(VOICE_LOG, "w");
  voiceExit = null;
  const proc = spawn(voicePython(), ["-m", "bookwyrm_voice.server"], {
    cwd: VOICE_DIR, stdio: ["ignore", log, log], windowsHide: true,
  });
  voiceProc = proc;
  proc.on("exit", (code, signal) => {
    if (voiceProc === proc) voiceProc = null;
    voiceExit = { code, signal, tail: lastLines(VOICE_LOG, 6) };
  });
  return true;
}

function stopVoiceService() {
  if (!voiceProc) return;
  voiceProc.kill();
  voiceProc = null;
}

// What the card should say: {ok, hermes, models, loading, error} from the service when it answers,
// otherwise why it doesn't: not set up, starting, or stopped (with the end of its log).
ipcMain.handle("voice:health", async () => {
  const h = await voiceHealth();
  if (h) return h;
  if (!fs.existsSync(voicePython())) return { down: "not-set-up" };
  if (voiceExit) return { down: "stopped", detail: voiceExit.tail, log: VOICE_LOG };
  if (voiceProc) return { down: "starting" };
  startVoiceService();   // e.g. a copy started by hand was closed: start ours
  return { down: "starting" };
});
ipcMain.handle("voice:url", () => VOICE_URL);
ipcMain.handle("voice:restart", async () => {
  stopVoiceService();
  await new Promise((r) => setTimeout(r, 800));
  return startVoiceService();
});

// ---- settings that live outside the voice service ----------------------------------------------

ipcMain.handle("login:get", () => launcher.isOpenAtLogin());
ipcMain.handle("login:set", (_e, on) => { launcher.setOpenAtLogin(!!on, __dirname); return launcher.isOpenAtLogin(); });
ipcMain.handle("companion:visible", () => !!companion?.isVisible());
ipcMain.handle("companion:set-visible", (_e, on) => { setCompanionVisible(!!on); return !!on; });
ipcMain.handle("app:info", () => ({
  version: app.getVersion(), repoDir: REPO_DIR, dataDir: DATA_DIR, log: VOICE_LOG,
  platform: process.platform, setup: fs.existsSync(SETUP_SCRIPT),
}));

// The knowledge repo and the keys also change the Hermes profile, so they go through the setup
// wizard (run with Electron's own Node, no terminal needed). So does the model: Anthropic directly,
// or a company gateway. Keys travel by environment only, never on the command line.
ipcMain.handle("setup:apply", (e, changes = {}) => new Promise((resolve) => {
  if (!fs.existsSync(SETUP_SCRIPT)) {
    resolve({ ok: false, message: "The setup wizard isn't installed here. Run the Bookwyrm installer again." });
    return;
  }
  const args = [SETUP_SCRIPT, "--yes", "--plain", "--only", "profile,api,check,settings", "--no-open"];
  if (changes.repo) args.push("--repo", changes.repo);
  if (changes.provider) args.push("--provider", changes.provider);
  if (changes.provider === "gateway") args.push("--gateway-url", changes.gatewayUrl, "--gateway-model", changes.gatewayModel);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.ANTHROPIC_API_KEY;
  delete env.LITELLM_API_KEY;
  delete env.GITHUB_PERSONAL_ACCESS_TOKEN;
  if (changes.anthropicKey) env.ANTHROPIC_API_KEY = changes.anthropicKey;
  if (changes.gatewayKey) env.LITELLM_API_KEY = changes.gatewayKey;
  if (changes.githubToken) env.GITHUB_PERSONAL_ACCESS_TOKEN = changes.githubToken;
  const child = spawn(process.execPath, args, { cwd: REPO_DIR, env, windowsHide: true });
  const send = (buf) => {
    for (const l of buf.toString().split(/\r?\n/)) if (l.trim()) e.sender.send("setup:line", l);
  };
  child.stdout.on("data", send);
  child.stderr.on("data", send);
  child.on("error", (err) => resolve({ ok: false, message: err.message }));
  child.on("exit", async (code) => {
    try { await api("/api/settings/reload", { method: "POST" }); } catch {}
    resolve({ ok: code === 0, code });
  });
}));

// ---- lifecycle ------------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();   // already running: the running copy opens its window (below)
} else {
  app.on("second-instance", () => openBookwyrmWindow());
  app.setName("Bookwyrm");
  if (IS_WIN) app.setAppUserModelId("com.dfirmin.bookwyrm");

  app.whenReady().then(async () => {
    if (IS_MAC) {
      app.dock.hide();
      // CI and tests have no one to answer the prompt.
      if (!process.env.BOOKWYRM_NO_MIC_PROMPT) await systemPreferences.askForMediaAccess("microphone");
    }
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
    if (!(await voiceHealth())) startVoiceService();
    createCompanion();
    createTray();
    // Opening Bookwyrm from the Applications folder / Start menu with the robot hidden would
    // look like nothing happened: show the window instead.
    if (state.hidden && !process.argv.includes("--background")) openBookwyrmWindow();
  });

  app.on("before-quit", () => stopVoiceService());
  // Closing the Bookwyrm window leaves the robot; only Quit ends the app.
  app.on("window-all-closed", (e) => e.preventDefault?.());
}
