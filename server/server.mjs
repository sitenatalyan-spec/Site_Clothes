import http from "node:http";
import zlib from "node:zlib";
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

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".js": "text/javascript; charset=utf-8", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const PUBLIC_FILES = new Set(["index.html", "admin.html", "manager.html", "cities.json", "robots.txt", "sitemap.xml", "favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "og.jpg", "site.webmanifest"]);
const PUBLIC_DIRS = ["photos/", "fonts/", "js/"];
const FUNCTIONS = new Set(["admin", "auth", "cdek", "create-order", "ig-img", "order-status", "shop", "manager"]);

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

const gzCache = new Map();
function serveStatic(rel, req, res, head) {
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const html = ext === ".html";
  // Текстовые файлы отдаём сжатыми (кэш в памяти до изменения файла)
  const gz = [".html", ".js", ".json", ".svg", ".txt", ".xml"].includes(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  let body = null;
  if (gz) {
    const c = gzCache.get(file);
    body = c && c.mtime === st.mtimeMs ? c.data : zlib.gzipSync(fs.readFileSync(file), { level: 9 });
    gzCache.set(file, { mtime: st.mtimeMs, data: body });
  }
  // Повторные визиты: браузер спрашивает «изменилось ли?» и получает короткий ответ 304 без файла.
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const cache = html ? "no-cache" : ext === ".json" ? "public, max-age=3600" : "public, max-age=2592000";
  if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": cache }).end(); return true; }
  res.writeHead(200, {
    "Content-Type": TYPES[ext] || "application/octet-stream", "Content-Length": body ? body.length : st.size, ...(gz ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}), ETag: etag,
    "Last-Modified": st.mtime.toUTCString(), "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff", ...(html ? { "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN" } : {}),
    ...(rel === "admin.html" || rel === "manager.html" ? { "X-Robots-Tag": "noindex" } : {}),
  });
  if (head) res.end(); else if (body) res.end(body); else fs.createReadStream(file).pipe(res);
  return true;
}

// Страницы магазина с настоящими адресами (/p/kardigan, /c/platya, /delivery…): отдаём index.html,
// подставив свой заголовок, описание и картинку — чтобы поисковики и мессенджеры видели каждую страницу отдельно.
const SITE = () => process.env.SITE_URL || "https://gluhovanatalia.ru";
const INFO = { about: "О бренде", delivery: "Доставка и оплата", care: "Уход за изделиями", refund: "Возврат и обмен", offer: "Публичная оферта", privacy: "Политика конфиденциальности", contacts: "Контакты", fav: "Избранное", account: "Личный кабинет", checkout: "Оформление заказа", "order-ok": "Спасибо за заказ" };
let catalogCache = null;
function catalog() {
  const file = path.join(ROOT, "index.html"), st = fs.statSync(file);
  if (catalogCache && catalogCache.mtime === st.mtimeMs) return catalogCache;
  const html = fs.readFileSync(file, "utf8"), products = {}, cats = {};
  for (const line of html.split("\n")) {
    if (/^\["[\w-]+",".*\]\],?$/.test(line)) { try { const a = JSON.parse(line.replace(/,$/, "")); products[a[0]] = { name: a[1], price: a[2], desc: a[6], img: a[7]?.[0] }; } catch {} }
  }
  const cm = html.match(/const CATS=(\[.*?\]\]);/);
  if (cm) for (const [id, name] of JSON.parse(cm[1])) cats[id] = name;
  catalogCache = { mtime: st.mtimeMs, html, products, cats };
  return catalogCache;
}
const escA = (x) => String(x).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
let shopCache = null;
function shopProduct(id) {
  try {
    const f = path.join(process.env.STORE_DIR, "shop", "state"), m = fs.statSync(f).mtimeMs;
    if (!shopCache || shopCache.m !== m) shopCache = { m, s: JSON.parse(fs.readFileSync(f, "utf8")) };
    const p = shopCache.s.products?.[id];
    return p && !p.hidden && p.imgs?.length ? p : null;
  } catch { return null; }
}
function appPage(rel) {
  const c = catalog(), m = rel.match(/^(c|p)\/([\w-]+)$/);
  const brand = "Gluhova Natalya";
  if (m && m[1] === "p") {
    const p = c.products[m[2]];
    if (!p) {
      // Товар, добавленный на странице управления или из Instagram
      const d = shopProduct(m[2]);
      if (!d) return null;
      const price = Number(d.price || 0).toLocaleString("ru-RU");
      return { title: `${d.name} — ${price} ₽ · ${brand}`, desc: `${String(d.desc || d.name).slice(0, 200)} Цена ${price} ₽. Женский трикотаж ручной работы из Екатеринбурга, доставка СДЭК по России.`, img: d.imgs?.[0] ? SITE() + d.imgs[0] : null, path: "/" + rel };
    }
    const img = p.img ? SITE() + "/" + p.img.replace(/^photos\/(.+)\.jpg$/, "photos/w/$1.webp") : null;
    return { title: `${p.name} — ${p.price.toLocaleString("ru-RU")} ₽ · ${brand}`, desc: `${p.desc} Цена ${p.price.toLocaleString("ru-RU")} ₽. Женский трикотаж ручной работы из Екатеринбурга, доставка СДЭК по России.`, img, path: "/" + rel };
  }
  if (m && m[1] === "c") {
    const name = m[2] === "all" ? "Вся коллекция" : c.cats[m[2]];
    if (!name) return null;
    return { title: `${name} — женский трикотаж · ${brand}`, desc: `${name}: женский трикотаж ручной работы Gluhova Natalya из Екатеринбурга. Шерсть, вискоза, хлопок. Доставка СДЭК по всей России.`, path: "/" + rel };
  }
  if (INFO[rel]) return { title: `${INFO[rel]} · ${brand}`, path: "/" + rel, noindex: ["fav", "account", "checkout", "order-ok"].includes(rel) };
  return null;
}
function servePage(meta, req, res, status = 200) {
  let html = catalog().html;
  const set = (re, val) => { html = html.replace(re, val); };
  if (meta.title) { set(/<title>.*?<\/title>/, `<title>${escA(meta.title)}</title>`); set(/(<meta property="og:title" content=")[^"]*/, `$1${escA(meta.title)}`); }
  if (meta.desc) { set(/(<meta name="description" content=")[^"]*/, `$1${escA(meta.desc)}`); set(/(<meta property="og:description" content=")[^"]*/, `$1${escA(meta.desc)}`); }
  set(/(<link rel="canonical" href=")[^"]*/, `$1${SITE()}${meta.path}`); set(/(<meta property="og:url" content=")[^"]*/, `$1${SITE()}${meta.path}`);
  if (meta.img) set(/(<meta property="og:image" content=")[^"]*/, `$1${escA(meta.img)}`);
  if (meta.noindex) set("<head>", '<head><meta name="robots" content="noindex">');
  const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || ""), body = gz ? zlib.gzipSync(html) : Buffer.from(html);
  res.writeHead(status, { "Content-Type": TYPES[".html"], "Content-Length": body.length, ...(gz ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}), "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN" });
  res.end(req.method === "HEAD" ? undefined : body);
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
    if (rel === "manager" || rel === "admin") rel += ".html";
    if ((PUBLIC_FILES.has(rel) || PUBLIC_DIRS.some((d) => rel.startsWith(d))) && !rel.includes("..") && serveStatic(rel, req, res, req.method === "HEAD")) return;
    const page = appPage(rel.replace(/\/+$/, ""));
    if (page) { servePage(page, req, res); return; }
    // Несуществующий товар или раздел: страница «не найдено» с кодом 404, чтобы поисковики её не индексировали
    if (/^(c|p)\/[\w-]+$/.test(rel)) { servePage({ title: "Страница не найдена · Gluhova Natalya", path: "/" + rel, noindex: true }, req, res, 404); return; }
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

// Проверка оплаты заказов (Точка, Яндекс Сплит) каждые 2 минуты
async function payCheck() {
  try { await (await import(pathToFileURL(path.join(ROOT, "netlify/lib/payments.mjs")).href)).checkPayments(); }
  catch (err) { console.error("payments", err.message); }
  // оплаченные заказы сами уходят в СДЭК
  try { await (await import(pathToFileURL(path.join(ROOT, "netlify/lib/shipping.mjs")).href)).checkShipments(); }
  catch (err) { console.error("cdek", err.message); }
}
setTimeout(payCheck, 20e3);
setInterval(payCheck, 2 * 60e3);
