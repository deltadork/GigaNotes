import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { processUpload, MIME_BY_EXT, type Processed } from "./media";
import { fetchPreview } from "./links";

// Small wrapper over the built-in node:sqlite, so the server runs unchanged inside Electron
// (no native module to rebuild). Keeps the prepare/run/get/all/transaction calls used below.
class Database {
  private d: DatabaseSync;
  constructor(file: string) { this.d = new DatabaseSync(file); }
  exec(sql: string) { this.d.exec(sql); }
  pragma(stmt: string): unknown[] { return this.d.prepare(`PRAGMA ${stmt}`).all(); }
  prepare<P extends SQLInputValue[] = SQLInputValue[], R = Record<string, unknown>>(sql: string) {
    const st = this.d.prepare(sql);
    return {
      run: (...a: P) => st.run(...a),
      get: (...a: P) => st.get(...a) as R | undefined,
      all: (...a: P) => st.all(...a) as R[],
    };
  }
  transaction<F extends (...a: any[]) => any>(fn: F): F {
    return ((...args: Parameters<F>) => {
      this.d.exec("BEGIN");
      try {
        const r = fn(...args);
        this.d.exec("COMMIT");
        return r;
      } catch (e) {
        this.d.exec("ROLLBACK");
        throw e;
      }
    }) as F;
  }
}

// Everything lives in ./data (db + media) so it can be backed up as one folder.
const DATA_DIR = path.resolve(process.env.GIGA_DATA ?? "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
await fs.mkdir(MEDIA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "giganotes.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS threads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'Plan to play'
                 CHECK (status IN ('Playing','Finished','Dropped','Plan to play')),
  cover_path     TEXT,                      -- file in data/media; NULL = placeholder
  created_at     INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  last_opened_at INTEGER                    -- for the Continue button
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  body       TEXT NOT NULL DEFAULT '',
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('image','gif','video','file')),
  file_path  TEXT NOT NULL,                 -- relative to data/media
  thumb_path TEXT,
  mime       TEXT,
  size       INTEGER,
  width      INTEGER,
  height     INTEGER,
  duration   REAL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS thread_tags (
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, tag_id)
);
`);

// Migration: original file name, so non-media attachments can show it.
if (!(db.pragma("table_info(attachments)") as { name: string }[]).some((c) => c.name === "name")) {
  db.exec("ALTER TABLE attachments ADD COLUMN name TEXT");
}

// Migrations: edit time, soft delete (Trash), link preview cache.
const hasColumn = (table: string, col: string) =>
  (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === col);
if (!hasColumn("messages", "edited_at")) db.exec("ALTER TABLE messages ADD COLUMN edited_at INTEGER");
if (!hasColumn("messages", "deleted_at")) db.exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
if (!hasColumn("threads", "deleted_at")) db.exec("ALTER TABLE threads ADD COLUMN deleted_at INTEGER");
db.exec(`
CREATE TABLE IF NOT EXISTS link_previews (
  url         TEXT PRIMARY KEY,
  title       TEXT,
  description TEXT,
  site        TEXT,
  image_url   TEXT,
  fetched_at  INTEGER NOT NULL
);`);

const STATUSES = ["Playing", "Finished", "Dropped", "Plan to play"];

type ThreadRow = {
  id: number; title: string; status: string; cover_path: string | null;
  created_at: number; last_opened_at: number | null; message_count: number; tags: string | null;
};

// Cover: explicit cover_path, else the thumbnail of the thread's first image.
// Messages in Trash never count, show as a cover, or appear in lists.
const COVER = `COALESCE(t.cover_path, (SELECT a.thumb_path FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.thread_id = t.id AND m.deleted_at IS NULL AND a.kind IN ('image','gif') AND a.thumb_path IS NOT NULL ORDER BY a.id LIMIT 1))`;

const listThreads = db.prepare<[], ThreadRow>(`
  SELECT t.id, t.title, t.status, ${COVER} AS cover_path, t.created_at, t.last_opened_at,
    (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.deleted_at IS NULL) AS message_count,
    (SELECT group_concat(g.name, char(31)) FROM thread_tags tt JOIN tags g ON g.id = tt.tag_id
       WHERE tt.thread_id = t.id) AS tags
  FROM threads t
  WHERE t.deleted_at IS NULL
  ORDER BY COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.thread_id = t.id AND m.deleted_at IS NULL), t.created_at) DESC
