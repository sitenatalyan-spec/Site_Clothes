import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN = path.join(ROOT, "netlify/functions");
const PORT = Number(process.env.PORT || 8080);
process.env.STORE_DIR ||= path.join(ROOT, "data");
globalThis.Netlify = { env: { get: (k) => process.env[k] }, context: { deploy: { context: "production" } } };
const require = createRequire(import.meta.url);

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml" };
const PUBLIC_FILES = new Set(["index.html", "admin.html", "cities.json", "robots.txt", "sitemap.xml", "favicon.ico"]);
const PUBLIC_DIRS = ["photos/", "fonts/"];
const FUNCTIONS = new Set(["admin", "auth", "cdek", "create-order", "ig-img", "shop"]);

const mods = new Map();
async function loadFn(name) {
  if (mods.has(name)) return mods.get(name);
  const mjs = path.join(FN, name + ".mjs"), cjs = path.join(FN, name + ".js");
  const m = fs.existsSync(mjs) ? { v2: (await import(pathToFileURL(mjs).href)).default } : { v1: require(cjs).handler };
  mods.set(name, m);
  return m;
}

function readBody(req, limit = 6e6) {
  return new Promise((ok, fail) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { fail(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

async function runFunction(name, req, res, url) {
  const fn = await loadFn(name);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  if (fn.v2) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await fn.v2(new Request(url, { method: req.method, headers, body }), {});
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const r = await fn.v1({
    httpMethod: req.method, path: url.pathname, headers: req.headers,
    queryStringParameters: Object.fromEntries(url.searchParams), body: body ? body.toString("utf8") : null, isBase64Encoded: false,
  });
  res.writeHead(r.statusCode || 200, r.headers || {});
  res.end(r.isBase64Encoded ? Buffer.from(r.body || "", "base64") : r.body || "");
}

function serveStatic(rel, req, res, head) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const html = ext === ".html";
  // Повторные визиты: браузер спрашивает «изменилось ли?» и получает короткий ответ 304 без файла.
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const cache = html ? "no-cache" : ext === ".json" ? "public, max-age=3600" : "public, max-age=2592000";
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": cache }).end(); return true; }
  res.writeHead(200, {
    "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Length": st.size, ETag: etag,
    "Last-Modified": st.mtime.toUTCString(), "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff", ...(html ? { "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN" } : {}),
    ...(rel === "admin.html" ? { "X-Robots-Tag": "noindex" } : {}),
  });
  if (head) res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  try {
    const m = url.pathname.match(/^\/(?:api|\.netlify\/functions)\/([\w-]+)$/);
    if (m) {
      if (!FUNCTIONS.has(m[1])) { res.writeHead(404).end("Not found"); return; }
      await runFunction(m[1], req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    if ((PUBLIC_FILES.has(rel) || PUBLIC_DIRS.some((d) => rel.startsWith(d))) && !rel.includes("..") && serveStatic(rel, req, res, req.method === "HEAD")) return;
    res.writeHead(302, { Location: "/" }).end();
  } catch (err) {
    console.error(req.method, url.pathname, err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ошибка сервера" }));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`gluhova site on 127.0.0.1:${PORT}, data in ${process.env.STORE_DIR}`));

async function igSync() {
  if (!process.env.IG_ACCESS_TOKEN) return;
  try { await (await import(pathToFileURL(path.join(FN, "ig-sync.mjs")).href)).default(); }
  catch (err) { console.error("ig-sync", err.message); }
}
setTimeout(igSync, 30e3);
setInterval(igSync, 15 * 60e3);
