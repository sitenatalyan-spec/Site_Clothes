import crypto from "node:crypto";
import {
  sign, verify, sessionToken, userFromRequest, findBy, link, createUser, saveUser, publicUser, normPhone, ordersOf,
} from "../lib/auth.mjs";

const env = (k) => process.env[k] || "";
const j = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const site = () => (env("SITE_URL") || "https://gluhovanatalya.ru").replace(/\/+$/, "");
const googleOn = () => !!(env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET"));
const smsOn = () => !!env("SMSRU_API_ID") || env("AUTH_DEV_SMS") === "1";
const NEXT = new Set(["account", "checkout"]);

// SMS-коды и ограничения частоты — в памяти процесса (сервер один).
const codes = new Map();
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}
const ipOf = (req) => (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";

async function sendSms(phone, text) {
  if (env("AUTH_DEV_SMS") === "1") { console.log(`[dev sms] +${phone}: ${text}`); return; }
  const p = new URLSearchParams({ api_id: env("SMSRU_API_ID"), to: phone, msg: text, json: "1" });
  if (env("SMSRU_FROM")) p.set("from", env("SMSRU_FROM"));
  if (env("SMSRU_TEST") === "1") p.set("test", "1");
  const r = await fetch("https://sms.ru/sms/send", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: p });
  const d = await r.json();
  const item = d.sms && d.sms[phone];
  if (d.status === "OK" && item && item.status === "OK") return;
  throw new Error("SMS.ru: " + ((item && item.status_text) || d.status_text || "ошибка"));
}

function back(next, params) {
  const n = NEXT.has(next) ? next : "account";
  return new Response(null, { status: 302, headers: { Location: `${site()}/${n}?${new URLSearchParams(params)}`, "Cache-Control": "no-store" } });
}

async function googleStart(url) {
  if (!googleOn()) return back("account", { err: "Вход через Google пока не настроен" });
  const next = url.searchParams.get("next") || "account";
  const state = await sign({ n: crypto.randomBytes(8).toString("hex"), next, exp: Date.now() + 15 * 60e3 });
  const q = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: site() + "/api/auth", response_type: "code",
    scope: "openid email profile", state, prompt: "select_account",
  });
  return new Response(null, { status: 302, headers: { Location: "https://accounts.google.com/o/oauth2/v2/auth?" + q, "Cache-Control": "no-store" } });
}

async function googleCallback(url) {
  const st = await verify(url.searchParams.get("state"));
  const next = st?.next || "account";
  if (!st) return back(next, { err: "Время входа истекло, попробуйте ещё раз" });
  if (url.searchParams.get("error")) return back(next, { err: "Вход через Google отменён" });
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code") || "", client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
        redirect_uri: site() + "/api/auth", grant_type: "authorization_code",
      }),
    });
    const d = await r.json();
    if (!d.id_token) throw new Error("google token: " + (d.error_description || d.error || r.status));
    // id_token получен напрямую от Google по https, поэтому достаточно проверить, кому он выдан.
    const g = JSON.parse(Buffer.from(d.id_token.split(".")[1], "base64url").toString("utf8"));
    if (g.aud !== env("GOOGLE_CLIENT_ID") || !/accounts\.google\.com$/.test(g.iss) || !g.sub) throw new Error("google id_token");
    const email = g.email_verified ? String(g.email || "").toLowerCase() : "";
    let u = await findBy("google", g.sub);
    if (!u && email) u = await findBy("email", email);
    if (!u) u = await createUser({ name: g.name || "", email, google: g.sub });
    else {
      u.google = g.sub;
      if (!u.email && email) u.email = email;
      if (!u.name && g.name) u.name = g.name;
      await saveUser(u);
    }
    await link("google", g.sub, u.id);
    if (email) await link("email", email, u.id);
    return back(next, { t: await sessionToken(u.id) });
  } catch (err) {
    console.error("google", err.message);
    return back(next, { err: "Не удалось войти через Google" });
  }
}

export default async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.has("code") || url.searchParams.has("error")) return googleCallback(url);
    if (url.searchParams.get("action") === "google") return googleStart(url);
    if (url.searchParams.get("action") === "providers") return j(200, { google: googleOn(), phone: smsOn() });
    return j(400, { error: "action" });
  }
  if (req.method !== "POST") return j(405, { error: "Method" });
  let b;
  try { b = await req.json(); } catch { return j(400, { error: "Bad JSON" }); }

  if (b.action === "sms-send") {
    if (!smsOn()) return j(503, { error: "Вход по телефону пока не настроен" });
    const phone = normPhone(b.phone);
    if (!phone) return j(400, { error: "Введите номер полностью, например +7 900 000-00-00" });
    if (limited("p1:" + phone, 1, 55e3)) return j(429, { error: "Код уже отправлен. Повторно — через минуту" });
    if (limited("p:" + phone, 5, 3600e3) || limited("ip:" + ipOf(req), 15, 3600e3)) return j(429, { error: "Слишком много попыток. Попробуйте через час" });
    const code = String(crypto.randomInt(1000, 10000));
    codes.set(phone, { code, exp: Date.now() + 10 * 60e3, tries: 0 });
    try { await sendSms(phone, `Gluhova Natalya: код для входа ${code}. Никому не сообщайте.`); }
    catch (err) { console.error("sms", err.message); return j(502, { error: "Не удалось отправить SMS. Попробуйте позже" }); }
    return j(200, { ok: true });
  }

  if (b.action === "sms-verify") {
    const phone = normPhone(b.phone);
    const c = phone && codes.get(phone);
    if (!c || c.exp < Date.now()) return j(400, { error: "Код устарел, запросите новый" });
    if (++c.tries > 5) { codes.delete(phone); return j(400, { error: "Слишком много попыток, запросите новый код" }); }
    if (String(b.code || "").replace(/\D/g, "") !== c.code) return j(400, { error: "Неверный код" });
    codes.delete(phone);
    const cur = await userFromRequest(req);
    let u = await findBy("phone", phone);
    if (cur && u && u.id !== cur.id) return j(409, { error: "Этот номер уже привязан к другому аккаунту" });
    if (cur && !u) { cur.phone = phone; await saveUser(cur); u = cur; }
    if (!u) u = await createUser({ phone });
    await link("phone", phone, u.id);
    return j(200, { token: await sessionToken(u.id), user: publicUser(u) });
  }

  const u = await userFromRequest(req);
  if (!u) return j(401, { error: "Войдите в аккаунт" });

  if (b.action === "me") return j(200, { user: publicUser(u), orders: await ordersOf(u) });

  if (b.action === "update") {
    if (typeof b.name === "string") u.name = b.name.trim().slice(0, 100);
    if (typeof b.email === "string") {
      const e = b.email.trim().toLowerCase().slice(0, 120);
      if (e && !/^\S+@\S+\.\S+$/.test(e)) return j(400, { error: "Проверьте e-mail" });
      u.email = e;
    }
    if (Array.isArray(b.favs)) u.favs = [...new Set(b.favs.map(String).filter((x) => /^[\w-]{1,120}$/.test(x)))].slice(0, 200);
    await saveUser(u);
    return j(200, { user: publicUser(u) });
  }
  return j(400, { error: "Неизвестное действие" });
};