`);

const getThread = db.prepare<[number], ThreadRow>(`
  SELECT t.id, t.title, t.status, ${COVER} AS cover_path, t.created_at, t.last_opened_at,
    (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.deleted_at IS NULL) AS message_count,
    (SELECT group_concat(g.name, char(31)) FROM thread_tags tt JOIN tags g ON g.id = tt.tag_id
       WHERE tt.thread_id = t.id) AS tags
  FROM threads t WHERE t.id = ? AND t.deleted_at IS NULL
`);

const toThread = (r: ThreadRow) => ({
  id: r.id,
  title: r.title,
  status: r.status,
  coverUrl: r.cover_path ? `/media/${r.cover_path}` : null,
  createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at,
  messageCount: r.message_count,
  tags: r.tags ? r.tags.split("\x1f") : [],
});

const createThread = db.transaction((title: string, status: string, tags: string[]) => {
  const id = Number(db.prepare("INSERT INTO threads (title, status) VALUES (?, ?)").run(title, status).lastInsertRowid);
  for (const name of tags) {
    db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(name);
    const tag = db.prepare<[string], { id: number }>("SELECT id FROM tags WHERE name = ?").get(name)!;
    db.prepare("INSERT OR IGNORE INTO thread_tags (thread_id, tag_id) VALUES (?, ?)").run(id, tag.id);
  }
  return id;
});

type MessageRow = {
  id: number; thread_id: number; body: string; pinned: number; created_at: number;
  edited_at: number | null; deleted_at: number | null;
};
type AttachmentRow = {
  id: number; message_id: number; kind: string; file_path: string; thumb_path: string | null;
  mime: string | null; size: number | null; width: number | null; height: number | null;
  duration: number | null; name: string | null;
};

const toAttachment = (a: AttachmentRow) => ({
  id: a.id,
  kind: a.kind,
  url: `/media/${a.file_path}`,
  thumbUrl: a.thumb_path ? `/media/${a.thumb_path}` : null,
  mime: a.mime,
  size: a.size,
  width: a.width,
  height: a.height,
  duration: a.duration,
  name: a.name,
});

// Attachments for a set of messages, keyed by message id.
const attachmentsFor = (messageIds: number[]) => {
  const byMsg = new Map<number, ReturnType<typeof toAttachment>[]>();
  if (messageIds.length === 0) return byMsg;
  const rows = db
    .prepare<number[], AttachmentRow>(
      `SELECT * FROM attachments WHERE message_id IN (${messageIds.map(() => "?").join(",")}) ORDER BY id`,
    )
    .all(...messageIds);
  for (const r of rows) {
    const list = byMsg.get(r.message_id) ?? [];
    list.push(toAttachment(r));
    byMsg.set(r.message_id, list);
  }
  return byMsg;
};

const toMessages = (rows: MessageRow[]) => {
  const atts = attachmentsFor(rows.map((r) => r.id));
  return rows.map((m) => ({
    id: m.id,
    threadId: m.thread_id,
    body: m.body,
    pinned: !!m.pinned,
    createdAt: m.created_at,
    editedAt: m.edited_at ?? null,
    attachments: atts.get(m.id) ?? [],
  }));
};

const insertMessage = db.transaction((threadId: number, body: string, files: Processed[], names: string[]) => {
  const msgId = Number(
    db.prepare("INSERT INTO messages (thread_id, body) VALUES (?, ?)").run(threadId, body).lastInsertRowid,
  );
  const ins = db.prepare(`
    INSERT INTO attachments (message_id, kind, file_path, thumb_path, mime, size, width, height, duration, name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  files.forEach((f, i) =>
    ins.run(msgId, f.kind, f.filePath, f.thumbPath, f.mime, f.size, f.width, f.height, f.duration, names[i] ?? null),
  );
  return msgId;
});

const app = new Hono();

// Only this machine's own pages may talk to the API. Blocks other websites from posting to
// localhost (simple cross-site POSTs need no preflight) and DNS-rebinding hosts.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
app.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  const origin = c.req.header("origin");
  let originOk = true;
  if (origin) { try { originOk = LOCAL_HOST.test(new URL(origin).host); } catch { originOk = false; } }
  if (!LOCAL_HOST.test(host) || !originOk) return c.text("forbidden", 403);
  await next();
});

// Body as a plain object, whatever was sent (null, array, bad JSON).
const readJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

app.get("/api/threads", (c) => c.json(listThreads.all().map(toThread)));

