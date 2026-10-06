// Render the robot, the call card and the Bookwyrm window, light and dark, and save screenshots.
//   xvfb-run -a npx electron tests/screenshots.js <outdir> [darwin|win32]
// Companion scenes need nothing running. Window scenes read the running voice service
// (history, library, settings) at 127.0.0.1:7865, so start it first for real content.
const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const argv = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.endsWith(".js") && a !== ".");
const OS = argv.find((a) => ["darwin", "win32"].includes(a)) || "darwin";
const out = path.resolve(argv.find((a) => a !== OS) || "screens");
fs.mkdirSync(out, { recursive: true });
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("force-device-scale-factor", "2");

const VOICE = "http://127.0.0.1:7865";
ipcMain.handle("voice:url", () => VOICE);
ipcMain.handle("voice:health", async () => { try { return await (await fetch(`${VOICE}/health`)).json(); } catch { return null; } });
ipcMain.handle("os:info", () => ({ platform: OS, accent: "#0a84ff", accentText: "#ffffff" }));
ipcMain.handle("login:get", () => true);
ipcMain.handle("companion:visible", () => true);
ipcMain.handle("app:info", () => ({ log: "~/.bookwyrm/voice.log", platform: OS }));
// The real registry lookup, as main.js does it: the setup wizard under Electron's own Node.
ipcMain.handle("targets:list", (_e, opts = {}) => new Promise((resolve) => {
  const { execFile } = require("node:child_process");
  const args = [path.join(__dirname, "..", "..", "setup", "dist", "setup.mjs"), "--targets-json", ...(opts.showTest ? ["--show-test-targets"] : [])];
  execFile(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (err, out) => {
    try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve({ error: err?.message || "no output" }); }
  });
}));
for (const ch of ["window:shape", "window:interactive", "menu:robot", "drag:start", "drag:end", "call:state", "window:open"]) ipcMain.on(ch, () => {});

// What sits behind the transparent companion on a real desktop, and the OS sidebar material.
const DESKTOP = "html{background:linear-gradient(160deg,#8fa3b8,#c9b8a8)!important}";
const MATERIAL = "body{background:light-dark(#e9e9eb,#2b2b2e)!important;color-scheme:light dark}";

const ROBOT = { width: 76, height: 76 };
const OPEN = { width: 394, height: 540 };

const card = (js) => `document.body.dataset.shape='open'; document.body.dataset.side='left'; document.body.dataset.v='up'; ${js}`;
const bubble = (cls, t) => `{const li=document.createElement('li');li.className='${cls}';li.textContent=${JSON.stringify(t)};lines.append(li)}`;

const COMPANION = {
  "robot-idle": { size: ROBOT, js: `document.body.dataset.state='idle'` },
  "robot-idle-dark": { size: ROBOT, dark: true, js: `document.body.dataset.state='idle'` },
  "robot-listening": { size: ROBOT, js: `document.body.dataset.state='listening'` },
  "robot-thinking": { size: ROBOT, js: `document.body.dataset.state='thinking'` },
  "card-ringing": { size: OPEN, js: card(`document.body.dataset.state='ringing'; status.textContent='Calling…'; hangup.hidden=false;`) },
  "card-on-call": { size: OPEN, js: card(`
    document.body.dataset.state='speaking'; document.body.style.setProperty('--level','0.7'); status.textContent='1:42';
    ${bubble("bot", "Hey Dee! What's up?")}
    ${bubble("you", "What's in quarantine right now?")}
    ${bubble("bot", "Just one thing: the social media guidelines. Marketing owns it, but Marketing isn't in the teams list yet, so Archivist didn't know where to put it.")}
    ${bubble("you", "Who leads Marketing?")}
    ${bubble("bot", "The bundle doesn't say. Do you know? Give me a name and I'll draft the change for you to look at first.")}
    mute.hidden=false; type.hidden=false; expand.hidden=false; hangup.hidden=false;`) },
  "card-on-call-dark": { size: OPEN, dark: true, js: card(`
    document.body.dataset.state='listening'; status.textContent='0:37';
    ${bubble("bot", "Hey Dee! What's up?")}
    ${bubble("you", "Any new gaps since Friday?")}
    ${bubble("bot", "Two. The weekly on-call handoff is missing its rollback section, and the post-incident review has no owner.")}
    mute.hidden=false; mute.setAttribute('aria-pressed','true'); type.hidden=false; expand.hidden=false; hangup.hidden=false;`) },
  "card-incoming": { size: OPEN, js: card(`
    document.body.dataset.state='ringing'; title.textContent='Bookwyrm'; status.textContent='Bookwyrm is calling you';
    reason.textContent='New in quarantine: vendor-onboarding-notes.md'; reason.hidden=false; answer.hidden=false; decline.hidden=false;`) },
  "card-message": { size: OPEN, js: card(`
    document.body.dataset.state='idle'; status.textContent='Message';
    ${bubble("you", "Is the phishing runbook up to date?")}
    ${bubble("bot", "Mostly. It was last changed in August, but it still names the old security on-call alias. Want me to draft the fix?")}
    expand.hidden=false; document.getElementById('type-form').hidden=false;`) },
};

