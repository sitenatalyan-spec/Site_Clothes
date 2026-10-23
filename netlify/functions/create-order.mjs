import fs from "node:fs";
import https from "node:https";
import tls from "node:tls";
import C from "./catalog.js";
import cdek from "../lib/cdek.js";
import { loadState, stockOf, store } from "../lib/shop.mjs";
import { userFromRequest, addOrderToUser, saveUser } from "../lib/auth.mjs";

const j = (status, body) => Response.json(body, { status });
const env = (k) => Netlify.env.get(k);

// Оплата — только через Точку Банк: СБП и банковские карты. Кнопка появляется, когда на сервере вписаны ключи Точки.
const hasTochka = () => !!(env("TOCHKA_JWT") && env("TOCHKA_CUSTOMER_CODE"));
const methods = () => ({ tochka: hasTochka() });

// Точка работает на сертификате Минцифры (Russian Trusted Root CA), которого нет в стандартном списке доверенных.
// Доверяем ему только в запросах к Точке: файл сертификата — TOCHKA_CA_FILE (по умолчанию /etc/ssl/certs/russian_trusted_root_ca.pem).
function postJSON(url, headers, body) {
  const caFile = env("TOCHKA_CA_FILE") || "/etc/ssl/certs/russian_trusted_root_ca.pem";
  let ca = null;
  try { ca = [...tls.rootCertificates, fs.readFileSync(caFile, "utf8")]; } catch {}
  if (!ca) return fetch(url, { method: "POST", headers, body });
  return new Promise((resolve, reject) => {
    const rq = https.request(url, { method: "POST", headers, ca, timeout: 20000 }, (rs) => {
      let d = ""; rs.setEncoding("utf8"); rs.on("data", (c) => (d += c));
      rs.on("end", () => resolve({ status: rs.statusCode, json: async () => JSON.parse(d) }));
    });
    rq.on("timeout", () => rq.destroy(new Error("timeout"))); rq.on("error", reject); rq.end(body);
  });
}

export default async (req) => {
  if (req.method === "GET") return j(200, methods());
  if (req.method !== "POST") return j(405, { error: "Method" });
  let b;
  try { b = await req.json(); } catch { return j(400, { error: "Bad JSON" }); }
  const { items, contact: c = {}, delivery: d = {} } = b;
  if (!Array.isArray(items) || !items.length || items.length > 30) return j(400, { error: "Пустая корзина" });
  const name = String(c.name || "").trim().slice(0, 100), phone = String(c.phone || "").replace(/[^\d+]/g, ""), email = String(c.email || "").trim().slice(0, 120);
  if (!name || phone.replace(/\D/g, "").length < 10 || !/^\S+@\S+\.\S+$/.test(email)) return j(400, { error: "Проверьте контактные данные" });

  const pay = b.pay === "tochka" && hasTochka() ? "tochka" : null;
  if (!pay) return j(400, { error: "Этот способ оплаты пока не подключён — выберите другой" });

  const tf = cdek.TARIFFS[Number(d.tariff)];
  const door = tf && tf.mode === 3;
  if (!d.city_code || !tf || (door ? String(d.address || "").length < 5 : !d.pvz)) return j(400, { error: "Проверьте данные доставки" });

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
    lines.push({ id: String(i.id), name: `${p.n}, ${i.size}`.slice(0, 128), price: p.p, q, kind: "commodity" });
  }
  // Цену доставки всегда пересчитываем на сервере по выбранному тарифу, а не берём из браузера.
  let t;
  try { t = (await cdek.tariffs(d.city_code, n, sum)).find((x) => x.code === Number(d.tariff)); } catch { return j(502, { error: "Не удалось рассчитать доставку" }); }
  if (!t) return j(400, { error: "Этот тариф СДЭК недоступен для вашего города — выберите другой" });
  lines.push({ id: "delivery", name: `Доставка СДЭК: ${t.name}`.slice(0, 128), price: t.cost, q: 1, kind: "service" });

  const total = sum + t.cost, orderId = "GN-" + Date.now().toString(36).toUpperCase();
  const user = await userFromRequest(req).catch(() => null);
  const meta = { order_id: orderId, ...(user ? { user: user.id } : {}), name, phone, email, delivery: door ? "cdek_door" : tf.mode === 7 ? "cdek_postamat" : "cdek_pvz", tariff: t.code, tariff_name: t.name, city: String(d.city || "").slice(0, 100), pvz: String(d.pvz || "").slice(0, 50), address: String(d.address || "").slice(0, 200), subscribe: b.subscribe ? "yes" : "no" };
  const ok = env("SITE_URL") + "/order-ok?o=" + orderId, back = env("SITE_URL") + "/checkout";
  const saveOrder = async (extra) => {
    try {
      await store("orders").setJSON(orderId, { ...meta, items: lines, total, created: new Date().toISOString(), ...extra });
      if (user) {
        await addOrderToUser(user.id, orderId);
        // Запоминаем имя и e-mail, чтобы в следующий раз подставить их автоматически.
        if (!user.name || !user.email) { user.name ||= name; user.email ||= email; await saveUser(user); }
      }
    } catch (e) { console.error("saveOrder", e.message); }
  };
  const fail = (who, status, detail) => { console.error(who, status, JSON.stringify(detail || "").slice(0, 400)); return j(502, { error: "Платёжный сервис отклонил запрос. Попробуйте другой способ оплаты или позвоните нам: +7 (960) 304-79-77" }); };
  const money = (x) => x.toFixed(2);

  // Точка Банк: платёжная ссылка с чеком по 54-ФЗ, покупатель выбирает СБП или карту.
  if (pay === "tochka") {
    const r = await postJSON((env("TOCHKA_API_URL") || "https://enter.tochka.com/uapi") + "/acquiring/v1.0/payments_with_receipt",
      { Authorization: "Bearer " + env("TOCHKA_JWT"), "Content-Type": "application/json" },
      JSON.stringify({ Data: {
        customerCode: env("TOCHKA_CUSTOMER_CODE"), ...(env("TOCHKA_MERCHANT_ID") ? { merchantId: env("TOCHKA_MERCHANT_ID") } : {}),
        amount: money(total), purpose: `Заказ ${orderId}`, paymentMode: ["sbp", "card"], paymentLinkId: orderId,
        redirectUrl: ok, failRedirectUrl: back, taxSystemCode: env("TOCHKA_TAX_SYSTEM") || "usn_income",
        Client: { name, email, phone },
        Items: lines.map((l) => ({ vatType: "none", name: l.name, amount: money(l.price), quantity: l.q, paymentMethod: "full_payment", paymentObject: l.kind === "service" ? "service" : "goods", measure: "шт." })),
      } }),
    ).catch((e) => ({ status: 0, json: async () => ({ message: e.message }) }));
    const p = await r.json().catch(() => ({}));
    const link = p.Data?.paymentLink;
    if (!link) return fail("tochka", r.status, p.Errors || p.message);
    await saveOrder({ provider: "tochka", operationId: p.Data.operationId });
    return j(200, { order_id: orderId, total, confirmation_url: link });
  }

  return j(400, { error: "Этот способ оплаты не подключён" });
};
