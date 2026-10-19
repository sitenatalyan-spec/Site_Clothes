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

exports.pvz = (c, type) => {
  const t = type === "POSTAMAT" ? "POSTAMAT" : "PVZ";
  return cached(`p:${t}:${Number(c)}`, 12 * H, async () => {
    const r = await call(`/deliverypoints?type=${t}&city_code=` + Number(c));
    if (!Array.isArray(r)) throw new Error("CDEK pvz");
    return r.map((x) => ({
      code: x.code, name: x.name || "", address: (x.location && x.location.address) || "",
      metro: x.nearest_metro_station || "", work: x.work_time || "", fit: !!x.is_dressing_room,
      lat: x.location && x.location.latitude, lon: x.location && x.location.longitude,
    }));
  });
};

// Тарифы для выбора покупателем: отправляем от склада СДЭК (сдаём посылку в пункт), страховка — на сумму товаров.
// mode: 4 — до пункта выдачи, 7 — до постамата, 3 — до двери.
const TARIFFS = {
  136: { mode: 4, name: "Посылка до ПВЗ" },
  483: { mode: 4, name: "Экспресс до ПВЗ" },
  806: { mode: 4, name: "Супер-экспресс до 18:00 до ПВЗ" },
  368: { mode: 7, name: "Посылка до постамата" },
  486: { mode: 7, name: "Экспресс до постамата" },
  137: { mode: 3, name: "Посылка до двери" },
  482: { mode: 3, name: "Экспресс до двери" },
  805: { mode: 3, name: "Супер-экспресс до 18:00 до двери" },
};
exports.TARIFFS = TARIFFS;
const pkg = (cnt) => [{ weight: 700 * cnt, length: 35, width: 30, height: 8 }];
exports.tariffs = (to, n, value) => {
  const cnt = Math.max(1, Math.min(10, Number(n) || 1)), v = Math.max(0, Math.round(Number(value) || 0));
  return cached(`tl:${Number(to)}:${cnt}:${v}`, H, async () => {
    const base = { from_location: { code: Number(process.env.CDEK_FROM_CITY_CODE) }, to_location: { code: Number(to) }, packages: pkg(cnt) };
    const [list, ins] = await Promise.all([
      call("/calculator/tarifflist", { method: "POST", body: JSON.stringify(base) }),
      v ? call("/calculator/tariff", { method: "POST", body: JSON.stringify({ ...base, tariff_code: 136, services: [{ code: "INSURANCE", parameter: String(v) }] }) }).catch(() => null) : null,
    ]);
    if (!Array.isArray(list.tariff_codes)) throw new Error("CDEK tarifflist");
    // Страховка у СДЭК не зависит от тарифа: берём её сумму из одного расчёта; если не пришла — 0,75% от стоимости.
    const sv = ins && Array.isArray(ins.services) ? ins.services.find((x) => x.code === "INSURANCE") : null;
    const insurance = sv ? Number(sv.total_sum ?? sv.sum) || 0 : Math.round(v * 0.0075 * 100) / 100;
    return list.tariff_codes
      .filter((x) => TARIFFS[x.tariff_code] && x.delivery_sum != null)
      .map((x) => ({ code: x.tariff_code, mode: TARIFFS[x.tariff_code].mode, name: TARIFFS[x.tariff_code].name, cost: Math.ceil(x.delivery_sum + insurance), min: x.period_min, max: x.period_max }))
      .sort((a, b) => a.cost - b.cost);
  });
};

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
