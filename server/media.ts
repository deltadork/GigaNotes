import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

export type Kind = "image" | "gif" | "video" | "file";

export type Processed = {
  kind: Kind;
  filePath: string;      // relative to media dir, e.g. "2026/<uuid>.png"
  thumbPath: string | null;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
};

const THUMB_W = 1200;

const extFor = (name: string, mime: string) => {
  const fromName = path.extname(name).toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(fromName)) return fromName; // never let a hostile file name into the path
  const map: Record<string, string> = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
  };
  return map[mime] ?? ".bin";
};

const kindFor = (mime: string): Kind =>
  mime === "image/gif" ? "gif" : mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file";

/** Stores one uploaded file under mediaDir and returns its metadata. */
export async function processUpload(file: File, mediaDir: string): Promise<Processed> {
  const ext = extFor(file.name, file.type);
  // Some clients send application/octet-stream; trust the extension then.
  const mime =
    file.type && file.type !== "application/octet-stream"
      ? file.type
      : MIME_BY_EXT[ext] ?? "application/octet-stream";
  const kind = kindFor(mime);
  const year = String(new Date().getFullYear());
  const id = randomUUID();
  const rel = path.posix.join(year, id + ext);
  const abs = path.join(mediaDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(abs, buf);

  const base: Processed = {
    kind, filePath: rel, thumbPath: null, mime, size: buf.length,
    width: null, height: null, duration: null,
  };

  try {
    return await withMedia(kind, buf, abs, id, year, mediaDir, base);
  } catch (e) {
    // Corrupt or unsupported (e.g. HEIC): keep the file as a plain attachment instead of failing the message.
    console.warn("media processing failed, storing as file:", e);
    return { ...base, kind: "file" };
  }
}

async function withMedia(kind: Kind, buf: Buffer, abs: string, id: string, year: string, mediaDir: string, base: Processed): Promise<Processed> {
  if (kind === "image" || kind === "gif") {
    const img = sharp(buf);
    const meta = await img.metadata();
    let { width = null, height = null } = meta;
    // EXIF orientation 5-8 means the image is stored rotated by 90 degrees.
    if (meta.orientation && meta.orientation >= 5 && width && height) [width, height] = [height, width];
    const thumbRel = path.posix.join(year, "thumbs", id + ".webp");
    await fs.mkdir(path.dirname(path.join(mediaDir, thumbRel)), { recursive: true });
    await sharp(buf).rotate().resize({ width: THUMB_W, withoutEnlargement: true }).webp({ quality: 85 })
      .toFile(path.join(mediaDir, thumbRel));
    return { ...base, width, height, thumbPath: thumbRel };
  }

  if (kind === "video") {
    // Full stream/format output: ffprobe rejects side_data in -show_entries and dumps packets instead.
    const { stdout } = await run(ffprobePath.path, [
      "-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", abs,
    ]);
    const probe = JSON.parse(stdout);
    const s = probe.streams?.[0] ?? {};
    let width: number | null = s.width ?? null;
    let height: number | null = s.height ?? null;
    const rot = Math.abs(Number(s.tags?.rotate ?? s.side_data_list?.[0]?.rotation ?? 0));
    if ((rot === 90 || rot === 270) && width && height) [width, height] = [height, width];
    const duration = probe.format?.duration ? Number(probe.format.duration) : null;

    const thumbRel = path.posix.join(year, "thumbs", id + ".jpg");
    await fs.mkdir(path.dirname(path.join(mediaDir, thumbRel)), { recursive: true });
    // Grab a frame a little in (or the first frame for very short clips).
    const seek = duration && duration > 1 ? "1" : "0";
    await run(ffmpegPath as unknown as string, [
      "-v", "error", "-ss", seek, "-i", abs, "-frames:v", "1",
      "-vf", `scale=${THUMB_W}:-2`, "-y", path.join(mediaDir, thumbRel),
    ]).catch(() => null); // no thumb is OK; the UI falls back to a plain box
    const hasThumb = await fs.stat(path.join(mediaDir, thumbRel)).then(() => true, () => false);
    return { ...base, width, height, duration, thumbPath: hasThumb ? thumbRel : null };
  }

  return base;
}

export const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};
