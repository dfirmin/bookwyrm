// End-to-end: the real renderer places a real call to the running voice service.
// Chromium's fake microphone plays a WAV; we choose "Call Bookwyrm" from the robot's menu, wait,
// read the card, hang up, and check the call landed in the conversation history.
//   xvfb-run -a npx electron tests/e2e.js <question.wav> <seconds> <screenshot.png>
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const [wav, seconds, shot] = process.argv.slice(-3);
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", path.resolve(wav));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const VOICE = "http://127.0.0.1:7865";
ipcMain.handle("voice:url", () => VOICE);
ipcMain.handle("voice:health", async () => (await fetch(`${VOICE}/health`)).json());
ipcMain.handle("os:info", () => ({ platform: process.platform, accent: null }));
for (const ch of ["window:shape", "window:interactive", "menu:robot", "call:state", "drag:start", "drag:end"]) ipcMain.on(ch, () => {});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true));
  const win = new BrowserWindow({
    width: 470, height: 560, show: false,
    webPreferences: { preload: path.join(__dirname, "..", "preload.js"), contextIsolation: true },
  });
  win.webContents.on("console-message", (_e, _lvl, msg) => { if (/error|fail/i.test(msg)) console.log("[renderer]", msg); });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 800));
  win.webContents.send("action", { action: "call" });   // what the robot's menu sends
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < Number(seconds) * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await win.webContents.executeJavaScript(
      "document.body.dataset.state + ' | ' + document.getElementById('status').textContent");
    if (s !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s  ${s}`); last = s; }
  }
  const lines = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#lines li')].map(li => li.textContent).join('\\n')");
  console.log("CARD:\n" + lines);
  const msgs = await win.webContents.executeJavaScript(
    "JSON.stringify((window.__rtvi||[]).filter(m=>m.type==='bot-output').slice(0,6).map(m=>m.data))");
  console.log("BOT-OUTPUT:", msgs);
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.getElementById('hangup').click()");
  await new Promise((r) => setTimeout(r, 2500));
  const hist = await (await fetch(`${VOICE}/api/history`)).json();
  const call = hist.find((c) => c.kind === "call");
  console.log("HISTORY:", call ? `${call.title} (${call.count} messages, ${call.voice} by voice)` : "no call saved");
  app.quit();
});
