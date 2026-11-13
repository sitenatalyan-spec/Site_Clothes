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
        if (o.status !== "paid") return Response.json({ error: "Заказ не оплачен" }, { status: 400 });
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

  if (b.action === "list") {
    const { blobs } = await s.list();
    const keys = blobs.map((x) => x.key).sort().reverse().slice(0, 300);
    const orders = (await Promise.all(keys.map((k) => s.get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
    orders.sort((a, z) => String(z.created).localeCompare(String(a.created)));
    return Response.json({ by, orders: orders.map(view) });
  }
  return Response.json({ error: "Неизвестное действие" }, { status: 400 });
};
