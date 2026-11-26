import { useEffect, useState } from "react";
import { api, type ImportStatus, type ScanItem, type Thread } from "./api";

// Only present inside the desktop app (see electron/preload.cjs).
type GG = { getHotkey: () => Promise<string>; setHotkey: (accel: string) => Promise<string | null> };
const gg = (window as unknown as { gg?: GG }).gg;

const DEFAULT_HOTKEY = "Control+Shift+N";

const LETTER_OR_DIGIT = /^(Key([A-Z])|Digit(\d))$/;
const NAMED_KEYS: Record<string, string> = {
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};

// Turns a key press into an accelerator like "Control+Alt+K". Null when it is not a usable key yet
// (only a modifier, or a key that cannot be a hotkey).
function accelFromEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const mods = [
    e.ctrlKey && "Control",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    e.metaKey && "Super",
  ].filter(Boolean) as string[];
  let key: string | null = null;
  const letterOrDigit = e.code.match(LETTER_OR_DIGIT);
  if (letterOrDigit) key = letterOrDigit[2] ?? letterOrDigit[3];
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else key = NAMED_KEYS[e.code] ?? null;
  if (!key || mods.length === 0) return null;
  return [...mods, key].join("+");
}

// Shows "Ctrl+Shift+N" for "Control+Shift+N".
const label = (accel: string) => accel.replace("Control", "Ctrl").replace("Super", "Win");

