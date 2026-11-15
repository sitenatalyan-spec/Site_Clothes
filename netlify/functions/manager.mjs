// Страница управляющей: оплаченные заказы к отправке, статусы сборки и трек-номер СДЭК.
// Вход — пароль MANAGER_PASSWORD (или пароль администратора). Товары и наличие — вкладка на той же странице, через /api/admin.
import crypto from "node:crypto";
import { store } from "../lib/shop.mjs";
import cdek from "../lib/cdek.js";
import { registerCdek, refreshCdek, cdekOn } from "../lib/shipping.mjs";

const STEPS = ["new", "packed", "shipped", "delivered", "cancelled"];

function same(got, want) {
  return want.length >= 8 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function who(req) {
  const got = req.headers.get("x-manager-key") || "";
  if (same(got, Netlify.env.get("ADMIN_PASSWORD") || "")) return "Администратор";
  if (same(got, Netlify.env.get("MANAGER_PASSWORD") || "")) return "Управляющая";
  return null;
}

// Только то, что нужно для сборки и отправки
const view = (o) => ({
  id: o.order_id, created: o.created, paid: o.status || "pending", paidAt: o.paidAt, payMethod: o.payMethod || o.provider,
  name: o.name, phone: o.phone, email: o.email, delivery: o.delivery, tariff: o.tariff_name, city: o.city, pvz: o.pvz, address: o.address,
  items: o.items, total: o.total, ship: o.ship || { status: "new" },
  cdek: o.cdek ? { number: o.cdek.number || null, error: o.cdek.error || null, sent: !!o.cdek.uuid, cancelled: !!o.cdek.cancelled } : null,
});

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "Method" }, { status: 405 });
  const by = who(req);
  if (!by) {
    await new Promise((r) => setTimeout(r, 800));
    return Response.json({ error: "Неверный пароль" }, { status: 401 });
  }
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "Bad JSON" }, { status: 400 }); }
  const s = store("orders");

  if (b.action === "ship") {
    const id = String(b.id || "");
    if (!/^GN-[A-Z0-9]{4,20}$/.test(id)) return Response.json({ error: "Нет такого заказа" }, { status: 400 });
    const o = await s.get(id, { type: "json" }).catch(() => null);
    if (!o) return Response.json({ error: "Нет такого заказа" }, { status: 404 });
    const status = STEPS.includes(b.status) ? b.status : (o.ship?.status || "new");
    const track = String(b.track ?? o.ship?.track ?? "").replace(/\s+/g, "").slice(0, 40);
    if (status === "shipped" && !track) return Response.json({ error: "Впишите трек-номер СДЭК" }, { status: 400 });
    const note = String(b.note ?? o.ship?.note ?? "").trim().slice(0, 300);
    const at = new Date().toISOString();
    o.ship = { status, track, note, at, by, history: [...(o.ship?.history || []), { status, track, at, by }].slice(-20) };
    // отмена заказа отменяет и отправление в СДЭК, если посылку ещё не сдали
    if (status === "cancelled" && o.cdek?.uuid && !o.cdek.cancelled) {
      try { await cdek.deleteOrder(o.cdek.uuid); o.cdek.cancelled = true; } catch (e) { o.cdek.error = "Не удалось отменить в СДЭК: " + e.message; }
    }
    await s.setJSON(id, o);
    return Response.json({ order: view(o) });
  }

  // Отправления СДЭК: создать вручную (если авто не сработало), обновить номер, накладная, отмена
  if (["cdek_create", "cdek_refresh", "cdek_label", "cdek_cancel"].includes(b.action)) {
    const id = String(b.id || "");
    const o = /^GN-[A-Z0-9]{4,20}$/.test(id) ? await s.get(id, { type: "json" }).catch(() => null) : null;
    if (!o) return Response.json({ error: "Нет такого заказа" }, { status: 404 });
    if (!cdekOn()) return Response.json({ error: "Не вписаны ключи СДЭК (gluhova-keys)" }, { status: 400 });
    try {
      if (b.action === "cdek_create") {
        if (o.cdek?.uuid && !o.cdek.cancelled) return Response.json({ error: "Отправление уже создано" }, { status: 400 });
        delete o.cdek;
        await registerCdek(o, s);
        await new Promise((ok) => setTimeout(ok, 2500));
        if (o.cdek?.uuid) await refreshCdek(o, s).catch(() => {});
      } else if (b.action === "cdek_refresh") {
        await refreshCdek(o, s);
      } else if (b.action === "cdek_cancel") {
        if (!o.cdek?.uuid || o.cdek.cancelled) return Response.json({ error: "Нет отправления" }, { status: 400 });
        await cdek.deleteOrder(o.cdek.uuid);
        o.cdek.cancelled = true;
        if (o.ship?.track === o.cdek.number) o.ship.track = "";
        await s.setJSON(id, o);
      } else {
        if (!o.cdek?.uuid || o.cdek.cancelled) return Response.json({ error: "Нет отправления СДЭК" }, { status: 400 });
        const pdf = await cdek.waybill(o.cdek.uuid);
        return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="cdek-${o.cdek.number || id}.pdf"` } });
      }
    } catch (e) {
      return Response.json({ error: "СДЭК: " + e.message }, { status: 502 });
    }
    return Response.json({ order: view(o) });
  }

  // Отправление вручную, без заказа на сайте: подарок, бесплатная отправка, заказ по телефону
  if (b.action === "manual_order") {
    if (!cdekOn()) return Response.json({ error: "Не вписаны ключи СДЭК" }, { status: 400 });
    const m = b.order || {};
    const str = (v, n) => String(v ?? "").trim().slice(0, n);
    const name = str(m.name, 100), phone = str(m.phone, 20).replace(/[^\d+]/g, ""), email = str(m.email, 120);
    const tf = cdek.TARIFFS[Number(m.tariff)], door = tf && tf.mode === 3;
    const qty = Math.floor(Number(m.qty) || 1), cost = Math.max(0, Math.round(Number(m.cost) || 0));
    if (!name || phone.replace(/\D/g, "").length < 10) return Response.json({ error: "Укажите имя и телефон получателя" }, { status: 400 });
    if (!Number(m.city_code) || !tf) return Response.json({ error: "Выберите город и тариф" }, { status: 400 });
    if (door ? str(m.address, 200).length < 5 : !str(m.pvz, 50)) return Response.json({ error: door ? "Укажите адрес для курьера" : "Выберите пункт выдачи" }, { status: 400 });
    if (!str(m.title, 120) || !(qty >= 1 && qty <= 20) || cost > 1e6) return Response.json({ error: "Укажите, что отправляем, и количество" }, { status: 400 });
    const now = new Date().toISOString(), id = "GN-" + Date.now().toString(36).toUpperCase();
    const o = {
      order_id: id, name, phone, email, manual: true,
      delivery: door ? "cdek_door" : tf.mode === 7 ? "cdek_postamat" : "cdek_pvz", tariff: Number(m.tariff), tariff_name: tf.name,
      city: str(m.city, 100), city_code: Number(m.city_code), pvz: door ? "" : str(m.pvz, 50), address: str(m.address, 200),
      items: [{ id: "manual", name: str(m.title, 120), price: cost, q: qty, kind: "commodity" }], total: cost * qty,
      created: now, status: "paid", paidAt: now, provider: "manual", payMethod: "manual",
      ship: { status: "new", track: "", note: str(m.note, 300), at: now, by, history: [] },
    };
    await s.setJSON(id, o);
    await registerCdek(o, s);
    await new Promise((ok) => setTimeout(ok, 2500));
    if (o.cdek?.uuid) await refreshCdek(o, s).catch(() => {});
    return Response.json({ order: view(o) });
  }

  if (b.action === "list") {
    const { blobs } = await s.list();
    const keys = blobs.map((x) => x.key).sort().reverse().slice(0, 300);
    const orders = (await Promise.all(keys.map((k) => s.get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
    orders.sort((a, z) => String(z.created).localeCompare(String(a.created)));
    return Response.json({ by, orders: orders.map(view) });
  }
  return Response.json({ error: "Неизвестное действие" }, { status: 400 });
};
