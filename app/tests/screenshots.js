// Render the companion in each state and save screenshots (design review; no voice service needed).
//   xvfb-run -a npx electron tests/screenshots.js <outdir>
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const out = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(out, { recursive: true });
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("force-device-scale-factor", "2");

const SIZES = { docked: { width: 150, height: 176 }, open: { width: 470, height: 560 } };
ipcMain.handle("voice:url", () => "http://127.0.0.1:9");
ipcMain.handle("voice:health", () => null);
ipcMain.on("window:shape", () => {});
ipcMain.on("menu:dragon", () => {});

const DESKTOP = "html{background:linear-gradient(160deg,#7f8f96,#a9b5b0)!important}";

const SCENES = {
  "1-docked": { shape: "docked", js: `document.body.dataset.state='idle'` },
  "2-ringing": { shape: "open", js: `
    document.body.dataset.state='ringing'; document.body.dataset.shape='open';
    document.getElementById('status').textContent='Calling Bookwyrm…'; hangup.hidden=false;` },
  "3-on-call": { shape: "open", js: `
    document.body.dataset.state='speaking'; document.body.dataset.shape='open';
    document.body.style.setProperty('--level','0.7');
    document.getElementById('status').textContent='On a call · 1:42'; stamp.textContent='9:41 PM'; stamp.hidden=false;
    const add=(cls,who,t)=>{const li=document.createElement('li');li.className=cls;
      if(who){const w=document.createElement('span');w.className='who';w.textContent=who;li.append(w)}
      li.append(t);lines.append(li)};
    add('bot','Bookwyrm','Hey Dee! What\\'s up?');
    add('you','You','What\\'s in quarantine right now?');
    add('bot','Bookwyrm','Let me check the repo. Just one thing is in quarantine: the social media guidelines. Marketing owns it, but Marketing isn\\'t in the teams list yet, so Archivist didn\\'t know where to put it.');
    add('you','You','Who leads Marketing?');
    add('bot','Bookwyrm','The bundle doesn\\'t say. Do you know? If you give me a name, I\\'ll draft the change and show it to you first.');
    mute.hidden=false; type.hidden=false; hangup.hidden=false;` },
  "4-incoming": { shape: "open", js: `
    document.body.dataset.state='ringing'; document.body.dataset.shape='open';
    document.getElementById('status').textContent='Calling you…'; reason.textContent='New in quarantine: vendor-onboarding-notes.md'; reason.hidden=false;
    answer.hidden=false; decline.hidden=false;` },
  "5-ended-typing": { shape: "open", js: `
    document.body.dataset.state='idle'; document.body.dataset.shape='open';
    document.getElementById('status').textContent='Call ended';
    const li=document.createElement('li'); li.className='note'; li.textContent='Call ended after 3:12.'; lines.append(li);
    answer.textContent='Call again'; decline.textContent='Close'; answer.hidden=false; decline.hidden=false; type.hidden=false;
    document.getElementById('type-form').hidden=false; document.getElementById('type-input').value='Draft the Marketing team entry';` },
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    ...SIZES.open, show: false, frame: false, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, "..", "preload.js"), contextIsolation: true },
  });
  for (const [name, scene] of Object.entries(SCENES)) {
    win.setContentSize(SIZES[scene.shape].width, SIZES[scene.shape].height);
    for (let i = 0; i < 3; i++) {
      try { await win.loadFile(path.join(__dirname, "..", "renderer", "index.html")); break; }
      catch (e) { await new Promise((r) => setTimeout(r, 300)); }
    }
    await win.webContents.insertCSS(DESKTOP + " *{animation-play-state:paused!important}");
    await win.webContents.executeJavaScript(`(()=>{${scene.js}})()`);
    await new Promise((r) => setTimeout(r, 700));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  }
  app.quit();
});
