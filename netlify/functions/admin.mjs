import crypto from "node:crypto";
import catalog from "./catalog.js";
import { loadState, saveState, syncInstagram, addLog, store } from "../lib/shop.mjs";

const CATS = ["platya", "yubki", "kostyumy", "kardigany", "svitery"];
const str = (v, n) => String(v ?? "").trim().slice(0, n);

// Вход: пароль администратора или пароль управляющей (вкладка «Товары и наличие» на /manager)
function same(got, want, min) {
  return want.length >= min && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function authorized(req) {
  const got = req.headers.get("x-admin-key") || "";
  return same(got, Netlify.env.get("ADMIN_PASSWORD") || "", 10) || same(got, Netlify.env.get("MANAGER_PASSWORD") || "", 8);
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "Method" }, { status: 405 });
  if (!authorized(req)) {
    await new Promise((r) => setTimeout(r, 800));
    return Response.json({ error: "Неверный пароль" }, { status: 401 });
  }
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }
  if (b.action === "orders") {
    const s = store("orders");
    const { blobs } = await s.list();
    const keys = blobs.map((x) => x.key).sort().reverse().slice(0, 50);
    const orders = (await Promise.all(keys.map((k) => s.get(k, { type: "json" })))).filter(Boolean);
    orders.sort((a, z) => String(z.created).localeCompare(String(a.created)));
    return Response.json({ orders });
  }
  const state = await loadState();
  const staticIds = new Set(Object.keys(catalog));

  if (b.action === "upload") {
    const buf = Buffer.from(String(b.data || ""), "base64");
    if (!buf.length || buf.length > 4e6 || buf[0] !== 0xff || buf[1] !== 0xd8) return Response.json({ error: "Нужен JPEG до 4 МБ" }, { status: 400 });
    const key = "m-" + crypto.randomUUID().slice(0, 12);
    await store("shop-img").set(key, buf, { metadata: { type: "image/jpeg" } });
    return Response.json({ url: `/api/ig-img?k=${key}` });
  }

  if (b.action === "stock") {
    const id = str(b.id, 120);
    if (!staticIds.has(id) && !state.products[id]) return Response.json({ error: "Нет такого товара" }, { status: 400 });
    if (b.reset) delete state.manual[id];
    else state.manual[id] = { out: !!b.out, sizesOut: Array.isArray(b.sizesOut) ? b.sizesOut.map((s) => str(s, 20)).slice(0, 20) : [], at: new Date().toISOString() };
    addLog(state, `Наличие изменено вручную: ${id}`);
  } else if (b.action === "product") {
    const id = b.id ? str(b.id, 120) : "m-" + Date.now().toString(36);
    if (staticIds.has(id)) return Response.json({ error: "Этот товар редактируется в коде сайта" }, { status: 400 });
    const price = Math.round(Number(b.price));
    const name = str(b.name, 90);
    const imgs = (Array.isArray(b.imgs) ? b.imgs : []).filter((u) => /^\/api\/ig-img\?k=[\w-]+$/.test(u)).slice(0, 8);
    if (!name || !(price > 0 && price < 1e6) || !imgs.length) return Response.json({ error: "Нужны название, цена и хотя бы одно фото" }, { status: 400 });
    const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map((s) => str(s, 20)).filter(Boolean).slice(0, 10);
    state.products[id] = {
      ...(state.products[id] || {}), id, name, price, imgs,
      cats: (Array.isArray(b.cats) ? b.cats : []).filter((c) => CATS.includes(c)),
      sizes: sizes.length ? sizes : ["единый размер"],
      desc: str(b.desc, 300) || name + ".", isNew: !!b.isNew,
      source: state.products[id]?.source || "manual", hidden: false, ts: state.products[id]?.ts || new Date().toISOString(),
    };
    addLog(state, `Товар сохранён: ${name}`);
  } else if (b.action === "hide") {
    const p = state.products[str(b.id, 120)];
    if (!p) return Response.json({ error: "Нет такого товара" }, { status: 400 });
    p.hidden = !!b.hidden;
    addLog(state, `${p.hidden ? "Скрыт" : "Показан"} товар: ${p.name}`);
  } else if (b.action === "sync") {
    try { addLog(state, "Ручная синхронизация: " + JSON.stringify(await syncInstagram(state, staticIds, 20000))); }
    catch (err) { addLog(state, "Ошибка синхронизации: " + err.message); }
  } else if (b.action !== "state") {
    return Response.json({ error: "Неизвестное действие" }, { status: 400 });
  }
  if (b.action !== "state") await saveState(state);

  return Response.json({
    static: Object.entries(catalog).map(([id, v]) => ({ id, name: v.n, price: v.p, sizes: v.s })),
    products: Object.values(state.products), manual: state.manual, ig: state.ig,
    lastSync: state.lastSync, log: state.log.slice().reverse(),
    igConfigured: !!(state.token?.value || Netlify.env.get("IG_ACCESS_TOKEN")),
  });
};