app.post("/api/threads", async (c) => {
  const body = await readJson(c);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return c.json({ error: "title required" }, 400);
  const status = STATUSES.includes(body.status as string) ? (body.status as string) : "Plan to play";
  const tags: string[] = Array.isArray(body.tags)
    ? [...new Set<string>((body.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean))]
    : [];
  const id = createThread(title, status, tags);
  return c.json(toThread(getThread.get(id)!), 201);
});

// Set the thread's cover image (multipart field "file", image or GIF only).
app.put("/api/threads/:id/cover", async (c) => {
  const id = Number(c.req.param("id"));
  if (!getThread.get(id)) return c.json({ error: "not found" }, 404);
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "file required" }, 400);

  let p: Processed;
  try {
    p = await processUpload(file, MEDIA_DIR);
  } catch (e) {
    console.error("cover upload failed:", e);
    return c.json({ error: "Could not store the image" }, 500);
  }
  if (p.kind !== "image" && p.kind !== "gif") {
    for (const rel of [p.filePath, p.thumbPath]) if (rel) await fs.rm(path.join(MEDIA_DIR, rel), { force: true });
    return c.json({ error: "cover must be an image or GIF" }, 400);
  }
  db.prepare("UPDATE threads SET cover_path = ? WHERE id = ?").run(p.thumbPath ?? p.filePath, id);
  return c.json(toThread(getThread.get(id)!));
});

// Remove the explicit cover; the card goes back to the first image of the thread (or the placeholder).
app.delete("/api/threads/:id/cover", (c) => {
  const id = Number(c.req.param("id"));
  const res = db.prepare("UPDATE threads SET cover_path = NULL WHERE id = ?").run(id);
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json(toThread(getThread.get(id)!));
});

// ---- Delete: soft delete into Trash, permanent removal from Trash (or after TRASH_DAYS) ----
const TRASH_DAYS = 30;

// Remove media files from disk (the DB rows go via ON DELETE CASCADE).
const removeMediaFiles = async (rels: (string | null | undefined)[]) => {
  for (const rel of rels) if (rel) await fs.rm(path.join(MEDIA_DIR, rel), { force: true });
};

// Permanently delete a thread: its messages, attachments, tags and every media file it owns.
async function purgeThread(id: number): Promise<boolean> {
  const thread = db.prepare<[number], { cover_path: string | null }>("SELECT cover_path FROM threads WHERE id = ?").get(id);
  if (!thread) return false;
  const files = db
    .prepare<[number], { file_path: string; thumb_path: string | null }>(
      "SELECT a.file_path, a.thumb_path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?")
    .all(id);
  db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  await removeMediaFiles([...files.flatMap((f) => [f.file_path, f.thumb_path]), thread.cover_path]);
  return true;
}

// Permanently delete one message and its attachments. If it held the thread's cover, the cover falls back to the default.
async function purgeMessage(id: number): Promise<boolean> {
  const msg = db.prepare<[number], { thread_id: number }>("SELECT thread_id FROM messages WHERE id = ?").get(id);
  if (!msg) return false;
  const files = db
    .prepare<[number], { file_path: string; thumb_path: string | null }>("SELECT file_path, thumb_path FROM attachments WHERE message_id = ?")
    .all(id);
  const cover = db.prepare<[number], { cover_path: string | null }>("SELECT cover_path FROM threads WHERE id = ?").get(msg.thread_id)?.cover_path;
  const paths = files.flatMap((f) => [f.file_path, f.thumb_path]);
  db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  if (cover && paths.includes(cover)) db.prepare("UPDATE threads SET cover_path = NULL WHERE id = ?").run(msg.thread_id);
  await removeMediaFiles(paths);
  return true;
}

// Items in Trash for longer than TRASH_DAYS are removed for good. Runs at startup and hourly.
async function purgeExpired() {
  const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
  for (const r of db.prepare<[number], { id: number }>("SELECT id FROM threads WHERE deleted_at < ?").all(cutoff)) await purgeThread(r.id);
  for (const r of db.prepare<[number], { id: number }>("SELECT id FROM messages WHERE deleted_at < ?").all(cutoff)) await purgeMessage(r.id);
}

