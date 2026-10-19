const c = require("../lib/cdek");
const j = (s, b, h = {}) => ({ statusCode: s, headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
exports.handler = async (e) => {
  const q = e.queryStringParameters || {};
  try {
    if (q.action === "cities") return j(200, await c.cities(String(q.q || "").slice(0, 60)));
    if (q.action === "pvz") return j(200, await c.pvz(q.city, q.type), { "Cache-Control": "public, max-age=3600" });
    if (q.action === "tariffs") return j(200, await c.tariffs(q.to, q.n, q.v));
    if (q.action === "tariff") return j(200, await c.tariff(q.to, q.door === "1", q.n));
    if (q.action === "addr") return j(200, await c.addr(String(q.q || "").slice(0, 120), String(q.city || "").slice(0, 60)));
    if (q.action === "features") return j(200, { addr: c.hasAddr() });
    return j(400, { error: "action" });
  } catch (err) {
    console.error("cdek", q.action, err.message);
    return j(502, { error: "CDEK недоступен" });
  }
};
