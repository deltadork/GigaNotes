import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { api, pastedFiles, STATUSES, statusClass, type Attachment, type LinkPreview, type Message, type Thread } from "./api";

const AT_BOTTOM_PX = 48;
const NEAR_TOP_PX = 200;  // start loading older messages this close to the top

// Drafts are text only (files can't be stored in localStorage). One key per thread.
const draftKey = (threadId: number) => `giganotes-draft-${threadId}`;
const saveDraft = (threadId: number, value: string) => {
  if (value) localStorage.setItem(draftKey(threadId), value);
  else localStorage.removeItem(draftKey(threadId));
};

const PINS_OPEN_KEY = "giganotes-pins-open";
export const LAST_THREAD_KEY = "giganotes-last-thread";

const fmt = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const fmtSize = (n: number | null) =>
  n == null ? "" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

// Day dividers: a small sepia date where a new day starts.
const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const dayLabel = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// Up to two web links in a message body.
const linkUrls = (body: string): string[] => {
  const found = (body.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map((u) => u.replace(/[).,;:!?]+$/, ""));
  return [...new Set(found)].slice(0, 2);
};

// Previews are fetched once per URL and shared by every message that links to it.
const previewCache = new Map<string, Promise<LinkPreview>>();
const getPreview = (url: string) => {
  let p = previewCache.get(url);
  if (!p) {
    p = api.linkPreview(url);
    previewCache.set(url, p);
    p.catch(() => previewCache.delete(url)); // allow a retry later
  }
  return p;
};

// A link card with a fixed height, so it takes the same space while loading (no scroll jump).
function LinkCard({ url }: { url: string }) {
  const [data, setData] = useState<LinkPreview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    getPreview(url).then((p) => live && setData(p)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [url]);
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } })();
  return (
    <a className="link-card" href={url} target="_blank" rel="noreferrer">
      {data?.image && (
        <div className="link-thumb">
          <img
            src={data.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => { e.currentTarget.parentElement!.style.display = "none"; }}
          />
        </div>
      )}
      <div className="link-text">
        <div className="link-site">{data?.site ?? host}</div>
        <div className="link-title">{data?.title ?? (failed ? url : "Loading preview…")}</div>
        {data?.description && <div className="link-desc">{data.description}</div>}
      </div>
    </a>
  );
}

// Message text plus link cards for the links in it.
function MsgBody({ body }: { body: string }) {
  return (
    <>
      {body && <div className="msg-body">{body}</div>}
      {linkUrls(body).map((u) => <LinkCard key={u} url={u} />)}
    </>
  );
}

// A file waiting in the composer. `preview` is an object URL for images only.
type Pending = { id: number; file: File; preview: string | null };

// Clipboard needs PNG; other formats (webp thumbnails, jpg, gif first frame) are redrawn on a canvas.
const toPng = async (blob: Blob): Promise<Blob> => {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not convert image"))), "image/png"),
  );
};

// Plain-text files open in the reader panel instead of downloading.
const isText = (a: Attachment) => a.kind === "file" && (/\.txt$/i.test(a.name ?? "") || a.mime === "text/plain");

// Right-side reader for a text file. Fetched as text, shown in a readable font with wrapping.
function TextReader({ a, onClose }: { a: Attachment; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(a.url)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then((t) => live && setText(t))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [a.url]);
  return (
    <section className="reader">
      <div className="reader-head">
        <span className="reader-name" title={a.name ?? ""}>{a.name ?? "file"}</span>
        <a className="btn" href={a.url} download={a.name ?? undefined}>Save</a>
        <button className="btn" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <div className="reader-text">
        {failed ? <p className="error">Could not load this file.</p> : text === null ? <p className="muted">Loading…</p> : <pre>{text}</pre>}
      </div>
    </section>
  );
}