// Move a thread to Trash. Its messages stay in the database until it is purged.
app.delete("/api/threads/:id", (c) => {
  const res = db.prepare("UPDATE threads SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(Date.now(), Number(c.req.param("id")));
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// Move one message to Trash. Its attachments stay on disk until it is purged.
app.delete("/api/messages/:id", (c) => {
  const id = Number(c.req.param("id"));
  const msg = db.prepare<[number], { thread_id: number }>("SELECT thread_id FROM messages WHERE id = ? AND deleted_at IS NULL").get(id);
  if (!msg) return c.json({ error: "not found" }, 404);
  db.prepare("UPDATE messages SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
  return c.json({ ok: true, threadId: msg.thread_id });
});

// Edit the text of a message. Attachments stay as they are.
app.patch("/api/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson(c);
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return c.json({ error: "text required" }, 400);
  const res = db.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL").run(text, Date.now(), id);
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  const row = db.prepare<[number], MessageRow>("SELECT * FROM messages WHERE id = ?").get(id)!;
  return c.json(toMessages([row])[0]);
});

// Trash: deleted threads, and deleted messages whose thread is still there.
app.get("/api/trash", (c) => {
  const threads = db
    .prepare<[], { id: number; title: string; deleted_at: number; message_count: number }>(`
      SELECT t.id, t.title, t.deleted_at,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.deleted_at IS NULL) AS message_count
      FROM threads t WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC`)
    .all();
  const messages = db
    .prepare<[], { id: number; thread_id: number; thread_title: string; body: string; created_at: number; deleted_at: number; attachment_count: number }>(`
      SELECT m.id, m.thread_id, t.title AS thread_title, m.body, m.created_at, m.deleted_at,
        (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.deleted_at IS NOT NULL AND t.deleted_at IS NULL ORDER BY m.deleted_at DESC`)
    .all();
  return c.json({
    threads: threads.map((t) => ({ id: t.id, title: t.title, deletedAt: t.deleted_at, messageCount: t.message_count })),
    messages: messages.map((m) => ({
      id: m.id, threadId: m.thread_id, threadTitle: m.thread_title, body: m.body,
      createdAt: m.created_at, deletedAt: m.deleted_at, attachmentCount: m.attachment_count,
    })),
  });
});

app.post("/api/trash/threads/:id/restore", (c) => {
  const res = db.prepare("UPDATE threads SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").run(Number(c.req.param("id")));
  return res.changes ? c.json({ ok: true }) : c.json({ error: "not in trash" }, 404);
});

app.delete("/api/trash/threads/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = db.prepare<[number], { id: number }>("SELECT id FROM threads WHERE id = ? AND deleted_at IS NOT NULL").get(id);
  if (!row) return c.json({ error: "not in trash" }, 404);
  await purgeThread(id);
  return c.json({ ok: true });
});

app.post("/api/trash/messages/:id/restore", (c) => {
  const res = db.prepare("UPDATE messages SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL").run(Number(c.req.param("id")));
  return res.changes ? c.json({ ok: true }) : c.json({ error: "not in trash" }, 404);
});

app.delete("/api/trash/messages/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const row = db.prepare<[number], { id: number }>("SELECT id FROM messages WHERE id = ? AND deleted_at IS NOT NULL").get(id);
  if (!row) return c.json({ error: "not in trash" }, 404);
  await purgeMessage(id);
  return c.json({ ok: true });
});

// Empty the whole Trash.
app.delete("/api/trash", async (c) => {
  for (const r of db.prepare<[], { id: number }>("SELECT id FROM threads WHERE deleted_at IS NOT NULL").all()) await purgeThread(r.id);
  for (const r of db.prepare<[], { id: number }>("SELECT id FROM messages WHERE deleted_at IS NOT NULL").all()) await purgeMessage(r.id);
  return c.json({ ok: true });
});

// Search: messages whose text contains the query (threads and tags are filtered in the app).
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);
app.get("/api/search", (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ messages: [] });
  const rows = db
    .prepare<[string], { id: number; thread_id: number; thread_title: string; body: string; created_at: number }>(`
      SELECT m.id, m.thread_id, t.title AS thread_title, m.body, m.created_at
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.deleted_at IS NULL AND m.deleted_at IS NULL AND m.body LIKE ? ESCAPE '\\'
      ORDER BY m.id DESC LIMIT 50`)
    .all(`%${likeEscape(q)}%`);
  return c.json({
    messages: rows.map((r) => {
      // A short piece of text around the first match.
      const at = r.body.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, at - 40);
      const snippet = (start > 0 ? "…" : "") + r.body.slice(start, start + 140).replace(/\s+/g, " ");
      return { id: r.id, threadId: r.thread_id, threadTitle: r.thread_title, createdAt: r.created_at, snippet };
    }),
  });
});

