import crypto from "node:crypto";
import C from "./catalog.js";
import cdek from "../lib/cdek.js";
import { loadState, stockOf, store } from "../lib/shop.mjs";

const j = (status, body) => Response.json(body, { status });
const env = (k) => Netlify.env.get(k);

export default async (req) => {
  if (req.method !== "POST") return j(405, { error: "Method" });
  let b;
  try { b = await req.json(); } catch { return j(400, { error: "Bad JSON" }); }
  const { items, contact: c = {}, delivery: d = {} } = b;
  if (!Array.isArray(items) || !items.length || items.length > 30) return j(400, { error: "Пустая корзина" });
  const name = String(c.name || "").trim().slice(0, 100), phone = String(c.phone || "").replace(/[^\d+]/g, ""), email = String(c.email || "").trim().slice(0, 120);
  if (!name || phone.replace(/\D/g, "").length < 10 || !/^\S+@\S+\.\S+$/.test(email)) return j(400, { error: "Проверьте контактные данные" });
  const door = d.type === "cdek_door";
  if (!d.city_code || !["cdek_pvz", "cdek_door"].includes(d.type) || (door ? String(d.address || "").length < 5 : !d.pvz)) return j(400, { error: "Проверьте данные доставки" });

  const st = await loadState();
  const prod = (id) => {
    if (C[id]) return C[id];
    const x = st.products[id];
    return x && !x.hidden ? { n: x.name, p: x.price, s: x.sizes } : null;
  };
  let sum = 0, n = 0;
  const lines = [];
  for (const i of items) {
    const p = prod(i.id), q = Math.floor(Number(i.q));
    if (!p || !p.s.includes(i.size) || !(q > 0 && q <= 10)) return j(400, { error: "Некорректный товар в корзине" });
    const s = stockOf(st, i.id);
    if (s.out || s.sizesOut.includes(i.size)) return j(409, { error: `«${p.n}», ${i.size} — нет в наличии` });
    sum += p.p * q; n += q;
    lines.push({ name: `${p.n}, ${i.size}`.slice(0, 128), price: p.p, q, kind: "commodity" });
  }
  let t;
  try { t = await cdek.tariff(d.city_code, door, n); } catch { return j(502, { error: "Не удалось рассчитать доставку" }); }
  if (t.cost == null) return j(400, { error: "Доставка в этот город недоступна" });
  lines.push({ name: "Доставка СДЭК", price: t.cost, q: 1, kind: "service" });

  const total = sum + t.cost, orderId = "GN-" + Date.now().toString(36).toUpperCase();
  const meta = { order_id: orderId, name, phone, email, delivery: d.type, city: String(d.city || "").slice(0, 100), pvz: String(d.pvz || "").slice(0, 50), address: String(d.address || "").slice(0, 200), subscribe: b.subscribe ? "yes" : "no" };
  const ok = env("SITE_URL") + "/#/order-ok";
  const saveOrder = (extra) => store("orders").setJSON(orderId, { ...meta, items: lines, total, created: new Date().toISOString(), ...extra }).catch((e) => console.error("saveOrder", e.message));

  if (env("PAYMENT_PROVIDER") === "tochka") {
    const r = await fetch((env("TOCHKA_API_URL") || "https://enter.tochka.com/uapi") + "/acquiring/v1.0/payments_with_receipt", {
      method: "POST",
      headers: { Authorization: "Bearer " + env("TOCHKA_JWT"), "Content-Type": "application/json" },
      body: JSON.stringify({ Data: {
        customerCode: env("TOCHKA_CUSTOMER_CODE"), ...(env("TOCHKA_MERCHANT_ID") ? { merchantId: env("TOCHKA_MERCHANT_ID") } : {}),
        amount: total.toFixed(2), purpose: `Заказ ${orderId}`, paymentMode: ["sbp", "card"], paymentLinkId: orderId,
        redirectUrl: ok, failRedirectUrl: env("SITE_URL") + "/#/checkout", taxSystemCode: env("TOCHKA_TAX_SYSTEM") || "usn_income",
        Client: { name, email, phone },
        Items: lines.map((l) => ({ vatType: "none", name: l.name, amount: l.price.toFixed(2), quantity: l.q, paymentMethod: "full_payment", paymentObject: l.kind === "service" ? "service" : "goods", measure: "шт." })),
      } }),
    });
    const p = await r.json().catch(() => ({}));
    const link = p.Data?.paymentLink;
    if (!link) { console.error("tochka", r.status, JSON.stringify(p.Errors || p.message || "").slice(0, 300)); return j(502, { error: "Платёжный сервис отклонил запрос" }); }
    await saveOrder({ provider: "tochka", operationId: p.Data.operationId });
    return j(200, { order_id: orderId, total, confirmation_url: link });
  }

  const auth = Buffer.from(env("YOOKASSA_SHOP_ID") + ":" + env("YOOKASSA_SECRET_KEY")).toString("base64");
  const r = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: { Authorization: "Basic " + auth, "Idempotence-Key": crypto.randomUUID(), "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: { value: total.toFixed(2), currency: "RUB" }, capture: true, confirmation: { type: "redirect", return_url: ok }, description: "Заказ " + orderId,
      receipt: { customer: { full_name: name, phone, email }, items: lines.map((l) => ({ description: l.name, quantity: String(l.q), amount: { value: l.price.toFixed(2), currency: "RUB" }, vat_code: 1, payment_mode: "full_payment", payment_subject: l.kind })) },
      metadata: meta,
    }),
  });
  const p = await r.json();
  if (!p.confirmation?.confirmation_url) return j(502, { error: "Платёжный сервис отклонил запрос" });
  await saveOrder({ provider: "yookassa", paymentId: p.id });
  return j(200, { order_id: orderId, total, confirmation_url: p.confirmation.confirmation_url });
};
