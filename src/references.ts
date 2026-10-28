/**
 * Web reference search for the MCP server.
 *
 * A model of a known character, creature, vehicle or product is only as good
 * as the references behind it: one image hides the back, the sides and the
 * small parts. These helpers search the public web for more (Bing and
 * DuckDuckGo image search with safe search forced on, Wikimedia Commons for
 * freely licensed photos and diagrams, Wikipedia for a short description),
 * download images safely, and keep the last results so the agent can load a
 * result into Blockbench by its number.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const API_UA = "blockbench-mcp (https://github.com/sosadly/blockbench-mcp; reference search)";

export interface RefResult {
  index: number;
  title: string;
  image_url: string;
  thumbnail_url: string;
  page_url?: string;
  width?: number;
  height?: number;
  source: string;
  query: string;
}

let lastResults: RefResult[] = [];
let lastKey = "";
export function lastSearchResults(): RefResult[] {
  return lastResults;
}

function searchKey(opts: SearchOptions): string {
  return JSON.stringify([
    String(opts.query || "").trim().toLowerCase(),
    (opts.kind || "auto").toLowerCase(),
    opts.queries || [],
    opts.limit ?? 8,
    opts.sources || [],
  ]);
}

/**
 * The results of the previous identical search, if there was one. Engines
 * reorder their answers between calls, so `load:[N]` must use the numbers the
 * caller actually saw on the contact sheet, not a fresh search.
 */
