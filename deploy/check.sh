#!/usr/bin/env bash
# Проверка сайта, синхронизации с Instagram и доставки СДЭК. Запускать на сервере от root:
#   bash /var/www/gluhova/deploy/check.sh
# Значения ключей не выводятся — только «задан / пустой».
APP=${APP:-/var/www/gluhova}
ENVF=${ENVF:-/etc/gluhova.env}
DATA=${DATA:-/var/lib/gluhova}

ok()  { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
bad() { printf '  \033[31mНЕТ\033[0m %s\n' "$*"; }
val() { grep -E "^$1=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2-; }
PORT=$(val PORT); PORT=${PORT:-8080}

echo; echo "== Сайт"
if systemctl is-active -q gluhova 2>/dev/null; then ok "сайт запущен"; else bad "сайт не запущен — пришлите вывод: journalctl -u gluhova -n 30"; fi
ok "версия из GitHub: $(git -c safe.directory=$APP -C $APP log -1 --format='%h от %cd' --date=format:'%d.%m %H:%M' 2>/dev/null)"
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$code" = 200 ] && ok "главная страница отвечает" || bad "главная страница не отвечает (код $code)"

echo; echo "== Instagram"
[ -n "$(val IG_ACCESS_TOKEN)" ] && ok "токен IG_ACCESS_TOKEN задан" || bad "IG_ACCESS_TOKEN пустой — синхронизация выключена"
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://graph.instagram.com/me)
[ "$code" != 000 ] && ok "Instagram доступен с сервера" || bad "Instagram недоступен с сервера (блокировка в России)"
STATE="$DATA/shop/state" node -e '
const fs = require("fs");
let s; try { s = JSON.parse(fs.readFileSync(process.env.STATE, "utf8")); } catch { console.log("  НЕТ синхронизация ещё ни разу не выполнялась"); process.exit(); }
const t = (x) => x ? new Date(x).toLocaleString("ru-RU", { timeZone: "Asia/Yekaterinburg" }) : "никогда";
console.log("  последняя успешная синхронизация: " + t(s.lastSync));
const ig = Object.values(s.products || {}).filter((p) => p.source === "instagram");
console.log("  товаров из Instagram: " + ig.length + ", отметок наличия из постов: " + Object.keys(s.ig || {}).length);
const log = (s.log || []).slice(-5);
if (log.length) { console.log("  последние записи журнала:"); for (const l of log) console.log("    " + t(l.at) + " — " + l.text); }
'

echo; echo "== СДЭК"
[ -n "$(val CDEK_CLIENT_ID)" ] && [ -n "$(val CDEK_CLIENT_SECRET)" ] && ok "ключи СДЭК заданы" || bad "CDEK_CLIENT_ID или CDEK_CLIENT_SECRET пустые"
CU=$(val CDEK_API_URL); CU=${CU:-https://api.cdek.ru/v2}
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$CU/oauth/token")
[ "$code" != 000 ] && ok "сервер СДЭК доступен" || bad "сервер СДЭК недоступен с сервера"
PORT=$PORT node -e '
const base = "http://127.0.0.1:" + process.env.PORT + "/api/cdek?action=";
const get = (q) => fetch(base + q).then((r) => r.json());
(async () => {
  for (const city of ["Москва", "Екатеринбург"]) {
    const c = await get("cities&q=" + encodeURIComponent(city)).catch(() => null);
    const m = Array.isArray(c) && c.find((x) => x.city === city);
    if (!m) { console.log("  НЕТ " + city + ": СДЭК не ответил" + (c && c.error ? " (" + c.error + ")" : "")); continue; }
    const l = await get("tariffs&to=" + m.code + "&n=1&v=5000").catch(() => []);
    const t = (Array.isArray(l) && l.find((x) => x.mode === 4)) || {};
    const p = await get("pvz&city=" + m.code).catch(() => []);
    console.log((t.cost != null ? "  OK  " : "  НЕТ ") + city + ": доставка в пункт " + (t.cost != null ? t.cost + " ₽, " + t.min + "–" + t.max + " дн." : "не посчиталась") + ", пунктов выдачи: " + (Array.isArray(p) ? p.length : 0));
  }
})();
'
echo
echo "== Оплата"
M=$(curl -s -m 10 "http://127.0.0.1:$PORT/api/create-order")
echo "$M" | grep -q '"tochka":true' && ok "Точка (СБП и карты): кнопка на сайте есть" || bad "Точка: кнопки нет — не вписаны TOCHKA_JWT и TOCHKA_CUSTOMER_CODE"
if [ -n "$(val YANDEX_PAY_API_KEY)" ]; then
  echo "$M" | grep -q '"split":true' && ok "Яндекс Сплит: кнопка на сайте есть" || bad "Яндекс Сплит: ключ вписан, но сайт его не видит — выполните systemctl restart gluhova"
  YU=$(val YANDEX_PAY_API_URL); YU=${YU:-https://pay.yandex.ru}
  # Запрос несуществующего заказа: 404 — ключ принят, 401/403 — ключ неверный. Ничего не создаёт.
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H "Authorization: Api-Key $(val YANDEX_PAY_API_KEY)" "$YU/api/merchant/v1/orders/GN-CHECK-KEY")
  case "$code" in
    404|200) ok "Яндекс Пэй принимает ключ ($YU)";;
    401|403) bad "Яндекс Пэй отклонил ключ (код $code): проверьте YANDEX_PAY_API_KEY и что ключ рабочий, а не тестовый";;
    000) bad "Яндекс Пэй недоступен с сервера";;
    *) bad "Яндекс Пэй ответил кодом $code";;
  esac
else
  bad "Яндекс Сплит выключен — не вписан YANDEX_PAY_API_KEY"
fi
echo
