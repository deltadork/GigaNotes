// GigaNotes desktop shell. Runs the local server in this process, keeps the app in the tray,
// and opens the quick-capture window from a global hotkey. Closing a window only hides it.
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEFAULT_HOTKEY = "Control+Shift+N";
const SERVER = "http://127.0.0.1:3001";

// Dev (`npm run app`) uses the project folder; the packaged portable exe keeps data next to itself.
const appRoot = app.getAppPath();
const dataDir = app.isPackaged
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe")), "data")
  : path.join(appRoot, "data");
process.env.GIGA_DATA = process.env.GIGA_DATA || dataDir; // env override is for tests only
process.env.GIGA_STATIC = path.join(appRoot, "dist");

// The quick-capture hotkey is chosen in Settings and kept in the data folder next to the notes.
const SETTINGS_FILE = path.join(process.env.GIGA_DATA, "settings.json");
let hotkey = DEFAULT_HOTKEY;

let mainWin = null;
let captureWin = null;
let tray = null;
let quitting = false;

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
}

// An Electron accelerator like "Control+Shift+N": at least one modifier, then one key. A bare key is refused
// because it would steal that key from every other app.
function isValidHotkey(accel) {
  return typeof accel === "string" && accel.length <= 60 && /^((Control|Alt|Shift|Super)\+)+[^+]+$/.test(accel);
}

const shownHotkey = (accel) => accel.replace("Control", "Ctrl");

// One app at a time: a second launch just brings the first window up (the port is fixed).
// The second process must not go on to start a server, so everything below only runs when we got the lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on("second-instance", () => showMain());

function showMain() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

// Windows only ever show our own pages. A file dropped outside a drop zone would otherwise navigate
// the window to that file, and links must not replace the app.
function lockNavigation(win) {
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(SERVER + "/")) e.preventDefault();
  });
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1100,
    height: 800,
    title: "GigaNotes",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  lockNavigation(mainWin);
  mainWin.loadURL(SERVER + "/");
  // Windows logoff/shutdown: do not block it by hiding instead of closing.
  mainWin.on("session-end", () => { quitting = true; });
  // Closing the window keeps the app running (tray + hotkey). Quit is in the tray menu.
  mainWin.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

function createCapture() {
  captureWin = new BrowserWindow({
    width: 520,
    height: 300,
    title: "Quick capture",
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    resizable: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  lockNavigation(captureWin);
  captureWin.loadURL(SERVER + "/#/capture");
  // The page's <title> would otherwise replace this window's title.
  captureWin.on("page-title-updated", (e) => e.preventDefault());
  captureWin.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      captureWin.hide();
    }
  });
}

function showCapture() {
  if (!captureWin) return;
  captureWin.webContents.send("capture:show");
  captureWin.center();
  captureWin.show();
  captureWin.focus();
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: "Open GigaNotes", click: showMain },
    { label: `Quick capture (${shownHotkey(hotkey)})`, click: showCapture },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(path.join(appRoot, "electron", "icon.png"));
  tray.setToolTip("GigaNotes");
  tray.setContextMenu(trayMenu());
  tray.on("click", showMain);
}

// Swaps the global shortcut. The old one stays active until the new one is confirmed to work.
// Returns an error message for the Settings page, or null when the change was saved.
function changeHotkey(accel) {
  if (!isValidHotkey(accel)) return "Use Ctrl, Alt, Shift or Win together with a key.";
  if (accel === hotkey) return null;
  globalShortcut.unregister(hotkey);
  let ok = false;
  try {
    ok = globalShortcut.register(accel, showCapture);
  } catch {
    ok = false;
  }
  if (!ok) {
    globalShortcut.register(hotkey, showCapture);
    return `Could not register ${shownHotkey(accel)}. Another app may use it, or Windows does not allow it.`;
  }
  hotkey = accel;
  try {
    writeSettings({ hotkey });
  } catch (err) {
    return `The shortcut works, but it could not be saved: ${err?.message ?? err}`;
  }
  tray?.setContextMenu(trayMenu());
  return null;
}

ipcMain.handle("hotkey:get", () => hotkey);
ipcMain.handle("hotkey:set", (_e, accel) => changeHotkey(accel));

// Start the server in this process, then wait until it answers before loading pages.
async function startServer() {
  // Port 3001 is fixed. If something already answers there (e.g. `npm run dev`), starting would show
  // that server's data instead of ours.
  const busy = await fetch(SERVER + "/api/threads").then(() => true, () => false);
  if (busy) throw new Error("Port 3001 is already in use (another GigaNotes or the dev server). Close it and start again.");
  await import(pathToFileURL(path.join(appRoot, "dist-server", "server.mjs")).href);
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(SERVER + "/api/threads");
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("The GigaNotes server did not start on port 3001.");
}

ipcMain.on("capture:hide", () => captureWin?.hide());

app.on("before-quit", () => { quitting = true; });
// Keep running when all windows are hidden (tray + hotkey still work).
app.on("window-all-closed", () => {});

if (gotLock) app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox("GigaNotes", String(err?.message ?? err));
    app.quit();
    return;
  }
  createMain();
  createCapture();
  const saved = readSettings().hotkey;
  if (isValidHotkey(saved)) hotkey = saved;
  createTray();
  let ok = false;
  try {
    ok = globalShortcut.register(hotkey, showCapture);
  } catch {
    ok = false;
  }
  if (!ok) {
    dialog.showErrorBox("GigaNotes", `Could not register the ${shownHotkey(hotkey)} shortcut. Another app may use it. Pick another one in Settings.`);
  }
});

app.on("will-quit", () => globalShortcut.unregisterAll());
