// Smoke test of the real main process (main.js): start it, then drive it the way the renderer
// does over IPC: open and close the card, drag the robot, open the Bookwyrm window, hide and show.
//   xvfb-run -a npx electron --no-sandbox tests/smoke.js
// Uses a temporary BOOKWYRM_HOME so your saved robot position is left alone.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.BOOKWYRM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bw-smoke-"));
const { app, BrowserWindow, ipcMain, screen } = require("electron");
require("../main.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (ch, ...args) => ipcMain.emit(ch, { sender: null }, ...args);
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };

app.whenReady().then(async () => {
  await wait(2500);
  const [companion] = BrowserWindow.getAllWindows();
  check(!!companion, "companion window exists");
  const { workArea: wa } = screen.getPrimaryDisplay();
  const b0 = companion.getBounds();
  check(b0.width === 76 && b0.x + b0.width <= wa.x + wa.width && b0.x > wa.x + wa.width / 2, `robot docked on the right (${JSON.stringify(b0)})`);

  emit("window:shape", "open");
  await wait(200);
  const b1 = companion.getBounds();
  check(b1.width === 394 && b1.x + b1.width === b0.x + b0.width && b1.y + b1.height === b0.y + b0.height,
    "card opens to the left and above, robot stays put");
  emit("window:shape", "docked");
  await wait(200);

  // Drag: move the window as the cursor would, then let go near the top left.
  emit("drag:start");
  companion.setPosition(wa.x + 40, wa.y + 60);
  emit("drag:end");
  await wait(200);
  const b2 = companion.getBounds();
  check(b2.x <= wa.x + 60 && b2.y <= wa.y + 80, `robot stays where it was dropped (${b2.x},${b2.y})`);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.BOOKWYRM_HOME, "companion.json"), "utf8"));
  check(saved.robot && saved.robot.x === b2.x, "position remembered");

  emit("window:shape", "open");
  await wait(200);
  const b3 = companion.getBounds();
  check(b3.x === b2.x && b3.y === b2.y, "on the top left, the card opens to the right and below");
  emit("window:shape", "docked");

  // Dropped half off screen: pulled back on.
  emit("drag:start");
  companion.setPosition(wa.x + wa.width - 20, wa.y + wa.height - 10);
  emit("drag:end");
  await wait(200);
  const b4 = companion.getBounds();
  check(b4.x + b4.width <= wa.x + wa.width && b4.y + b4.height <= wa.y + wa.height, "never left off screen");

  emit("window:open", { view: "settings" });
  await wait(2500);
  const win = BrowserWindow.getAllWindows().find((w) => w !== companion);
  check(!!win && win.isVisible(), "Bookwyrm window opens");
  const title = await win.webContents.executeJavaScript("document.getElementById('view-title').textContent");
  check(title === "Settings", `opens on the page asked for (${title})`);

  const hide = ipcMain._invokeHandlers?.get?.("companion:set-visible");
  if (hide) {
    await hide({ sender: win.webContents }, false);
    check(!companion.isVisible(), "robot hides");
    await hide({ sender: win.webContents }, true);
    check(companion.isVisible(), "and comes back");
  }

  console.log(failures ? `${failures} FAILED` : "all passed");
  app.exit(failures ? 1 : 0);
});