// Link previews: title, description, site and image of a page. Cached in the DB per URL.
app.get("/api/link-preview", async (c) => {
  const url = (c.req.query("url") ?? "").trim();
  if (url.length > 2048 || !/^https?:\/\//i.test(url)) return c.json({ error: "http(s) url required" }, 400);
  const cached = db
    .prepare<[string], { title: string | null; description: string | null; site: string | null; image_url: string | null }>(
      "SELECT title, description, site, image_url FROM link_previews WHERE url = ?")
    .get(url);
  if (cached) {
    return c.json({ url, title: cached.title, description: cached.description, site: cached.site, image: cached.image_url });
  }
  const p = await fetchPreview(url);
  db.prepare("INSERT OR REPLACE INTO link_previews (url, title, description, site, image_url, fetched_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(url, p.title, p.description, p.site, p.image, Date.now());
  return c.json(p);
});

// All pinned messages of a thread, oldest first (for the Pinned side panel).
app.get("/api/threads/:id/pins", (c) => {
  const rows = db
    .prepare<[number], MessageRow>("SELECT * FROM messages WHERE thread_id = ? AND pinned = 1 AND deleted_at IS NULL ORDER BY id")
    .all(Number(c.req.param("id")));
  return c.json(toMessages(rows));
});

// Pin or unpin one message.
app.patch("/api/messages/:id/pin", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson(c);
  if (typeof body.pinned !== "boolean") return c.json({ error: "pinned must be true or false" }, 400);
  const res = db.prepare("UPDATE messages SET pinned = ? WHERE id = ?").run(body.pinned ? 1 : 0, id);
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  const row = db.prepare<[number], MessageRow>("SELECT * FROM messages WHERE id = ?").get(id)!;
  return c.json(toMessages([row])[0]);
});

// Called when a thread is opened; drives the Continue button.
app.post("/api/threads/:id/open", (c) => {
  const id = Number(c.req.param("id"));
  const res = db.prepare("UPDATE threads SET last_opened_at = ? WHERE id = ?").run(Date.now(), id);
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// Change a thread's status (used by the one-click chip in the thread header).
app.patch("/api/threads/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await readJson(c);
  if (typeof body.status !== "string" || !STATUSES.includes(body.status)) return c.json({ error: "bad status" }, 400);
  const res = db.prepare("UPDATE threads SET status = ? WHERE id = ?").run(body.status, id);
  if (res.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json(toThread(getThread.get(id)!));
});

app.get("/api/threads/:id", (c) => {
  const row = getThread.get(Number(c.req.param("id")));
  return row ? c.json(toThread(row)) : c.json({ error: "not found" }, 404);
});

const PAGE = 100;

// Newest PAGE messages (or the PAGE before `before`), returned oldest-first.
app.get("/api/threads/:id/messages", (c) => {
  const id = Number(c.req.param("id"));
  const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
  const rows = db
    .prepare<[number, number, number], MessageRow>(
      "SELECT * FROM messages WHERE thread_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?",
    )
    .all(id, before, PAGE + 1);
  const hasMore = rows.length > PAGE;
  return c.json({ messages: toMessages(rows.slice(0, PAGE).reverse()), hasMore });
});

// Accepts multipart/form-data: text field "body" and any number of "files".
// Text-only JSON is accepted too, so the old path still works.
app.post("/api/threads/:id/messages", async (c) => {
  const threadId = Number(c.req.param("id"));
  if (!getThread.get(threadId)) return c.json({ error: "not found" }, 404);

  let text = "";
  let uploads: File[] = [];
  const type = c.req.header("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await c.req.parseBody({ all: true });
    text = typeof form.body === "string" ? form.body : "";
    const f = form.files;
    uploads = (Array.isArray(f) ? f : f ? [f] : []).filter((x): x is File => x instanceof File && x.size > 0);
  } else {
    const body = await readJson(c);
    text = typeof body.body === "string" ? body.body : "";
  }
  text = text.trim();
  if (!text && uploads.length === 0) return c.json({ error: "empty message" }, 400);

  const processed: Processed[] = [];
  let msgId: number;
  try {
    for (const file of uploads) processed.push(await processUpload(file, MEDIA_DIR));
    msgId = insertMessage(threadId, text, processed, uploads.map((f) => f.name));
  } catch (e) {
    // Drop files already written for this failed message.
    for (const p of processed) for (const rel of [p.filePath, p.thumbPath]) if (rel) await fs.rm(path.join(MEDIA_DIR, rel), { force: true });
    console.error("upload failed:", e);
    return c.json({ error: "Could not store the upload" }, 500);
  }
  const row = db.prepare<[number], MessageRow>("SELECT * FROM messages WHERE id = ?").get(msgId)!;
  return c.json(toMessages([row])[0], 201);
});

// Static media with HTTP Range support (needed for video seeking). Streams, so big videos stay out of memory.
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return null; } };

app.get("/media/*", async (c) => {
  const rel = safeDecode(c.req.path.slice("/media/".length));
  if (rel === null || rel.includes("\0")) return c.text("bad request", 400);
  const abs = path.resolve(MEDIA_DIR, rel);
  if (!abs.startsWith(MEDIA_DIR + path.sep)) return c.text("forbidden", 403);

  let size: number;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return c.text("not found", 404);
    size = st.size;
  } catch {
    return c.text("not found", 404);
  }
  const headers: Record<string, string> = {
    "Content-Type": MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  };
  const stream = (start: number, end: number) =>
    Readable.toWeb(createReadStream(abs, { start, end })) as unknown as ReadableStream;

  const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (m && (m[1] !== "" || m[2] !== "")) {
    let start: number, end: number;
    if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    return new Response(stream(start, end), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  if (size === 0) return new Response(null, { headers: { ...headers, "Content-Length": "0" } });
  return new Response(stream(0, size - 1), { headers: { ...headers, "Content-Length": String(size) } });
});

app.get("/api/tags", (c) =>
  c.json(db.prepare<[], { name: string }>("SELECT name FROM tags ORDER BY name").all().map((r) => r.name)),
);

// ---- Folder import of DiscordChatExporter HTML exports: one thread per .html file ----
const decodeHtml = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

// Inner HTML of the div whose opening tag starts at `start`. Nested divs (quotes) are counted, so they stay in.
const divInner = (html: string, start: number): string => {
  const open = html.indexOf(">", start) + 1;
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = open;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0] === "</div>") {
      if (--depth === 0) return html.slice(open, m.index);
    } else depth++;
  }
  return html.slice(open);
};

