const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld("bookwyrm", {
  // both windows
  voiceUrl: () => ipcRenderer.invoke("voice:url"),
  health: () => ipcRenderer.invoke("voice:health"),
  osInfo: () => ipcRenderer.invoke("os:info"),
  onOsInfo: on("os:info"),
  openWindow: (opts) => ipcRenderer.send("window:open", opts || {}),
  callFromWindow: (sessionId) => ipcRenderer.send("call:continue", sessionId || null),
  openExternal: (url) => ipcRenderer.send("open:external", url),

  // the companion
  setShape: (shape) => ipcRenderer.send("window:shape", shape),
  setInteractive: (on_) => ipcRenderer.send("window:interactive", on_),
  robotMenu: (state) => ipcRenderer.send("menu:robot", state),
  dragStart: () => ipcRenderer.send("drag:start"),
  dragEnd: () => ipcRenderer.send("drag:end"),
  callState: (onCall) => ipcRenderer.send("call:state", onCall),
  onAction: on("action"),
  onLayout: on("layout"),

  // the Bookwyrm window
  onShow: on("window:show"),
  onCallState: on("call:state"),
  loginItem: () => ipcRenderer.invoke("login:get"),
  setLoginItem: (on_) => ipcRenderer.invoke("login:set", on_),
  companionVisible: () => ipcRenderer.invoke("companion:visible"),
  setCompanionVisible: (on_) => ipcRenderer.invoke("companion:set-visible", on_),
  runSetup: (changes) => ipcRenderer.invoke("setup:apply", changes),
  targets: (opts) => ipcRenderer.invoke("targets:list", opts || {}),
  onSetupLine: on("setup:line"),
  restartVoice: () => ipcRenderer.invoke("voice:restart"),
  appInfo: () => ipcRenderer.invoke("app:info"),
});