// Media box: width comes from CSS, height from the stored aspect ratio, so nothing shifts when it loads.
function Media({ a, onRead }: { a: Attachment; onRead: (a: Attachment) => void }) {
  const [note, setNote] = useState<string | null>(null);
  // Right-click on a picture copies the full-size original to the clipboard.
  const copyImage = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      const png = await toPng(await (await fetch(a.url)).blob());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setNote("Copied");
    } catch {
      setNote("Copy failed");
    }
    setTimeout(() => setNote(null), 1500);
  };
  if (a.kind === "file") {
    const label = <>📎 {a.name ?? "file"} {a.size != null && <span className="muted">({fmtSize(a.size)})</span>}</>;
    return isText(a) ? (
      <button type="button" className="file-chip" onClick={() => onRead(a)} title="Open to read">{label}</button>
    ) : (
      <a className="file-chip" href={a.url} download={a.name ?? undefined}>{label}</a>
    );
  }
  const box = { aspectRatio: `${a.width ?? 16} / ${a.height ?? 9}` };
  if (a.kind === "video") {
    // No autoplay; preload only metadata; poster = first frame thumbnail.
    return (
      <div className="media" style={box}>
        <video src={a.url} poster={a.thumbUrl ?? undefined} controls preload="metadata" playsInline />
      </div>
    );
  }
  // GIFs use the original so they keep animating; still images use the small thumbnail.
  const src = a.kind === "gif" ? a.url : a.thumbUrl ?? a.url;
  return (
    <a className="media" style={box} href={a.url} target="_blank" rel="noreferrer" onContextMenu={copyImage}>
      <img src={src} alt={a.name ?? ""} loading="lazy" decoding="async" />
      {note && <span className="media-note">{note}</span>}
    </a>
  );
}

