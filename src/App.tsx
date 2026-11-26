import { useEffect, useState } from "react";
import { api, STATUSES, statusClass, type SearchHit, type Status, type Thread } from "./api";
import ThreadView from "./Thread";
import Capture from "./Capture";
import Settings from "./Settings";
import TrashView from "./Trash";

// Tiny hash router: "#/thread/12" opens a thread, "#/thread/12?m=34" also jumps to message 34,
// "#/trash" is Trash, "#/capture" is the quick-capture window, "#/settings" is settings, anything else is home.
type Route =
  | { view: "home" | "trash" | "capture" | "settings" }
  | { view: "thread"; id: number; mid: number | null };

const parseHash = (): Route => {
  const h = location.hash;
  if (h === "#/capture") return { view: "capture" };
  if (h === "#/settings") return { view: "settings" };
  if (h === "#/trash") return { view: "trash" };
  const m = h.match(/^#\/thread\/(\d+)(?:\?m=(\d+))?/);
  return m ? { view: "thread", id: Number(m[1]), mid: m[2] ? Number(m[2]) : null } : { view: "home" };
};

function ThreadCard({ t, onDeleted }: { t: Thread; onDeleted: () => void }) {
  // The card is a link, so the trash button must stop the click from opening the thread.
  const remove = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Move the thread "${t.title}" to Trash? You can restore it from Trash for 30 days.`)) return;
    try {
      await api.deleteThread(t.id);
      onDeleted();
    } catch (err) {
      alert(`Could not move the thread to Trash: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  };
  return (
    <a className="card" href={`#/thread/${t.id}`}>
      <button className="card-del" onClick={remove} title="Move to Trash" aria-label="Move thread to Trash">🗑</button>
      <h3 className="card-title">{t.title}</h3>
      <div className="cover">
        {t.coverUrl ? <img src={t.coverUrl} alt="" loading="lazy" /> : <div className="cover-ph">{t.title.slice(0, 1).toUpperCase()}</div>}
        <div className="cover-chips">
          <span className={statusClass(t.status)}>{t.status}</span>
          {t.tags.map((g) => <span key={g} className="chip">{g}</span>)}
        </div>
      </div>
      <div className="card-foot">💬 {t.messageCount}</div>
    </a>
  );
}

function NewThread({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [status, setStatus] = useState<Status>("Plan to play");
  const [cover, setCover] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setTitle(""); setTags(""); setStatus("Plan to play"); setCover(null); setOpen(false); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    let made: Thread;
    try {
      made = await api.create(title, status, tags.split(",").map((s) => s.trim()).filter(Boolean));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the thread");
      return;
    }
    // The thread exists now, so the form closes either way. A cover failure is shown on the home screen
    // and can be retried from the thread header (Cover button).
    setError(null);
    if (cover) {
      try {
        await api.setCover(made.id, cover);
      } catch (err) {
        setError(`Thread created, but the cover failed: ${err instanceof Error ? err.message : "unknown error"}. Set it from the thread's Cover button.`);
      }
    }
    reset();
    onCreated();
  };

  const errorLine = error && <p className="error">{error}</p>;
  if (!open) return <>{errorLine}<button className="btn primary" onClick={() => setOpen(true)}>+ New thread</button></>;
  return (
    <form className="new-thread" onSubmit={submit}>
      <input autoFocus placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input placeholder="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} />
      <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
        {STATUSES.map((s) => <option key={s}>{s}</option>)}
      </select>
      <label className="btn" title="Optional cover image">
        {cover ? `Cover: ${cover.name}` : "Cover image…"}
        <input type="file" accept="image/*" hidden onChange={(e) => setCover(e.target.files?.[0] ?? null)} />
      </label>
      <button className="btn primary" type="submit">Create</button>
      <button className="btn" type="button" onClick={reset}>Cancel</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Home() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [filter, setFilter] = useState<Status | "All">("All");
  const [tag, setTag] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  const load = () => api.list().then(setThreads);
  useEffect(() => { load(); }, []);

  // Message search: waits a moment after typing, and needs two characters.
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) { setHits([]); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      api.search(q).then((r) => live && setHits(r.messages)).catch(() => live && setHits([]));
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [q]);

  const lower = q.toLowerCase();
  const shown = threads.filter((t) =>
    (filter === "All" || t.status === filter) &&
    (!tag || t.tags.includes(tag)) &&
    (!lower || t.title.toLowerCase().includes(lower) || t.tags.some((g) => g.toLowerCase().includes(lower))),
  );
  const allTags = [...new Set(threads.flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b));

  // Most recently opened thread (null if nothing has been opened yet).
  const last = threads
    .filter((t) => t.lastOpenedAt != null)
    .reduce<Thread | null>((best, t) => (!best || t.lastOpenedAt! > best.lastOpenedAt! ? t : best), null);

  return (
    <div className="home">
      <header className="top">
        <h1>GigaNotes</h1>
        <div className="top-actions">
          {last && <a className="btn primary" href={`#/thread/${last.id}`} title={last.title}>Continue</a>}
          <NewThread onCreated={load} />
          <a className="btn" href="#/trash">Trash</a>
          <a className="btn" href="#/settings">Settings</a>
        </div>
      </header>
      <div className="toolbar">
        <input
          className="search"
          placeholder="Search threads, tags and messages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
          <option value="">All tags</option>
          {allTags.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
      <div className="filters">
        {(["All", ...STATUSES] as const).map((s) => (
          <button key={s} className={"pill" + (filter === s ? " active" : "")} onClick={() => setFilter(s)}>{s}</button>
        ))}
      </div>
      {hits.length > 0 && (
        <section className="hits">
          <h2 className="hits-head">Messages</h2>
          {hits.map((h) => (
            <a key={h.id} className="hit" href={`#/thread/${h.threadId}?m=${h.id}`}>
              <div className="hit-title">{h.threadTitle}</div>
              <div className="hit-snippet">{h.snippet}</div>
            </a>
          ))}
        </section>
      )}
      {threads.length === 0 ? (
        <p className="empty">No threads yet. Create one to get started.</p>
      ) : shown.length === 0 ? (
        <p className="empty">No threads match these filters.</p>
      ) : (
        <div className="grid">{shown.map((t) => <ThreadCard key={t.id} t={t} onDeleted={load} />)}</div>
      )}
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (route.view === "thread") {
    return <ThreadView key={route.id} id={route.id} focus={route.mid} onBack={() => { location.hash = ""; }} />;
  }
  if (route.view === "capture") return <Capture />;
  if (route.view === "settings") return <Settings />;
  if (route.view === "trash") return <TrashView />;
  return <Home />;
}
