import { getStore, getDeployStore } from "@netlify/blobs";
import { fsStore } from "./fsstore.mjs";
import crypto from "node:crypto";

const IG = "https://graph.instagram.com";
const CATS = [
  ["platya", /плать|сарафан/i],
  ["kostyumy", /костюм|комплект/i],
  ["kardigany", /кардиган/i],
  ["yubki", /юбк/i],
  ["svitery", /свитер|джемпер|кофт|лонгслив|жилет|топ/i],
];

const isProd = () => globalThis.Netlify?.context?.deploy?.context === "production";
export const store = (name) =>
  process.env.STORE_DIR ? fsStore(name)
    : isProd() ? getStore({ name, consistency: "strong" }) : getDeployStore({ name, consistency: "strong" });

export const emptyState = () => ({ products: {}, ig: {}, manual: {}, seen: {}, token: null, lastSync: null, log: [] });

export async function loadState() {
  return (await store("shop").get("state", { type: "json" })) || emptyState();
}

export async function saveState(state) {
  state.log = (state.log || []).slice(-40);
  await store("shop").setJSON("state", state);
}

export function addLog(state, text) {
  (state.log ||= []).push({ at: new Date().toISOString(), text });
}

export function stockOf(state, id) {
  const m = state.manual?.[id] || {};
  const i = state.ig?.[id] || {};
  return { out: m.out ?? i.out ?? false, sizesOut: m.sizesOut ?? i.sizesOut ?? [] };
}

export function publicState(state) {
  const products = Object.values(state.products || {}).filter((p) => !p.hidden);
  const ids = new Set([...Object.keys(state.ig || {}), ...Object.keys(state.manual || {}), ...products.map((p) => p.id)]);
  const stock = {};
  for (const id of ids) stock[id] = stockOf(state, id);
  return { products, stock, lastSync: state.lastSync };
}

const clean = (s) => s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "").replace(/\s+/g, " ").trim();
const splitSizes = (s) =>
  s.split(/[,;]|\s+и\s+/).map((x) => clean(x).replace(/\.$/, "")).filter((x) => x && x.length <= 20);

