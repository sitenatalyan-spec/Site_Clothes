// Аккаунты покупателей: вход через Google или по SMS-коду. Данные хранятся на нашем сервере.
import crypto from "node:crypto";
import { store } from "./shop.mjs";

const b64u = (b) => Buffer.from(b).toString("base64url");
let secretP;
async function secret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  // Если секрет не задан в настройках, создаём его один раз и храним вместе с данными сайта.
  return (secretP ||= (async () => {
    const s = store("auth");
    let v = await s.get("secret");
    if (!v) { v = crypto.randomBytes(32).toString("hex"); await s.set("secret", v); }
    return v;
  })());
}
const hmac = async (data) => crypto.createHmac("sha256", await secret()).update(data).digest("base64url");
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function sign(obj) {
  const body = b64u(JSON.stringify(obj));
  return body + "." + (await hmac(body));
}
export async function verify(t) {
  const [body, sig] = String(t || "").split(".");
  if (!body || !sig || !same(sig, await hmac(body))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}

const SESSION_DAYS = 90;
export const sessionToken = (uid) => sign({ u: uid, exp: Date.now() + SESSION_DAYS * 864e5 });

export async function userFromRequest(req) {
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const s = await verify(t);
  if (!s || !s.u) return null;
  return getUser(s.u);
}

const users = () => store("users");
const index = () => store("user-index");
export const getUser = async (id) => (/^u_[\w-]{6,40}$/.test(id) ? users().get(id, { type: "json" }) : null);
export const saveUser = (u) => users().setJSON(u.id, { ...u, updated: new Date().toISOString() });

export async function findBy(kind, value) {
  const id = await index().get(`${kind}:${value}`);
  return id ? getUser(id) : null;
}
export const link = (kind, value, id) => index().set(`${kind}:${value}`, id);

export async function createUser(fields) {
  const u = { id: "u_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), name: "", email: "", phone: "", favs: [], created: new Date().toISOString(), ...fields };
  await saveUser(u);
  return u;
}

export const publicUser = (u) => ({ id: u.id, name: u.name || "", email: u.email || "", phone: u.phone || "", google: !!u.google, favs: u.favs || [] });

export function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 10 && d[0] === "9") d = "7" + d;
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  return /^7\d{10}$/.test(d) ? d : null;
}

// Заказы покупателя: список номеров по аккаунту + заказы, оформленные раньше на тот же телефон.
export async function addOrderToUser(uid, orderId) {
  const s = store("user-orders");
  const list = (await s.get(uid, { type: "json" })) || [];
  if (!list.includes(orderId)) list.unshift(orderId);
  await s.setJSON(uid, list.slice(0, 200));
}
export async function ordersOf(u) {
  const os = store("orders");
  const ids = new Set((await store("user-orders").get(u.id, { type: "json" })) || []);
  if (u.phone) {
    const { blobs } = await os.list();
    const recent = blobs.map((b) => b.key).sort().reverse().slice(0, 400);
    for (const k of recent) {
      if (ids.has(k)) continue;
      const o = await os.get(k, { type: "json" }).catch(() => null);
      if (o && normPhone(o.phone) === u.phone) ids.add(k);
    }
  }
  const orders = (await Promise.all([...ids].map((k) => os.get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
  orders.sort((a, z) => String(z.created).localeCompare(String(a.created)));
  return orders.slice(0, 50).map((o) => ({
    id: o.order_id, created: o.created, total: o.total, items: o.items, status: o.status || "created",
    delivery: o.delivery, city: o.city, address: o.address,
  }));
}
