import { useEffect, useState } from "react";
import { api, type Trash } from "./api";

const fmt = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// Trash: deleted threads and messages. Restore them, delete for good, or empty the whole Trash.
// Anything in Trash for more than 30 days is removed automatically by the server.
export default function TrashView() {
  const [data, setData] = useState<Trash | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.trash().then(setData).catch((e) => setError(`Cannot load Trash: ${(e as Error).message}`));
  useEffect(() => { void load(); }, []);

  // Runs one change, then reloads the list. Shows the error line if it fails.
  const act = async (run: () => Promise<unknown>) => {
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(`Could not complete that: ${(e as Error).message}`);
    }
  };

  const purgeThread = (id: number, title: string) => {
    if (!window.confirm(`Delete "${title}" and everything in it for good? This cannot be undone.`)) return;
    void act(() => api.purgeThread(id));
  };
  const purgeMessage = (id: number) => {
    if (!window.confirm("Delete this message and its files for good? This cannot be undone.")) return;
    void act(() => api.purgeMessage(id));
  };
  const emptyTrash = () => {
    if (!window.confirm("Delete everything in Trash for good? This cannot be undone.")) return;
    void act(() => api.emptyTrash());
  };

  const empty = data !== null && data.threads.length === 0 && data.messages.length === 0;

  return (
    <div className="trash">
      <header className="top">
        <a className="btn" href="#/">← Home</a>
        <h1>Trash</h1>
        {!empty && data && <button className="btn danger" onClick={emptyTrash}>Empty Trash</button>}
      </header>
      <p className="muted">Items stay here for 30 days, then they are deleted for good.</p>
      {error && <p className="error">{error}</p>}
      {data === null && !error && <p className="empty">Loading…</p>}
      {empty && <p className="empty">Trash is empty.</p>}

      {data && data.threads.length > 0 && (
        <section className="trash-section">
          <h2>Threads</h2>
          {data.threads.map((t) => (
            <div key={t.id} className="trash-row">
              <div className="grow">
                <div><strong>{t.title}</strong></div>
                <div className="muted">{t.messageCount} messages · moved {fmt(t.deletedAt)}</div>
              </div>
              <button className="btn" onClick={() => void act(() => api.restoreThread(t.id))}>Restore</button>
              <button className="btn danger" onClick={() => purgeThread(t.id, t.title)}>Delete for good</button>
            </div>
          ))}
        </section>
      )}

      {data && data.messages.length > 0 && (
        <section className="trash-section">
          <h2>Messages</h2>
          {data.messages.map((m) => (
            <div key={m.id} className="trash-row">
              <div className="grow">
                <div className="muted">{m.threadTitle} · written {fmt(m.createdAt)} · moved {fmt(m.deletedAt)}</div>
                <div className="snippet">
                  {m.body || (m.attachmentCount > 0 ? `${m.attachmentCount} attachment(s)` : "(empty)")}
                </div>
              </div>
              <button className="btn" onClick={() => void act(() => api.restoreMessage(m.id))}>Restore</button>
              <button className="btn danger" onClick={() => purgeMessage(m.id)}>Delete for good</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
