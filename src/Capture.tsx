import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { api, pastedFiles, type Thread } from "./api";
import { LAST_THREAD_KEY } from "./Thread";

// Only present inside the desktop app (see electron/preload.cjs).
type GG = { hideCapture: () => void; onCaptureShow: (cb: () => void) => void };
const gg = (window as unknown as { gg?: GG }).gg;

type Pending = { id: number; file: File; preview: string | null };

// Default: the thread opened last, else the first one (the list is sorted by activity).
const pickDefault = (list: Thread[]) => {
  const last = Number(localStorage.getItem(LAST_THREAD_KEY));
  return list.find((t) => t.id === last)?.id ?? list[0]?.id ?? null;
};

export default function Capture() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(0);

  const revokeAll = (list: Pending[]) => list.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));

  // Fresh state each time the window is shown.
  const reset = () => {
    setFiles((prev) => { revokeAll(prev); return []; });
    setText(""); setError(null); setDone(null);
    area.current?.focus();
  };

  const loadThreads = () =>
    api.list().then((list) => {
      setThreads(list);
      setThreadId(pickDefault(list));
    }).catch((e) => setError(`Cannot reach GigaNotes: ${(e as Error).message}`));

  useEffect(() => {
    loadThreads();
    area.current?.focus();
    gg?.onCaptureShow(() => { reset(); loadThreads(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = (list: File[]) => {
    if (list.length === 0) return;
    setFiles((prev) => [
      ...prev,
      ...list.map((file) => ({
        id: nextId.current++,
        file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      })),
    ]);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = pastedFiles(e.clipboardData);
    if (pasted.length > 0) {
      e.preventDefault();
      addFiles(pasted);
    }
  };

  // Dropping files anywhere in the window attaches them (otherwise the window would navigate to the file).
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  };

  // Hides the capture window. In a browser tab there is no window to hide, so nothing happens.
  const close = () => gg?.hideCapture();

  const save = async () => {
    const body = text.trim();
    if (busy || (!body && files.length === 0)) return;
    if (threadId === null) { setError("Create a thread in GigaNotes first."); return; }
    setBusy(true); setError(null);
    try {
      await api.send(threadId, body, files.map((f) => f.file));
      localStorage.setItem(LAST_THREAD_KEY, String(threadId));
      const title = threads.find((t) => t.id === threadId)?.title ?? "thread";
      setFiles((prev) => { revokeAll(prev); return []; });
      setText("");
      setDone(`Saved to ${title}`);
      close();
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Enter saves, Shift+Enter newline, Esc closes.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="capture" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <select value={threadId ?? ""} onChange={(e) => setThreadId(Number(e.target.value))} aria-label="Thread">
        {threads.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
      </select>

      {files.length > 0 && (
        <div className="pending">
          {files.map((p) => (
            <div key={p.id} className="pending-item">
              {p.preview ? <img src={p.preview} alt="" /> : <span className="pending-icon">📎</span>}
              <span className="pending-name">{p.file.name}</span>
              <button className="pending-remove" aria-label="Remove" onClick={() => setFiles((prev) => {
                const gone = prev.find((x) => x.id === p.id);
                if (gone?.preview) URL.revokeObjectURL(gone.preview);
                return prev.filter((x) => x.id !== p.id);
              })}>×</button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder="Type or paste text, images or files. Enter saves, Esc closes."
      />

      <div className="capture-foot">
        {error && <span className="error">{error}</span>}
        {!error && done && <span className="muted">{done}</span>}
        {busy && <span className="muted">Saving…</span>}
      </div>
    </div>
  );
}