// Lets the user record a new quick-capture hotkey by pressing it.
function QuickCaptureHotkey() {
  const [current, setCurrent] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    gg?.getHotkey().then(setCurrent);
  }, []);

  const save = async (accel: string) => {
    if (!gg) return;
    setError(null);
    setSaved(false);
    const err = await gg.setHotkey(accel);
    if (err) setError(err);
    else {
      setCurrent(accel);
      setSaved(true);
    }
  };

  // While recording, the next key press (with a modifier) becomes the hotkey. Esc cancels.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRecording(false);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) return;
      setRecording(false);
      save(accel);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  if (!gg) {
    return (
      <section className="settings-section">
        <h2>Quick capture hotkey</h2>
        <p className="muted">The global hotkey can be changed in the desktop app.</p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h2>Quick capture hotkey</h2>
      <p className="muted">
        Opens the small quick-capture window from anywhere, even when GigaNotes is hidden. Pick a combination with
        Ctrl, Alt, Shift or Win plus a key. Press Esc while recording to cancel.
      </p>
      <div className="row">
        <span className="chip">{current ? label(current) : "…"}</span>
        <button className="btn" onClick={() => { setError(null); setSaved(false); setRecording(true); }} disabled={recording}>
          {recording ? "Press the new hotkey…" : "Change"}
        </button>
        <button className="btn" onClick={() => save(DEFAULT_HOTKEY)} disabled={recording || current === DEFAULT_HOTKEY}>
          Reset to Ctrl+Shift+N
        </button>
        {saved && <span className="muted">Saved.</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

// Imports a folder: each Discord export (.html) and each exported thread (folder with thread.json) becomes a thread.
function ImportFolder() {
  const [folder, setFolder] = useState("C:\\playthroughs\\discord archive");
  const [items, setItems] = useState<ScanItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Polls until the server reports the job finished. Also runs on mount, in case an import is still going.
  const watch = async () => {
    const s = await api.importStatus();
    setStatus(s);
    if (s.running) setTimeout(watch, 2000);
  };
  useEffect(() => { watch(); }, []);

  const scan = async () => {
    setError(null);
    setStatus(null);
    try {
      const r = await api.importScan(folder);
      setItems(r.exports);
      setPicked(new Set()); // nothing pre-selected, so a test batch is easy to pick
    } catch (err) {
      setItems(null);
      setError(err instanceof Error ? err.message : "Could not read the folder");
    }
  };

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const start = async () => {
    setError(null);
    try {
      await api.importRun(folder, [...picked]);
      setStatus(await api.importStatus());
      watch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the import");
    }
  };

  const running = status?.running ?? false;
  return (
    <section className="settings-section">
      <h2>Import</h2>
      <p className="muted">
        Pick a folder. Each Discord export (.html) and each thread exported from GigaNotes becomes its own thread,
        with its media. Threads already in the app are unchecked. Large folders take a long time.
      </p>
      <div className="import-form">
        <label>
          Folder path
          <div className="row">
            <input value={folder} onChange={(e) => setFolder(e.target.value)} />
            <button className="btn" onClick={scan} disabled={running || !folder.trim()}>Scan folder</button>
          </div>
        </label>
        {error && <p className="error">{error}</p>}
        {items && (
          <>
            <div className="row">
              <button className="btn" disabled={running} onClick={() => setPicked(new Set(items.filter((e) => !e.alreadyInApp).map((e) => e.name)))}>
                Select all not in app
              </button>
              <button className="btn" disabled={running} onClick={() => setPicked(new Set())}>Clear</button>
              <span className="muted">{items.length} found</span>
            </div>
            <div className="export-list">
              {items.map((e) => (
                <label key={e.name} className="export-item">
                  <input type="checkbox" checked={picked.has(e.name)} onChange={() => toggle(e.name)} disabled={running} />
                  <span>{e.title}</span>
                  <span className="muted">{e.kind === "giga" ? "GigaNotes" : "Discord"} · {e.messages} messages · {e.media} media</span>
                  {e.alreadyInApp && <span className="chip">already in app</span>}
                </label>
              ))}
            </div>
            <div className="row">
              <button className="btn primary" onClick={start} disabled={running || picked.size === 0}>
                {running ? "Importing…" : `Import ${picked.size} selected`}
              </button>
            </div>
          </>
        )}
        {status && (status.running || status.total > 0) && (
          <div className="import-status">
            <p>
              {status.running ? "Importing" : "Finished"}: {status.done} of {status.total}
              {status.running && status.current ? ` (now: ${status.current})` : ""}
            </p>
            <p className="muted">
              Imported {status.imported.length} · skipped {status.skipped.length}
              {status.missingFiles > 0 && ` · missing media files: ${status.missingFiles}`}
            </p>
            {status.imported.length > 0 && <p className="muted">New threads: {status.imported.join(", ")}</p>}
            {status.errors.map((msg) => <p key={msg} className="error">{msg}</p>)}
          </div>
        )}
      </div>
    </section>
  );
}

// Writes one thread to a folder: <folder>/<title>/thread.json plus a media/ folder with the original files.
function ExportThread() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [id, setId] = useState<number | null>(null);
  const [folder, setFolder] = useState("C:\\playthroughs\\exports");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.list().then((list) => {
      setThreads(list);
      if (list.length) setId(list[0].id);
    });
  }, []);

  const run = async () => {
    if (id == null || !folder.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.exportThread(id, folder.trim());
      setResult(`Exported ${r.messages} messages and ${r.media} media files to ${r.folder}${r.missing ? ` (${r.missing} media files were missing and skipped)` : ""}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>Export</h2>
      <p className="muted">Saves a thread's messages (text, pins, dates) and its original media into a folder, so it can be imported again.</p>
      <div className="import-form">
        <label>
          Thread
          <select value={id ?? ""} onChange={(e) => setId(Number(e.target.value))}>
            {threads.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </label>
        <label>
          Export into folder
          <input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>
        <div className="row">
          <button className="btn primary" disabled={busy || id == null || !folder.trim()} onClick={run}>
            {busy ? "Exporting…" : "Export thread"}
          </button>
        </div>
        {result && <p className="muted">{result}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}

export default function Settings() {
  return (
    <div className="home">
      <header className="top">
        <a className="btn" href="#">← Back</a>
        <h1>Settings</h1>
      </header>
      <QuickCaptureHotkey />
      <ImportFolder />
      <ExportThread />
    </div>
  );
}
