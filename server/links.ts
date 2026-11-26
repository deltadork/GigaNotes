import dns from "node:dns/promises";
import net from "node:net";

// Link previews: read the title, description, site name and image of a web page.
// Only public addresses are fetched, so a pasted link cannot reach this machine or the local network.

export type LinkPreview = {
  url: string; title: string | null; description: string | null; site: string | null; image: string | null;
};

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 6000;

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(v)) {
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
  }
  return true; // not an address at all: refuse
}

async function assertPublic(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http(s)");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("address not allowed");
}

const codePoint = (n: number) => (n <= 0x10ffff ? String.fromCodePoint(n) : "");
const decodeEntities = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Follows a few redirects, checking every address on the way. Returns the final URL and the start of the page.
async function fetchPage(url: string): Promise<{ finalUrl: URL; html: string }> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    await assertPublic(current);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "GigaNotes-LinkPreview/1.0", Accept: "text/html,application/xhtml+xml" },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      current = new URL(loc, current);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    if (!/text\/html|application\/xhtml/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      throw new Error("not a web page");
    }
    return { finalUrl: current, html: await readStart(res) };
  }
}

async function readStart(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

// <meta property|name="..." content="..."> pairs, first occurrence wins, keys lower-cased.
function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1];
    if (key && content !== undefined && !(key in out)) out[key] = decodeEntities(content).trim();
  }
  return out;
}

const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
};

const absoluteImage = (src: string, base: URL): string | null => {
  try {
    const u = new URL(src, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

// Never throws: a page that cannot be read gives a preview with only the site name.
export async function fetchPreview(url: string): Promise<LinkPreview> {
  try {
    const { finalUrl, html } = await fetchPage(url);
    const meta = metaTags(html);
    const pick = (...keys: string[]) => keys.map((k) => meta[k]).find((v) => v) || null;
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    const pageTitle = titleTag ? decodeEntities(titleTag).trim() || null : null;
    const image = pick("og:image", "og:image:url", "twitter:image");
    return {
      url,
      title: (pick("og:title", "twitter:title") ?? pageTitle)?.slice(0, 300) ?? null,
      description: pick("og:description", "twitter:description", "description")?.slice(0, 500) ?? null,
      site: pick("og:site_name") ?? finalUrl.hostname.replace(/^www\./, ""),
      image: image ? absoluteImage(image, finalUrl) : null,
    };
  } catch {
    return { url, title: null, description: null, site: hostOf(url), image: null };
  }
}
