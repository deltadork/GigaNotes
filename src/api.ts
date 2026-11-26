export const STATUSES = ["Playing", "Finished", "Dropped", "Plan to play"] as const;
export type Status = (typeof STATUSES)[number];

export type Thread = {
  id: number; title: string; status: Status; coverUrl: string | null;
  messageCount: number; tags: string[]; lastOpenedAt: number | null;
};

export type Attachment = {
  id: number; kind: "image" | "gif" | "video" | "file";
  url: string; thumbUrl: string | null; mime: string | null; size: number | null;
  width: number | null; height: number | null; duration: number | null; name: string | null;
};

export type Message = {
  id: number; threadId: number; body: string; pinned: boolean; createdAt: number; editedAt: number | null;
  attachments: Attachment[];
};

export type MessagePage = { messages: Message[]; hasMore: boolean };

export type SearchHit = { id: number; threadId: number; threadTitle: string; createdAt: number; snippet: string };
export type LinkPreview = { url: string; title: string | null; description: string | null; site: string | null; image: string | null };
export type TrashThread = { id: number; title: string; deletedAt: number; messageCount: number };
export type TrashMessage = {
  id: number; threadId: number; threadTitle: string; body: string; createdAt: number; deletedAt: number; attachmentCount: number;
};
export type Trash = { threads: TrashThread[]; messages: TrashMessage[] };

const json = { "Content-Type": "application/json" };

const checked = async <T,>(r: Response): Promise<T> => {
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return r.json();
};

export type ScanItem = { kind: "discord" | "giga"; name: string; title: string; messages: number; media: number; alreadyInApp: boolean };
export type ImportStatus = {
  running: boolean; total: number; done: number; current: string;
  imported: string[]; skipped: string[]; errors: string[]; missingFiles: number;
};

export const api = {
  importScan: (path: string): Promise<{ folder: string; exports: ScanItem[] }> =>
    fetch("/api/import/scan", { method: "POST", headers: json, body: JSON.stringify({ path }) }).then((r) => checked(r)),
  importRun: (path: string, files: string[]): Promise<{ started: boolean; total: number }> =>
    fetch("/api/import/run", { method: "POST", headers: json, body: JSON.stringify({ path, files }) }).then((r) => checked(r)),
  importStatus: (): Promise<ImportStatus> => fetch("/api/import/status").then((r) => r.json()),
  exportThread: (id: number, path: string): Promise<{ ok: boolean; folder: string; messages: number; media: number; missing: number }> =>
    fetch("/api/export/thread", { method: "POST", headers: json, body: JSON.stringify({ id, path }) }).then((r) => checked(r)),
  list: (): Promise<Thread[]> => fetch("/api/threads").then((r) => r.json()),
  create: (title: string, status: Status, tags: string[]): Promise<Thread> =>
    fetch("/api/threads", { method: "POST", headers: json, body: JSON.stringify({ title, status, tags }) }).then((r) => r.json()),
  thread: (id: number): Promise<Thread> => fetch(`/api/threads/${id}`).then((r) => checked<Thread>(r)),
  pins: (id: number): Promise<Message[]> =>
    fetch(`/api/threads/${id}/pins`).then((r) => checked<Message[]>(r)),
  setPinned: (messageId: number, pinned: boolean): Promise<Message> =>
    fetch(`/api/messages/${messageId}/pin`, { method: "PATCH", headers: json, body: JSON.stringify({ pinned }) }).then((r) => checked<Message>(r)),
  open: (id: number): Promise<{ ok: boolean }> =>
    fetch(`/api/threads/${id}/open`, { method: "POST" }).then((r) => r.json()),
  setStatus: (id: number, status: Status): Promise<Thread> =>
    fetch(`/api/threads/${id}/status`, { method: "PATCH", headers: json, body: JSON.stringify({ status }) }).then((r) => checked<Thread>(r)),
  // Newest `limit` messages (oldest-first). Pass `before` (a message id) for older pages.
  messages: (id: number, before?: number): Promise<MessagePage> =>
    fetch(`/api/threads/${id}/messages${before ? `?before=${before}` : ""}`).then((r) => checked<MessagePage>(r)),
  setCover: (id: number, file: File): Promise<Thread> => {
    const form = new FormData();
    form.append("file", file, file.name);
    return fetch(`/api/threads/${id}/cover`, { method: "PUT", body: form }).then((r) => checked<Thread>(r));
  },
  deleteThread: (id: number): Promise<{ ok: boolean }> =>
    fetch(`/api/threads/${id}`, { method: "DELETE" }).then((r) => checked<{ ok: boolean }>(r)),
  deleteMessage: (messageId: number): Promise<{ ok: boolean; threadId: number }> =>
    fetch(`/api/messages/${messageId}`, { method: "DELETE" }).then((r) => checked<{ ok: boolean; threadId: number }>(r)),
  editMessage: (messageId: number, body: string): Promise<Message> =>
    fetch(`/api/messages/${messageId}`, { method: "PATCH", headers: json, body: JSON.stringify({ body }) }).then((r) => checked<Message>(r)),
  search: (q: string): Promise<{ messages: SearchHit[] }> =>
    fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => checked<{ messages: SearchHit[] }>(r)),
  linkPreview: (url: string): Promise<LinkPreview> =>
    fetch(`/api/link-preview?url=${encodeURIComponent(url)}`).then((r) => checked<LinkPreview>(r)),
  trash: (): Promise<Trash> => fetch("/api/trash").then((r) => checked<Trash>(r)),
  restoreThread: (id: number): Promise<{ ok: boolean }> =>
    fetch(`/api/trash/threads/${id}/restore`, { method: "POST" }).then((r) => checked<{ ok: boolean }>(r)),
  purgeThread: (id: number): Promise<{ ok: boolean }> =>
    fetch(`/api/trash/threads/${id}`, { method: "DELETE" }).then((r) => checked<{ ok: boolean }>(r)),
  restoreMessage: (id: number): Promise<{ ok: boolean }> =>
    fetch(`/api/trash/messages/${id}/restore`, { method: "POST" }).then((r) => checked<{ ok: boolean }>(r)),
  purgeMessage: (id: number): Promise<{ ok: boolean }> =>
    fetch(`/api/trash/messages/${id}`, { method: "DELETE" }).then((r) => checked<{ ok: boolean }>(r)),
  emptyTrash: (): Promise<{ ok: boolean }> =>
    fetch("/api/trash", { method: "DELETE" }).then((r) => checked<{ ok: boolean }>(r)),
  clearCover: (id: number): Promise<Thread> =>
    fetch(`/api/threads/${id}/cover`, { method: "DELETE" }).then((r) => checked<Thread>(r)),
  // Multipart so text and files go in one message.
  send: (id: number, body: string, files: File[]): Promise<Message> => {
    const form = new FormData();
    form.append("body", body);
    for (const f of files) form.append("files", f, f.name);
    return fetch(`/api/threads/${id}/messages`, { method: "POST", body: form }).then((r) => checked<Message>(r));
  },
};

// Files from a Ctrl+V. Empty when the clipboard also carries plain text (copying from Word or a web page
// adds a picture of the text), so the text pastes normally instead of turning into an attachment.
export const pastedFiles = (data: DataTransfer): File[] => {
  if (data.getData("text/plain")) return [];
  return Array.from(data.items)
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter((f): f is File => f !== null);
};

export const statusClass = (s: string) => "chip status-" + s.toLowerCase().replace(/\s+/g, "-");