export function cachedSearch(opts: SearchOptions): RefResult[] | null {
  return lastResults.length && lastKey === searchKey(opts) ? lastResults : null;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Refuse anything that is not plain public http(s): the server runs on the
 * user's machine, next to the Blockbench bridge, so a URL must never reach
 * localhost or the LAN.
 */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Only http(s) URLs can be loaded, got ${u.protocol}`);
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost =
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^0\./.test(h) ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h === "::" ||
    /^f[cd][0-9a-f]{2}:/.test(h) ||
    /^fe80:/.test(h) ||
    /^::ffff:/.test(h) ||
    !h.includes(".") && !h.includes(":");
  if (privateHost) throw new Error(`Refusing to fetch a local/private address (${u.hostname}).`);
  return u;
}

function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) ||
    (v.startsWith("::ffff:") && isPrivateIp(v.slice(7)));
}

/** The hostname must also RESOLVE to a public address (no DNS tricks onto the LAN). */
async function assertPublicHost(u: URL): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`Refusing to fetch ${u.hostname}: it resolves to a private address.`);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    // Follow redirects by hand so every hop is checked against assertPublicUrl.
    let current = assertPublicUrl(url).toString();
    for (let hop = 0; hop < 5; hop++) {
      await assertPublicHost(new URL(current));
      const res = await fetch(current, { ...init, redirect: "manual", signal: controller.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = assertPublicUrl(new URL(res.headers.get("location")!, current).toString()).toString();
        continue;
      }
      return res;
    }
    throw new Error("Too many redirects.");
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error(`Timed out fetching ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Sniff the real image type from the first bytes; never trust the header alone. */
function sniffImage(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(buf.toString("ascii", 8, 12))) return "image/avif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

export interface DownloadedImage {
  mime: string;
  base64: string;
  bytes: number;
  url: string;
}

export async function downloadImage(url: string, referer?: string, timeoutMs = 20000): Promise<DownloadedImage> {
  const res = await fetchWithTimeout(
    url,
    { headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", ...(referer ? { Referer: referer } : {}) } },
    timeoutMs
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_IMAGE_BYTES) throw new Error(`Image is too large (${(len / 1048576).toFixed(1)} MB).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image is too large (${(buf.length / 1048576).toFixed(1)} MB).`);
  const mime = sniffImage(buf);
  if (!mime) throw new Error(`Not an image (or an unsupported type) at ${url}.`);
  return { mime, base64: buf.toString("base64"), bytes: buf.length, url };
}

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

async function searchBing(q: string, count: number): Promise<Omit<RefResult, "index">[]> {
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=0&count=${Math.min(50, count * 2)}&mmasync=1&adlt=strict`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "SRCHHPGUSR=ADLT=STRICT" } });
  const html = await res.text();
  const out: Omit<RefResult, "index">[] = [];
  for (const m of html.matchAll(/\sm="(\{[^"]+\})"/g)) {
    try {
      const j = JSON.parse(decodeEntities(m[1]));
      if (!j.murl || !j.turl) continue;
      out.push({ title: String(j.t || "").slice(0, 120), image_url: j.murl, thumbnail_url: j.turl, page_url: j.purl, source: "bing", query: q });
    } catch {
      /* skip a malformed entry */
    }
  }
  return out;
}

async function searchDuckDuckGo(q: string): Promise<Omit<RefResult, "index">[]> {
  const page = await fetchWithTimeout(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images&kp=1`, { headers: { "User-Agent": UA } });
  const html = await page.text();
  const m = /vqd=["']?([\d-]+)/.exec(html) || /vqd="([^"]+)"/.exec(html);
  if (!m) throw new Error("DuckDuckGo did not return a search token.");
  const res = await fetchWithTimeout(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${m[1]}&f=,,,,,&p=1&kp=1`,
    { headers: { "User-Agent": UA, Referer: "https://duckduckgo.com/" } }
  );
  const j: any = await res.json();
  return (j.results || []).map((r: any) => ({
    title: String(r.title || "").slice(0, 120),
    image_url: r.image,
    thumbnail_url: r.thumbnail,
    page_url: r.url,
    width: r.width,
    height: r.height,
    source: "duckduckgo",
    query: q,
  }));
}

async function searchCommons(q: string, count: number): Promise<Omit<RefResult, "index">[]> {
  const url =
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(q + " filetype:bitmap")}` +
    `&gsrnamespace=6&gsrlimit=${Math.min(30, count * 2)}&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=320`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": API_UA } });
  const j: any = await res.json();
  const pages = Object.values(j?.query?.pages || {}) as any[];
  return pages
    .filter((p) => p.imageinfo?.[0]?.mime?.startsWith("image/") && !/svg/.test(p.imageinfo[0].mime))
    .map((p) => ({
      title: String(p.title || "").replace(/^File:/, "").slice(0, 120),
      image_url: p.imageinfo[0].url,
      thumbnail_url: p.imageinfo[0].thumburl || p.imageinfo[0].url,
      page_url: p.imageinfo[0].descriptionurl,
      width: p.imageinfo[0].width,
      height: p.imageinfo[0].height,
      source: "wikimedia",
      query: q,
    }));
}

/** A two-sentence description of the subject, when Wikipedia knows it. */
export async function describeSubject(q: string): Promise<{ title: string; extract: string; url: string } | null> {
  try {
    const s = await fetchWithTimeout(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=1`,
      { headers: { "User-Agent": API_UA } },
      8000
    );
    const sj: any = await s.json();
    const title = sj?.query?.search?.[0]?.title;
    if (!title) return null;
    const r = await fetchWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      { headers: { "User-Agent": API_UA } },
      8000
    );
    const j: any = await r.json();
    if (!j?.extract) return null;
    return { title: j.title, extract: String(j.extract).slice(0, 700), url: j.content_urls?.desktop?.page || "" };
  } catch {
    return null;
  }
}

const KIND_QUERIES: Record<string, string[]> = {
  character: ["{q} full body", "{q} reference sheet", "{q} official art", "{q} back view"],
  creature: ["{q}", "{q} full body", "{q} side view", "{q} concept art"],
  object: ["{q}", "{q} side view", "{q} close up", "{q} diagram"],
  vehicle: ["{q}", "{q} side view", "{q} front view", "{q} blueprint"],
  building: ["{q}", "{q} exterior", "{q} front", "{q} aerial"],
  mechanism: ["{q}", "{q} diagram", "{q} close up", "{q} cutaway"],
  auto: ["{q}", "{q} reference", "{q} full view"],
};

export interface SearchOptions {
  query: string;
  kind?: string;
  queries?: string[];
  limit?: number;
  sources?: string[];
}

/** Run the searches, merge, de-duplicate, remember the results. */
export async function searchReferences(opts: SearchOptions): Promise<{ results: RefResult[]; errors: string[]; queries: string[] }> {
  const limit = Math.max(1, Math.min(24, Math.round(opts.limit ?? 8)));
  const kind = (opts.kind || "auto").toLowerCase();
  const queries = (opts.queries && opts.queries.length
    ? opts.queries
    : (KIND_QUERIES[kind] || KIND_QUERIES.auto).map((t) => t.replace("{q}", opts.query))
  ).slice(0, 5);
  const sources = (opts.sources && opts.sources.length ? opts.sources : ["bing", "duckduckgo"]).map((s) => s.toLowerCase());
  const errors: string[] = [];
  const perQuery = Math.max(2, Math.ceil(limit / queries.length) + 1);
  const buckets: Omit<RefResult, "index">[][] = [];
  await Promise.all(
    queries.map(async (q, qi) => {
      const found: Omit<RefResult, "index">[] = [];
      for (const src of sources) {
        try {
          if (src === "bing") found.push(...(await searchBing(q, perQuery)));
          else if (src === "duckduckgo" || src === "ddg") found.push(...(await searchDuckDuckGo(q)));
          else if (src === "wikimedia" || src === "commons") found.push(...(await searchCommons(q, perQuery)));
          else errors.push(`unknown source "${src}"`);
          if (found.length >= perQuery * 2 && src !== "wikimedia") break; // the first engine that answers is enough
        } catch (e: any) {
          errors.push(`${src} (${q}): ${e?.message ?? e}`);
        }
      }
      buckets[qi] = found;
    })
  );
  // Round-robin across queries so the sheet shows several angles, not 8 copies of one.
  const seen = new Set<string>();
  const merged: RefResult[] = [];
  const keyOf = (u: string) => u.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").toLowerCase();
  for (let round = 0; merged.length < limit && round < 60; round++) {
    let any = false;
    for (const b of buckets) {
      const r = b?.[round];
      if (!r) continue;
      any = true;
      const k = keyOf(r.image_url);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push({ ...r, index: merged.length + 1 });
      if (merged.length >= limit) break;
    }
    if (!any) break;
  }
  lastResults = merged;
  lastKey = searchKey(opts);
  return { results: merged, errors, queries };
}

/** Thumbnails for the contact sheet, best effort and in parallel. */
export async function fetchThumbnails(results: RefResult[]): Promise<(DownloadedImage | null)[]> {
  return Promise.all(
    results.map(async (r) => {
      try {
        return await downloadImage(r.thumbnail_url, r.page_url, 10000);
      } catch {
        return null;
      }
    })
  );
}

/** Full image for a result, falling back to its thumbnail if the original is gone. */
export async function downloadResult(r: RefResult): Promise<DownloadedImage & { used_thumbnail: boolean }> {
  try {
    return { ...(await downloadImage(r.image_url, r.page_url)), used_thumbnail: false };
  } catch {
    return { ...(await downloadImage(r.thumbnail_url, r.page_url)), used_thumbnail: true };
  }
}