export default function ThreadView({ id, focus, onBack }: { id: number; focus: number | null; onBack: () => void }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pins, setPins] = useState<Message[]>([]);
  const [pinsOpen, setPinsOpen] = useState(() => localStorage.getItem(PINS_OPEN_KEY) === "1");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [reading, setReading] = useState<Attachment | null>(null);

  const feed = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const atBottom = useRef(true);       // was the user at the bottom before the last update?
  const forceBottom = useRef(true);    // jump to bottom after next render (initial load / own send)
  const nextId = useRef(0);
  const pendingRef = useRef<Pending[]>([]);
  pendingRef.current = pending;
  const threadRef = useRef(id);        // which thread is open now (guards late responses)
  const loadingOlder = useRef(false);  // one older-page request at a time (also used by jump)
  const hasMoreRef = useRef(false);
  // Set when older messages are prepended: scrollHeight before the change, to keep the view still.
  const restoreFrom = useRef<number | null>(null);
  // Set when a jump loaded older pages: the message to scroll to after the next render.
  const jumpRef = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    threadRef.current = id;
    loadingOlder.current = false;
    restoreFrom.current = null;
    jumpRef.current = null;
    setText(localStorage.getItem(draftKey(id)) ?? "");
    setLoaded(false); setMessages([]); setHasMore(false); hasMoreRef.current = false;
    setPins([]);
    forceBottom.current = true;
    atBottom.current = true;
    api.thread(id).then((t) => live && setThread(t)).catch((e) => live && setError(`Cannot load thread: ${(e as Error).message}`));
    api.open(id).catch(() => {}); // remember for the Continue button; failure is harmless
    localStorage.setItem(LAST_THREAD_KEY, String(id)); // default thread for quick capture
    api.pins(id).then((p) => live && setPins(p)).catch(() => {});
    api.messages(id).then((p) => {
      if (!live) return;
      setMessages(p.messages); setLoaded(true);
      setHasMore(p.hasMore); hasMoreRef.current = p.hasMore;
    }).catch((e) => live && setError(`Cannot load messages: ${(e as Error).message}`));
    return () => { live = false; };
  }, [id]);

  const loadPins = () => {
    const tid = id;
    api.pins(tid).then((p) => { if (threadRef.current === tid) setPins(p); }).catch(() => {});
  };

  // Fetch the page before the oldest loaded message and prepend it.
  const loadOlder = async () => {
    if (loadingOlder.current || !hasMoreRef.current || !loaded) return;
    const oldest = messages[0];
    if (!oldest) return;
    const tid = id;
    loadingOlder.current = true;
    try {
      const p = await api.messages(tid, oldest.id);
      if (threadRef.current !== tid) return; // user switched threads meanwhile
      const el = feed.current;
      if (el) restoreFrom.current = el.scrollHeight;
      setMessages((prev) => [...p.messages, ...prev]);
      setHasMore(p.hasMore); hasMoreRef.current = p.hasMore;
    } catch (e) {
      setError(`Cannot load older messages: ${(e as Error).message}`);
    } finally {
      loadingOlder.current = false;
    }
  };

  // Free preview URLs when leaving the thread.
  useEffect(() => () => pendingRef.current.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), []);

  // Esc closes the text reader first, then the pinned panel (one listener, so one press closes one thing).
  useEffect(() => {
    if (!reading && !pinsOpen) return;
    const onKey = (e: { key: string }) => {
      if (e.key !== "Escape") return;
      if (reading) setReading(null);
      else setPinsPanel(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinsOpen, reading]);

  const setPinsPanel = (open: boolean) => {
    setPinsOpen(open);
    localStorage.setItem(PINS_OPEN_KEY, open ? "1" : "0");
  };

  // Scroll so a loaded message is centred and flash it. Returns false if it is not in the DOM.
  const scrollToMsg = (mid: number) => {
    const el = feed.current;
    if (!el) return false;
    const t = el.querySelector<HTMLElement>(`[data-mid="${mid}"]`);
    if (!t) return false;
    const fr = el.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    el.scrollTop += tr.top - fr.top - el.clientHeight / 2 + tr.height / 2;
    atBottom.current = false;
    t.classList.add("flash");
    window.setTimeout(() => t.classList.remove("flash"), 1600);
    return true;
  };

  // Jump to a message, loading older pages first if it is not loaded yet.
  const jump = async (mid: number) => {
    if (scrollToMsg(mid)) return;
    if (loadingOlder.current) return;
    const tid = id;
    loadingOlder.current = true;
    try {
      let list: Message[] = [];
      let cursor = messages[0]?.id;
      let more = hasMoreRef.current;
      let found = false;
      while (more && cursor !== undefined && !found) {
        const p = await api.messages(tid, cursor);
        if (threadRef.current !== tid) return;
        list = [...p.messages, ...list];
        found = p.messages.some((m) => m.id === mid);
        more = p.hasMore;
        cursor = p.messages[0]?.id;
      }
      if (!found) { setError("That message is no longer in this thread."); return; }
      const added = list;
      // Merge against the latest state (new messages may have been sent meanwhile).
      setMessages((prev) => [...added, ...prev]);
      setHasMore(more); hasMoreRef.current = more;
      jumpRef.current = mid;
    } catch (e) {
      setError(`Cannot jump: ${(e as Error).message}`);
    } finally {
      loadingOlder.current = false;
    }
  };

  // Opened from a search hit (#/thread/5?m=77): once the first page is in, jump to that message.
  useEffect(() => {
    if (focus !== null && loaded) void jump(focus);
  }, [focus, loaded]);

  // Runs before paint, so the feed never flashes at the top.
  useLayoutEffect(() => {
    const el = feed.current;
    if (!el || !loaded) return; // keep forceBottom until the first page is really rendered
    if (jumpRef.current !== null) {
      scrollToMsg(jumpRef.current);
      jumpRef.current = null;
      return;
    }
    if (restoreFrom.current !== null) {
      // Older messages were added above: move down by the height they added, so the view stays on the same message.
      el.scrollTop += el.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (forceBottom.current || atBottom.current) {
      // Stick to bottom only when the user was already there.
      el.scrollTop = el.scrollHeight;
      forceBottom.current = false;
    }
    // Still near the top (short thread or fast scroll)? Keep filling.
    if (el.scrollTop < NEAR_TOP_PX) void loadOlder();
  }, [messages, loaded]);

  // The feed shrinks when the composer grows (multi-line text, attachments) or the window/pins panel resizes.
  // If the user was at the bottom, keep them there.
  useEffect(() => {
    const el = feed.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = feed.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    if (el.scrollTop < NEAR_TOP_PX) void loadOlder();
  };

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setPending((prev) => [
      ...prev,
      ...files.map((file) => ({
        id: nextId.current++,
        file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      })),
    ]);
  };

  const removePending = (pid: number) => {
    setPending((prev) => {
      const gone = prev.find((p) => p.id === pid);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((p) => p.id !== pid);
    });
  };

  // Cover image for the thread card. Shown on the card once saved; errors go to the same line as other errors.
  const setCover = async (file: File) => {
    try {
      const saved = await api.setCover(id, file);
      if (threadRef.current === id) setThread(saved);
    } catch (e) {
      if (threadRef.current === id) setError(e instanceof Error ? e.message : "Could not set the cover");
    }
  };
  const clearCover = async () => {
    try {
      const saved = await api.clearCover(id);
      if (threadRef.current === id) setThread(saved);
    } catch (e) {
      if (threadRef.current === id) setError(e instanceof Error ? e.message : "Could not remove the cover");
    }
  };

  // One click moves to the next status. Shows the change at once, reverts if the save fails.
  const cycleStatus = async () => {
    if (!thread) return;
    const next = STATUSES[(STATUSES.indexOf(thread.status) + 1) % STATUSES.length];
    const before = thread;
    setThread({ ...thread, status: next });
    try {
      const saved = await api.setStatus(id, next);
      if (threadRef.current === id) setThread(saved);
    } catch (e) {
      if (threadRef.current === id) {
        setThread(before);
        setError(`Status not saved: ${(e as Error).message}`);
      }
    }
  };

  // Move one message to Trash after confirmation. Removes it from the feed and the pins panel.
  const removeMessage = async (mid: number) => {
    if (!window.confirm("Move this message to Trash? You can restore it from Trash for 30 days.")) return;
    const tid = id;
    try {
      await api.deleteMessage(mid);
      if (threadRef.current !== tid) return;
      setMessages((prev) => prev.filter((x) => x.id !== mid));
      loadPins();
    } catch (e) {
      setError(`Could not delete the message: ${(e as Error).message}`);
    }
  };

  // Move the whole thread to Trash after confirmation, then go back to the home screen.
  const removeThread = async () => {
    if (!window.confirm(`Move the thread "${thread?.title ?? ""}" to Trash? You can restore it from Trash for 30 days.`)) return;
    try {
      await api.deleteThread(id);
      location.hash = "";
    } catch (e) {
      setError(`Could not move the thread to Trash: ${(e as Error).message}`);
    }
  };

  // Save an edited message. Empty text is refused (use Trash to remove a message).
  const saveEdit = async () => {
    if (!editing) return;
    const body = editing.text.trim();
    if (!body) { setError("A message cannot be empty. Move it to Trash to remove it."); return; }
    const tid = id;
    try {
      const u = await api.editMessage(editing.id, body);
      if (threadRef.current !== tid) return;
      setMessages((prev) => prev.map((x) => (x.id === u.id ? u : x)));
      setEditing(null);
      loadPins();
    } catch (e) {
      setError(`Edit not saved: ${(e as Error).message}`);
    }
  };

  // Enter saves, Shift+Enter is a newline, Esc cancels (and does not close the pins panel).
  const onEditKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(null);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void saveEdit();
    }
  };

  // Pin or unpin a message, in the feed and in the panel.
  const togglePin = async (mid: number, pinned: boolean) => {
    const tid = id;
    try {
      const u = await api.setPinned(mid, !pinned);
      if (threadRef.current !== tid) return;
      setMessages((prev) => prev.map((x) => (x.id === u.id ? u : x)));
      loadPins();
    } catch (e) {
      setError(`Pin not saved: ${(e as Error).message}`);
    }
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && pending.length === 0) || sending) return;
    const tid = id;
    const sentText = text;
    const sentFiles = pending;
    setText(""); saveDraft(id, ""); setPending([]); setError(null); setSending(true);
    try {
      const m = await api.send(tid, body, sentFiles.map((p) => p.file));
      sentFiles.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      if (threadRef.current !== tid) return; // left the thread while sending; the message is saved on the server
      forceBottom.current = true; // own message: always show it
      setMessages((prev) => [...prev, m]);
    } catch (e) {
      if (threadRef.current !== tid) {
        // Left the thread mid-send: keep the text as that thread's draft, drop the files.
        sentFiles.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
        if (!localStorage.getItem(draftKey(tid))) saveDraft(tid, sentText);
        return;
      }
      // Put everything back so nothing is lost (text typed meanwhile stays after the old text).
      setText((cur) => { const v = cur ? `${sentText}\n${cur}` : sentText; saveDraft(tid, v); return v; });
      setPending((cur) => [...sentFiles, ...cur]);
      setError(`Not sent: ${(e as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  // Enter sends, Shift+Enter inserts a newline.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // Ctrl+V: screenshots and copied files arrive as clipboard items. Plain text falls through to the textarea.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div
      className={dragging ? "thread drop-active" : "thread"}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="thread-head">
        <button className="btn" onClick={onBack}>← Back</button>
        <h2>{thread?.title ?? ""}</h2>
        {thread && (
          <button className={statusClass(thread.status) + " chip-btn"} onClick={cycleStatus} title="Click to change status">
            {thread.status}
          </button>
        )}
        <button className={"btn" + (pinsOpen ? " active-btn" : "")} onClick={() => setPinsPanel(!pinsOpen)}>
          Pinned{pins.length ? ` (${pins.length})` : ""}
        </button>
        {thread && (
          <>
            <button className="btn" onClick={() => coverInput.current?.click()} title="Set the thread cover image">Cover</button>
            {thread.coverUrl && (
              <button className="btn" onClick={() => clearCover()} title="Remove the cover image">✕ Cover</button>
            )}
            <button className="btn danger" onClick={removeThread} title="Move this thread to Trash (restorable for 30 days)">Move to Trash</button>
            <input
              ref={coverInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setCover(f); }}
            />
          </>
        )}
      </header>

      <div className="thread-body">
        <div className="main">
          <div className="feed" ref={feed} onScroll={onScroll}>
            {!loaded && error && <p className="error">{error}</p>}
            {loaded && messages.length === 0 && <p className="empty">No messages yet. Write the first one below.</p>}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const newDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
              const cur = editing && editing.id === m.id ? editing : null;
              return (
                <Fragment key={m.id}>
                  {newDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
                  <div className="msg" data-mid={m.id}>
                    <div className="msg-head">
                      <div className="msg-time">
                        {fmt(m.createdAt)}
                        {m.editedAt && <span className="edited"> (edited)</span>}
                      </div>
                      <button
                        className={"pin-btn" + (m.pinned ? " on" : "")}
                        onClick={() => togglePin(m.id, m.pinned)}
                        title={m.pinned ? "Unpin" : "Pin"}
                        aria-label={m.pinned ? "Unpin message" : "Pin message"}
                      >📌</button>
                      <button className="edit-btn" onClick={() => setEditing({ id: m.id, text: m.body })} title="Edit message" aria-label="Edit message">✎</button>
                      <button className="del-btn" onClick={() => removeMessage(m.id)} title="Move to Trash" aria-label="Move message to Trash">🗑</button>
                    </div>
                    {cur ? (
                      <div className="edit-wrap">
                        <textarea
                          className="edit-box"
                          autoFocus
                          value={cur.text}
                          onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                          onKeyDown={onEditKey}
                        />
                        <div className="edit-actions">
                          <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                          <button className="btn primary" onClick={() => void saveEdit()}>Save</button>
                        </div>
                      </div>
                    ) : (
                      <MsgBody body={m.body} />
                    )}
                    {m.attachments.map((a) => <Media key={a.id} a={a} onRead={setReading} />)}
                  </div>
                </Fragment>
              );
            })}
          </div>

          <div className="composer">
            {pending.length > 0 && (
              <div className="pending">
                {pending.map((p) => (
                  <div key={p.id} className="pending-item">
                    {p.preview ? <img src={p.preview} alt="" /> : <span className="pending-icon">📎</span>}
                    <span className="pending-name">{p.file.name} <span className="muted">({fmtSize(p.file.size)})</span></span>
                    <button className="pending-remove" onClick={() => removePending(p.id)} aria-label="Remove">×</button>
                  </div>
                ))}
              </div>
            )}
            {error && <p className="error">{error}</p>}
            <div className="composer-row">
              <button className="btn" onClick={() => fileInput.current?.click()} title="Attach files">+</button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <textarea
                rows={1}
                placeholder={`Message ${thread?.title ?? ""}`}
                value={text}
                onChange={(e) => { setText(e.target.value); saveDraft(id, e.target.value); }}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
              />
            </div>
          </div>
        </div>

        {(reading || pinsOpen) && (
          // Right side: the text reader takes the top half, the pinned panel (if open) the rest.
          <div className="side">
            {reading && <TextReader key={reading.url} a={reading} onClose={() => setReading(null)} />}
            {pinsOpen && (
              <aside className="pins-panel">
                <div className="pins-head">
                  <h3>Pinned</h3>
                  <button className="btn" onClick={() => setPinsPanel(false)} title="Close (Esc)">✕</button>
                </div>
                {pins.length === 0 && <p className="empty">No pinned messages. Use 📌 on a message to pin it.</p>}
                {pins.map((m) => (
                  <div
                    key={m.id}
                    className="pin-item"
                    onClick={(e) => {
                      // Clicks on links, buttons or video controls should not jump.
                      if ((e.target as HTMLElement).closest("a, button, video")) return;
                      jump(m.id);
                    }}
                  >
                    <div className="msg-time">{fmt(m.createdAt)}</div>
                    <MsgBody body={m.body} />
                    {m.attachments.map((a) => <Media key={a.id} a={a} onRead={setReading} />)}
                    <div className="pin-actions">
                      <button className="btn" onClick={(e) => { e.stopPropagation(); togglePin(m.id, true); }}>Unpin</button>
                    </div>
                  </div>
                ))}
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