type ExportMessage = { text: string; files: string[] };
type ParsedExport = { title: string; messages: ExportMessage[] };

async function parseExport(file: string): Promise<ParsedExport> {
  const html = await fs.readFile(file, "utf8");
  const rawTitle = decodeHtml(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "");
  // The page title looks like "Server - Thread name"; keep the part after the first " - ".
  const title = (rawTitle.split(" - ").slice(1).join(" - ") || rawTitle).trim() || path.basename(file, path.extname(file));
  const messages: ExportMessage[] = [];
  for (const part of html.split(/(?=<div class="?chatlog__message-group"?>)/).slice(1)) {
    const texts: string[] = [];
    for (const m of part.matchAll(/<div class="?chatlog__content chatlog__markdown"?>/g)) {
      texts.push(decodeHtml(divInner(part, m.index!)).replace(/\r/g, "").trim());
    }
    // Avatars and timestamps sit in the aside; only attachments and embeds carry media links.
    const scan = part.replace(/<div class="?chatlog__message-aside"?>[\s\S]*?<\/div>(?=<div class="?chatlog__message-primary|<\/div>)/g, "");
    const files: string[] = [];
    for (const m of scan.matchAll(/(?:href|src)=("?)([^\s>"]+)\1/g)) {
      let raw = m[2];
      try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
      const at = raw.indexOf("_Files/");
      if (at === -1) continue;
      const name = raw.slice(at + "_Files/".length);
      if (name && !files.includes(name)) files.push(name);
    }
    const text = texts.join("\n").trim();
    if (text || files.length) messages.push({ text, files });
  }
  return { title, messages };
}

// A thread counts as already imported if its title matches, or its first long message text is already in the app.
const isAlreadyInApp = (title: string, firstText: string): boolean => {
  if (listThreads.all().some((t) => t.title.toLowerCase() === title.toLowerCase())) return true;
  if (firstText.length < 20) return false;
  return !!db.prepare<[string], { id: number }>("SELECT id FROM messages WHERE REPLACE(body, char(13), '') = ? LIMIT 1").get(firstText);
};

const resolveFolder = (raw: unknown) => (typeof raw === "string" && raw.trim() ? path.resolve(raw.trim()) : null);

// One importable item: a Discord HTML export (kind "discord") or a GigaNotes thread folder (kind "giga").
type ItemFile = { src: string; name: string; mime: string };
type ItemMessage = { text: string; files: ItemFile[]; pinned: boolean; createdAt: number | null };
type Item = { kind: "discord" | "giga"; name: string; title: string; status: string | null; tags: string[]; messages: ItemMessage[] };

type GigaJson = {
  title?: string; status?: string; tags?: string[];
  messages?: { body?: string; pinned?: boolean; createdAt?: number; attachments?: { file: string; name?: string | null; mime?: string | null }[] }[];
};

// Reads one entry of a folder: a .html export, or a folder holding thread.json. Null if it is neither.
async function readItem(dir: string, name: string): Promise<Item | null> {
  const abs = path.join(dir, path.basename(name));
  const st = await fs.stat(abs).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) {
    const raw = await fs.readFile(path.join(abs, "thread.json"), "utf8").catch(() => null);
    if (raw === null) return null;
    const j = JSON.parse(raw) as GigaJson;
    return {
      kind: "giga", name, title: (j.title ?? "").trim() || path.basename(abs), status: j.status ?? null, tags: j.tags ?? [],
      messages: (j.messages ?? []).map((m) => ({
        text: m.body ?? "",
        pinned: !!m.pinned,
        createdAt: typeof m.createdAt === "number" ? m.createdAt : null,
        files: (m.attachments ?? []).map((a) => ({
          src: path.join(abs, a.file),
          name: a.name ?? path.basename(a.file),
          mime: a.mime ?? MIME_BY_EXT[path.extname(a.file).toLowerCase()] ?? "application/octet-stream",
        })),
      })),
    };
  }
  if (st.isFile() && /\.html?$/i.test(name)) {
    const parsed = await parseExport(abs);
    return {
      kind: "discord", name, title: parsed.title, status: null, tags: [],
      messages: parsed.messages.map((m) => ({
        text: m.text,
        pinned: false,
        createdAt: null,
        files: m.files.map((f) => ({
          src: path.join(`${abs}_Files`, f),
          name: f,
          mime: MIME_BY_EXT[path.extname(f).toLowerCase()] ?? "application/octet-stream",
        })),
      })),
    };
  }
  return null;
}

