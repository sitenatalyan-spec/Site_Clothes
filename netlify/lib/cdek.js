// СДЭК API v2 + подсказки адресов DaData (необязательно).
const U = process.env.CDEK_API_URL || "https://api.cdek.ru/v2";
let tok;
async function token() {
  if (tok && tok.exp > Date.now()) return tok.v;
  const r = await fetch(U + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.CDEK_CLIENT_ID, client_secret: process.env.CDEK_CLIENT_SECRET }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("CDEK auth failed");
  tok = { v: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return tok.v;
}
const call = async (p, o = {}) =>
  (await fetch(U + p, { ...o, headers: { Authorization: "Bearer " + (await token()), "Content-Type": "application/json" } })).json();

// Кэш в памяти: СДЭК отвечает по 1–3 секунды, а списки городов и пунктов меняются редко.
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  if (cache.size > 2000) cache.clear();
  cache.set(key, { v, exp: Date.now() + ttlMs });
  return v;
}
const H = 3600e3;

exports.cities = (q) => {
  const k = String(q).toLowerCase().trim();
  return cached("c:" + k, 24 * H, async () => {
    const r = await call("/location/cities?country_codes=RU&size=10&city=" + encodeURIComponent(q));
    if (!Array.isArray(r)) throw new Error("CDEK cities");
    return r;
  });
};

exports.pvz = (c) =>
  cached("p:" + Number(c), 12 * H, async () => {
    const r = await call("/deliverypoints?type=PVZ&city_code=" + Number(c));
    if (!Array.isArray(r)) throw new Error("CDEK pvz");
    return r.map((x) => ({
      code: x.code, name: x.name || "", address: (x.location && x.location.address) || "",
      metro: x.nearest_metro_station || "", work: x.work_time || "", fit: !!x.is_dressing_room,
      lat: x.location && x.location.latitude, lon: x.location && x.location.longitude,
    }));
  });

// 136 склад-склад (ПВЗ), 137 склад-дверь. Вес: допущение 700 г на изделие.
exports.tariff = (to, door, n) => {
  const cnt = Math.max(1, Math.min(10, Number(n) || 1));
  return cached(`t:${Number(to)}:${door ? 1 : 0}:${cnt}`, H, async () => {
    const d = await call("/calculator/tariff", {
      method: "POST",
      body: JSON.stringify({
        tariff_code: door ? 137 : 136,
        from_location: { code: Number(process.env.CDEK_FROM_CITY_CODE) },
        to_location: { code: Number(to) },
        packages: [{ weight: 700 * cnt, length: 35, width: 30, height: 8 }],
      }),
    });
    if (d.total_sum == null) throw Object.assign(new Error("no tariff"), { soft: { cost: null } });
    return { cost: Math.ceil(d.total_sum), min: d.period_min, max: d.period_max };
  }).catch((e) => { if (e.soft) return e.soft; throw e; });
};

// Подсказки адреса (улица, дом) в пределах города. Ключ: DADATA_API_KEY (бесплатно до 10 000 запросов в сутки).
exports.hasAddr = () => !!process.env.DADATA_API_KEY;
exports.addr = (q, city) => {
  if (!process.env.DADATA_API_KEY) return Promise.resolve([]);
  const k = `a:${city}:${String(q).toLowerCase().trim()}`;
  return cached(k, 24 * H, async () => {
    const r = await fetch(process.env.DADATA_URL || "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address", {
      method: "POST",
      headers: { Authorization: "Token " + process.env.DADATA_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: String(q).slice(0, 120), count: 8,
        ...(city ? { locations: [{ city }, { settlement: city }], restrict_value: true } : {}),
        from_bound: { value: "street" }, to_bound: { value: "flat" },
      }),
    });
    const d = await r.json();
    if (!Array.isArray(d.suggestions)) throw new Error("DaData");
    return d.suggestions.map((s) => ({
      value: s.value, house: !!(s.data && s.data.house),
      lat: s.data && s.data.geo_lat ? Number(s.data.geo_lat) : null,
      lon: s.data && s.data.geo_lon ? Number(s.data.geo_lon) : null,
    }));
  });
};
