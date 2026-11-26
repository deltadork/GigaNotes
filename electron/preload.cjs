// Small bridge for the desktop app: the quick-capture window hides itself and learns when it was opened,
// and the Settings page reads and changes the quick-capture hotkey.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gg", {
  hideCapture: () => ipcRenderer.send("capture:hide"),
  onCaptureShow: (cb) => ipcRenderer.on("capture:show", () => cb()),
  getHotkey: () => ipcRenderer.invoke("hotkey:get"),
  // Resolves to null when saved, or to an error message to show the user.
  setHotkey: (accel) => ipcRenderer.invoke("hotkey:set", accel),
});