const firstLongText = (item: Item) => item.messages.find((m) => m.text)?.text ?? "";

// Lists the Discord exports and GigaNotes thread folders in a folder, without importing anything.
app.post("/api/import/scan", async (c) => {
  const dir = resolveFolder((await readJson(c)).path);
  if (!dir) return c.json({ error: "folder path required" }, 400);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).sort();
  } catch {
    return c.json({ error: "folder not found" }, 404);
  }
  const out = [];
  for (const name of names) {
    const item = await readItem(dir, name).catch(() => null);
    if (!item) continue;
    out.push({
      kind: item.kind,
      name: item.name,
      title: item.title,
      messages: item.messages.length,
      media: item.messages.reduce((n, m) => n + m.files.length, 0),
      alreadyInApp: isAlreadyInApp(item.title, firstLongText(item)),
    });
  }
  return c.json({ folder: dir, exports: out });
});

type ImportJob = {
  running: boolean; total: number; done: number; current: string;
  imported: string[]; skipped: string[]; errors: string[]; missingFiles: number;
};
const emptyJob = (): ImportJob => ({ running: false, total: 0, done: 0, current: "", imported: [], skipped: [], errors: [], missingFiles: 0 });
let importJob: ImportJob = emptyJob();

// Imports the chosen items one after another. Each becomes a new thread with its messages in order.
async function runImport(dir: string, names: string[]) {
  const job = importJob;
  for (const name of names) {
    job.current = name;
    try {
      const item = await readItem(dir, name);
      if (!item) throw new Error("not an export or thread folder");
      if (isAlreadyInApp(item.title, firstLongText(item))) {
        job.skipped.push(name);
      } else {
        // Discord exports are old, finished playthroughs, so they start as Finished.
        const status = item.kind === "giga" && item.status && (STATUSES as string[]).includes(item.status) ? item.status : "Finished";
        const threadId = createThread(item.title, status, item.tags);
        for (const m of item.messages) {
          const processed: Processed[] = [];
          const fileNames: string[] = [];
          for (const f of m.files) {
            let buf: Buffer;
            try {
              buf = await fs.readFile(f.src);
            } catch {
              job.missingFiles++;
              continue;
            }
            processed.push(await processUpload(new File([new Uint8Array(buf)], f.name, { type: f.mime }), MEDIA_DIR));
            fileNames.push(f.name);
          }
          if (!m.text && processed.length === 0) continue;
          const msgId = insertMessage(threadId, m.text, processed, fileNames);
          if (m.createdAt !== null) db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(m.createdAt, msgId);
          if (m.pinned) db.prepare("UPDATE messages SET pinned = 1 WHERE id = ?").run(msgId);
        }
        job.imported.push(item.title);
      }
    } catch (e) {
      job.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    job.done++;
  }
  job.running = false;
  job.current = "";
}

// Starts an import of the given export file names (from a scan). Runs in the background; poll the status.
app.post("/api/import/run", async (c) => {
  if (importJob.running) return c.json({ error: "an import is already running" }, 409);
  const body = await readJson(c);
  const dir = resolveFolder(body.path);
  const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [];
  if (!dir || files.length === 0) return c.json({ error: "folder and files required" }, 400);
  importJob = { ...emptyJob(), running: true, total: files.length };
  void runImport(dir, files);
  return c.json({ started: true, total: files.length }, 202);
});

app.get("/api/import/status", (c) => c.json(importJob));

// ---- Export one thread to a folder: <folder>/<thread title>/thread.json plus media/ with the original files ----
const safeFolderName = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim() || "thread";

app.post("/api/export/thread", async (c) => {
  const body = await readJson(c);
  const id = Number(body.id);
  const root = resolveFolder(body.path);
  if (!root || !Number.isInteger(id)) return c.json({ error: "thread and folder required" }, 400);
  const thread = getThread.get(id);
  if (!thread) return c.json({ error: "not found" }, 404);

  const rows = db.prepare<[number], MessageRow>("SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id").all(id);
  const atts = attachmentsFor(rows.map((r) => r.id));
  const out = path.join(root, safeFolderName(thread.title));
  const mediaOut = path.join(out, "media");
  await fs.mkdir(mediaOut, { recursive: true });

  let copied = 0;
  let missing = 0;
  const messages = [];
  for (const m of rows) {
    const files = [];
    for (const a of atts.get(m.id) ?? []) {
      const rel = a.url.slice("/media/".length);
      const name = path.basename(rel);
      try {
        await fs.copyFile(path.join(MEDIA_DIR, rel), path.join(mediaOut, name));
        copied++;
        files.push({ kind: a.kind, name: a.name, mime: a.mime, width: a.width, height: a.height, duration: a.duration, file: `media/${name}` });
      } catch {
        missing++;
      }
    }
    messages.push({ body: m.body, pinned: !!m.pinned, createdAt: m.created_at, attachments: files });
  }
  const info = toThread(thread);
  const meta = {
    title: info.title,
    status: info.status,
    tags: info.tags,
    createdAt: info.createdAt,
    messages,
  };
  await fs.writeFile(path.join(out, "thread.json"), JSON.stringify(meta, null, 2), "utf8");
  return c.json({ ok: true, folder: out, messages: messages.length, media: copied, missing });
});

// Built frontend (only in the desktop app, where GIGA_STATIC points at dist/).
// Registered last, so API and media routes win. Unknown paths get index.html (hash router).
const STATIC_DIR = process.env.GIGA_STATIC ? path.resolve(process.env.GIGA_STATIC) : null;
const MIME_STATIC: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};
if (STATIC_DIR) {
  app.get("*", async (c) => {
    const dec = safeDecode(c.req.path);
    if (dec === null || dec.includes("\0")) return c.text("bad request", 400);
    const rel = dec.replace(/^\/+/, "") || "index.html";
    let abs = path.resolve(STATIC_DIR, rel);
    if (!abs.startsWith(STATIC_DIR + path.sep)) return c.text("forbidden", 403);
    let buf: Buffer | null = await fs.readFile(abs).catch(() => null);
    if (!buf) {
      abs = path.join(STATIC_DIR, "index.html");
      buf = await fs.readFile(abs).catch(() => null);
    }
    if (!buf) return c.text("not found", 404);
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": MIME_STATIC[path.extname(abs)] ?? "application/octet-stream" },
    });
  });
}

// Clear out Trash items older than TRASH_DAYS now, then once an hour while running.
await purgeExpired().catch((e) => console.error("trash purge failed:", e));
setInterval(() => void purgeExpired().catch((e) => console.error("trash purge failed:", e)), 3_600_000);

// Localhost only.
// GIGA_PORT is only for tests; the desktop shell always uses 3001.
serve({ fetch: app.fetch, port: Number(process.env.GIGA_PORT) || 3001, hostname: "127.0.0.1" }, (i) =>
  console.log(`GigaNotes API on http://127.0.0.1:${i.port}  (data: ${DATA_DIR})`),
);