const WINDOW = {
  "window-chat": { js: `document.querySelector('.conv')?.click()` },
  "window-new": { js: `document.getElementById('nav-new').click()` },
  "window-library": { js: `document.getElementById('nav-library').click()` },
  "window-settings": { js: `document.getElementById('nav-settings').click()` },
  "window-settings-model": { js: `document.getElementById("nav-settings").click(); setTimeout(()=>{document.getElementById("settings-view").querySelector(".scroller").scrollTop=250},900)` },
  "window-settings-switch": { js: `document.getElementById("nav-settings").click(); setTimeout(()=>{const f=document.getElementById("settings"); f.provider.value="anthropic"; f.provider.dispatchEvent(new Event("change")); document.getElementById("settings-view").querySelector(".scroller").scrollTop=250},2500)` },
  "window-settings-repo": { js: `document.getElementById("nav-settings").click(); setTimeout(()=>{document.getElementById("settings-view").querySelector(".scroller").scrollTop=520},6000)` },
  "window-chat-dark": { dark: true, js: `document.querySelector('.conv')?.click()` },
};

// loadFile can be aborted by a previous window going away; just try again.
async function load(win, file) {
  for (let i = 0; i < 5; i++) {
    try { await win.loadFile(path.join(__dirname, "..", "renderer", file)); return; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
}

app.whenReady().then(async () => {
  const prefs = { preload: path.join(__dirname, "..", "preload.js"), contextIsolation: true };
  let win = new BrowserWindow({ ...ROBOT, useContentSize: true, show: false, frame: false, webPreferences: prefs });
  for (const [name, scene] of Object.entries(COMPANION)) {
    nativeTheme.themeSource = scene.dark ? "dark" : "light";
    win.setContentSize(scene.size.width, scene.size.height);
    await load(win, "index.html");
    await win.webContents.insertCSS(DESKTOP + " *{animation-play-state:paused!important}");
    await win.webContents.executeJavaScript(`(()=>{const $=(i)=>document.getElementById(i);
      const [status,lines,reason,mute,type,expand,hangup,answer,decline,title]=['status','lines','reason','mute','type','expand','hangup','answer','decline','title'].map($);
      ${scene.js}})()`);
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    console.log("shot", name);
  }
  win.setContentSize(1040, 680);
  for (const [name, scene] of Object.entries(WINDOW)) {
    nativeTheme.themeSource = scene.dark ? "dark" : "light";
    await load(win, "window.html");
    await win.webContents.insertCSS(MATERIAL);
    await new Promise((r) => setTimeout(r, 1200));
    await win.webContents.executeJavaScript(scene.js);
    await new Promise((r) => setTimeout(r, name.includes("repo") ? 8000 : name.includes("library") || name.includes("switch") ? 3500 : 1500));
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    console.log("shot", name);
  }
  app.quit();
});
