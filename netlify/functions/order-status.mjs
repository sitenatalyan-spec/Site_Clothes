// Статус оплаты одного заказа — для страницы «Спасибо за заказ». Отдаём только статус, без данных покупателя.
import { store } from "../lib/shop.mjs";
import { refreshOrder } from "../lib/payments.mjs";

export default async (req) => {
  const id = new URL(req.url).searchParams.get("o") || "";
  if (!/^GN-[A-Z0-9]{4,20}$/.test(id)) return Response.json({ error: "id" }, { status: 400 });
  const s = store("orders");
  let o = await s.get(id, { type: "json" }).catch(() => null);
  if (!o) return Response.json({ status: "unknown" }, { status: 404 });
  try { o = await refreshOrder(o, s); } catch {}
  return Response.json({ status: o.status || "pending" }, { headers: { "Cache-Control": "no-store" } });
};
