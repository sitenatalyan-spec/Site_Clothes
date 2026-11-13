// Отправления СДЭК: заказ создаётся в СДЭК сам после оплаты, номер СДЭК подтягиваем, когда СДЭК его присвоит.
import cdek from "./cdek.js";
import { store } from "./shop.mjs";

const env = (k) => process.env[k];
export const cdekOn = () => !!(env("CDEK_CLIENT_ID") && env("CDEK_CLIENT_SECRET"));
const auto = () => cdekOn() && env("CDEK_AUTO") !== "0";

// Создать отправление. Повторно не создаём: если уже есть uuid — ничего не делаем.
export async function registerCdek(o, s = store("orders")) {
  if (o.cdek?.uuid && !o.cdek.cancelled) return o;
  const at = new Date().toISOString();
  try {
    const uuid = await cdek.createOrder(o);
    o.cdek = { uuid, at };
    console.log("cdek order", o.order_id, uuid);
  } catch (e) {
    o.cdek = { error: String(e.message || e).slice(0, 500), at };
    console.error("cdek order", o.order_id, o.cdek.error);
  }
  await s.setJSON(o.order_id, o);
  return o;
}

// Узнать номер СДЭК (появляется через несколько секунд после создания) или ошибку проверки.
export async function refreshCdek(o, s = store("orders")) {
  if (!o.cdek?.uuid || o.cdek.number || o.cdek.cancelled) return o;
  const info = await cdek.orderInfo(o.cdek.uuid);
  if (!info.number && !info.error) return o;
  if (info.error) o.cdek.error = info.error;
  if (info.number) {
    o.cdek.number = String(info.number);
    delete o.cdek.error;
    // трек СДЭК сразу виден управляющей и покупателю
    o.ship = { ...(o.ship || { status: "new" }), track: o.ship?.track || o.cdek.number };
  }
  await s.setJSON(o.order_id, o);
  return o;
}

// Раз в 2 минуты (из server.mjs): оплаченные заказы за 2 недели без отправления — создать, без номера — уточнить.
export async function checkShipments() {
  if (!auto()) return;
  const s = store("orders");
  const { blobs } = await s.list();
  const since = Date.now() - 14 * 864e5;
  for (const { key } of blobs) {
    const o = await s.get(key, { type: "json" }).catch(() => null);
    if (!o || o.status !== "paid" || new Date(o.paidAt || o.created).getTime() < since) continue;
    if (["cancelled", "shipped", "delivered"].includes(o.ship?.status)) continue;
    try {
      if (!o.cdek) { if (!o.ship?.track) await registerCdek(o, s); }
      else if (o.cdek.uuid && !o.cdek.number && !o.cdek.cancelled) await refreshCdek(o, s);
    } catch (e) { console.error("cdek check", key, e.message); }
  }
}