export function parseCaption(caption) {
  const text = String(caption || "");
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const pm = text.match(/(?:цена|стоимость)\s*[:\-–—]?\s*([\d\s ]{3,9})/i) || text.match(/([\d\s ]{3,9})\s*(?:₽|руб)/i);
  const price = pm ? parseInt(pm[1].replace(/\D/g, ""), 10) : null;
  const code = (text.match(/(?:код|артикул)\s*[:\-–—]\s*([a-z0-9-]+)/i) || [])[1] || null;
  const out = /нет\s+в\s+наличии|распродан|продано|sold\s*out|#нетвналичии/i.test(text);
  const sm = text.match(/(?:законч[а-яё]*|нет)\s+размер[а-яё]*\s*[:\-–—]\s*(.+)/i);
  const sizesOut = sm ? splitSizes(sm[1]) : [];
  const service = /^(название|цена|стоимость|размер|законч|нет\s+размер|код|артикул|раздел|#)/i;
  let sizes = [];
  const sz = lines.find((l) => /^размер(?:ы|ный ряд)?\s*[:\-–—]/i.test(l));
  if (sz) {
    const v = sz.replace(/^[^:\-–—]+[:\-–—]\s*/, "");
    sizes = /единый|один|free|one\s*size/i.test(v) ? ["единый размер"] : splitSizes(v);
  }
  if (!sizes.length) sizes = ["единый размер"];
  // Товаром на сайте становится только пост с хештегом #сайт и строкой «Название: …» — остальные посты сайт не трогает.
  const tagged = /#сайт(?![\p{L}\d_])/iu.test(text);
  const nl = lines.find((l) => /^название\s*[:\-–—]/i.test(l));
  const name = clean((nl ? nl.replace(/^[^:\-–—]+[:\-–—]\s*/, "") : lines.find((l) => !service.test(l) && !/^нет\s+в\s+наличии/i.test(l)) || "").replace(/#\S+/g, "")).slice(0, 90);
  const section = (lines.find((l) => /^раздел\s*[:\-–—]/i.test(l)) || "") + " " + name;
  const cats = CATS.filter(([, re]) => re.test(section)).map(([c]) => c).slice(0, 2);
  const desc = lines
    .filter((l) => !service.test(l) && clean(l) !== name && !/^нет\s+в\s+наличии/i.test(l))
    .map((l) => clean(l.replace(/#\S+/g, "")))
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
  return { isProduct: !!(tagged && nl && price && name), name, price, sizes, sizesOut, out, code, cats, desc, isNew: /новинк/i.test(text) };
}

async function igToken(state) {
  // Продлённый токен хранится в state; если в настройках сервера вписали новый токен — берём его, а старый забываем.
  const envT = Netlify.env.get("IG_ACCESS_TOKEN") || "";
  const envId = envT ? crypto.createHash("sha256").update(envT).digest("hex").slice(0, 16) : "";
  if (envT && state.token?.from !== envId) state.token = { value: envT, refreshedAt: null, from: envId };
  let t = state.token?.value || envT;
  if (!t) throw new Error("Не задан IG_ACCESS_TOKEN");
  const age = Date.now() - new Date(state.token?.refreshedAt || 0).getTime();
  if (age > 7 * 864e5) {
    const r = await fetch(`${IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t)}`);
    const d = await r.json().catch(() => ({}));
    if (d.access_token) {
      t = d.access_token;
      state.token = { value: t, refreshedAt: new Date().toISOString(), from: envId };
      addLog(state, "Токен Instagram продлён");
    }
  }
  return t;
}

async function saveImages(media, deadline) {
  const items = media.media_type === "CAROUSEL_ALBUM" ? media.children?.data || [] : [media];
  const imgs = [];
  for (const [i, it] of items.slice(0, 6).entries()) {
    if (Date.now() > deadline) break;
    const url = it.media_type === "VIDEO" ? it.thumbnail_url : it.media_url;
    if (!url) continue;
    const r = await fetch(url);
    if (!r.ok) continue;
    const key = `${media.id}-${i}`;
    await store("shop-img").set(key, await r.arrayBuffer(), { metadata: { type: r.headers.get("content-type") || "image/jpeg" } });
    imgs.push(`/api/ig-img?k=${key}`);
  }
  return imgs;
}

export async function syncInstagram(state, staticIds, budgetMs = 22000) {
  const deadline = Date.now() + budgetMs;
  const token = await igToken(state);
  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}";
  const r = await fetch(`${IG}/me/media?fields=${encodeURIComponent(fields)}&limit=50&access_token=${encodeURIComponent(token)}`);
  const d = await r.json();
  if (!r.ok || !Array.isArray(d.data)) throw new Error("Instagram: " + (d.error?.message || r.status));
  const nextIg = {};
  let added = 0, updated = 0;
  for (const m of d.data) {
    const c = parseCaption(m.caption);
    if (!c.isProduct && !c.code) continue;
    const existing = Object.values(state.products).find((p) => p.media === m.id);
    const id = c.code && (staticIds.has(c.code) || state.products[c.code]) ? c.code : existing?.id || `ig-${m.id}`;
    nextIg[id] = { out: c.out || (c.sizes.length > 0 && c.sizesOut.length >= c.sizes.length && c.sizes[0] !== "единый размер"), sizesOut: c.sizesOut };
    if (staticIds.has(id) || !c.isProduct) continue;
    const prev = state.products[id];
    const sig = `${c.name}|${c.price}|${c.sizes}|${c.cats}|${c.desc}`;
    if (prev && prev.sig === sig && prev.imgs?.length) continue;
    if (Date.now() > deadline) break;
    const imgs = prev?.imgs?.length ? prev.imgs : await saveImages(m, deadline);
    if (!imgs.length) continue;
    state.products[id] = {
      id, name: c.name, price: c.price, cats: c.cats, sizes: c.sizes, desc: c.desc || c.name + ".",
      isNew: c.isNew || Date.now() - new Date(m.timestamp).getTime() < 30 * 864e5,
      imgs, media: m.id, permalink: m.permalink, ts: m.timestamp, source: "instagram", sig, hidden: false,
    };
    prev ? updated++ : added++;
  }
  const fetched = new Set(d.data.map((m) => m.id));
  const oldest = d.data.length ? d.data[d.data.length - 1].timestamp : null;
  for (const p of Object.values(state.products)) {
    if (p.source === "instagram" && oldest && p.ts >= oldest && !fetched.has(p.media) && !p.hidden) {
      p.hidden = true;
      addLog(state, `Пост удалён из Instagram — товар «${p.name}» скрыт`);
    }
  }
  state.ig = nextIg;
  state.lastSync = new Date().toISOString();
  if (added || updated) addLog(state, `Instagram: новых товаров ${added}, обновлено ${updated}`);
  return { added, updated, posts: d.data.length };
}
