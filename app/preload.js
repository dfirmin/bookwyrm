const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bookwyrm", {
  voiceUrl: () => ipcRenderer.invoke("voice:url"),
  health: () => ipcRenderer.invoke("voice:health"),
  setShape: (shape) => ipcRenderer.send("window:shape", shape),
  dragonMenu: () => ipcRenderer.send("menu:dragon"),
  setInteractive: (on) => ipcRenderer.send("window:interactive", on),
});
