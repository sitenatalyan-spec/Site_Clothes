// Статус оплаты заказов (Точка и Яндекс Сплит): сайт сам спрашивает платёжный сервис и отмечает заказ оплаченным.
import fs from "node:fs";
import https from "node:https";
import tls from "node:tls";
import { store } from "./shop.mjs";

const env = (k) => process.env[k];
const API = () => env("TOCHKA_API_URL") || "https://enter.tochka.com/uapi";

// Точка подписана сертификатом Минцифры — доверяем ему только в запросах к Точке.
function getJSON(url) {
  let ca = null;
  try { ca = [...tls.rootCertificates, fs.readFileSync(env("TOCHKA_CA_FILE") || "/etc/ssl/certs/russian_trusted_root_ca.pem", "utf8")]; } catch {}
  return new Promise((resolve, reject) => {
    const rq = https.get(url, { headers: { Authorization: "Bearer " + env("TOCHKA_JWT") }, ...(ca ? { ca } : {}), timeout: 20000 }, (rs) => {
      let d = ""; rs.setEncoding("utf8"); rs.on("data", (c) => (d += c));
      rs.on("end", () => { try { resolve({ status: rs.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: rs.statusCode, body: {} }); } });
    });
    rq.on("timeout", () => rq.destroy(new Error("timeout"))); rq.on("error", reject);
  });
}

// Статусы Точки: CREATED — ссылка создана, APPROVED / AUTHORIZED — оплачено, EXPIRED — ссылка истекла, REFUNDED… — возврат.
const MAP = { APPROVED: "paid", AUTHORIZED: "paid", EXPIRED: "expired", REFUNDED: "refunded", REFUNDED_PARTIALLY: "refunded", "ON-REFUND": "refunded" };
const FINAL = new Set(["paid", "expired", "refunded"]);

// Статусы Яндекс Пэй: AUTHORIZED / CAPTURED / CONFIRMED — оплачено (в Сплите — внесён первый платёж), FAILED / VOIDED — не оплачено.
const YMAP = { AUTHORIZED: "paid", CAPTURED: "paid", CONFIRMED: "paid", FAILED: "expired", VOIDED: "expired", REFUNDED: "refunded", PARTIALLY_REFUNDED: "refunded" };

async function bankStatus(o) {
  if (o.provider === "tochka" && o.operationId) {
    const r = await getJSON(`${API()}/acquiring/v1.0/payments/${encodeURIComponent(o.operationId)}`);
    const op = r.body?.Data?.Operation?.[0];
    return op ? [MAP[op.status] || "pending", op.status] : null;
  }
  if (o.provider === "yandexpay" && env("YANDEX_PAY_API_KEY")) {
    const r = await fetch(`${env("YANDEX_PAY_API_URL") || "https://pay.yandex.ru"}/api/merchant/v1/orders/${encodeURIComponent(o.order_id)}`, { headers: { Authorization: "Api-Key " + env("YANDEX_PAY_API_KEY") }, signal: AbortSignal.timeout(20000) });
    const ps = (await r.json().catch(() => ({})))?.data?.order?.paymentStatus;
    return ps ? [YMAP[ps] || "pending", ps] : null;
  }
  return null;
}

export async function refreshOrder(o, s = store("orders")) {
  if (FINAL.has(o.status)) return o;
  const b = await bankStatus(o);
  if (!b) return o;
  const [st, raw] = b;
  if (st !== (o.status || "pending")) {
    o.status = st; o.bankStatus = raw;
    if (st === "paid") o.paidAt = new Date().toISOString();
    await s.setJSON(o.order_id, o);
    console.log("payment", o.order_id, raw);
  }
  return o;
}

// Проверяем неоплаченные заказы за последние 3 дня (ссылка Точки живёт меньше).
export async function checkPayments() {
  if (!env("TOCHKA_JWT") && !env("YANDEX_PAY_API_KEY")) return;
  const s = store("orders");
  const { blobs } = await s.list();
  const since = Date.now() - 3 * 864e5;
  for (const { key } of blobs) {
    const o = await s.get(key, { type: "json" }).catch(() => null);
    if (!o || FINAL.has(o.status) || !["tochka", "yandexpay"].includes(o.provider) || new Date(o.created).getTime() < since) continue;
    try { await refreshOrder(o, s); } catch (e) { console.error("payment check", key, e.message); }
  }
}
