#!/usr/bin/env bash
# Ускорение сайта на сервере (один раз, от root):  bash /var/www/gluhova/deploy/speed.sh
# - nginx сам отдаёт фото и шрифты (быстрее, чем через Node), с кэшем в браузере на 30 дней;
# - HTTP/2: браузер грузит все картинки параллельно по одному соединению;
# - сжатие gzip для страниц и данных.
# Повторный запуск безопасен. Если nginx не примет настройки, всё откатывается назад.
set -euo pipefail
APP=${APP:-/var/www/gluhova}
CONF=/etc/nginx/sites-available/gluhova
SNIP=/etc/nginx/snippets/gluhova-static.conf
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
[ -f "$CONF" ] || { echo "Не найден $CONF — сайт ставился не через deploy/setup.sh"; exit 1; }

cp "$CONF" "$CONF.bak-speed"
mkdir -p /etc/nginx/snippets
cat > "$SNIP" <<EOF
# Статика сайта напрямую с диска
location ^~ /photos/ { root $APP; expires 30d; access_log off; try_files \$uri =404; }
location ^~ /fonts/  { root $APP; expires 365d; access_log off; try_files \$uri =404; }
location = /cities.json { root $APP; expires 1d; try_files \$uri =404; }
gzip_comp_level 5;
gzip_min_length 1024;
gzip_vary on;
EOF

# подключаем сниппет в блоки server (один раз)
grep -q "gluhova-static.conf" "$CONF" || sed -i "s#client_max_body_size 8m;#client_max_body_size 8m;\n  include $SNIP;#" "$CONF"
# gzip для json/js, если ещё не включён
grep -q "application/json" "$CONF" || sed -i "s#gzip on;#gzip on;\n  gzip_types text/css application/javascript application/json image/svg+xml text/plain;#" "$CONF"
# HTTP/2 на https
grep -q "443 ssl http2" "$CONF" || sed -i -E "s#listen (\[::\]:)?443 ssl;#listen \1443 ssl http2;#" "$CONF"

# nginx (пользователь www-data) должен уметь читать папки с фото
chmod o+rx "$APP" "$APP/photos" "$APP/photos/s" "$APP/photos/w" "$APP/fonts" 2>/dev/null || true

if nginx -t 2>/tmp/nginx-test.log; then
  systemctl reload nginx
  echo "Готово: статика отдаётся напрямую, HTTP/2 $(grep -q 'http2' "$CONF" && echo включён || echo 'не включён (нет https)')."
else
  cat /tmp/nginx-test.log
  cp "$CONF.bak-speed" "$CONF"; rm -f "$SNIP"
  echo "nginx не принял настройки — всё возвращено как было. Пришлите текст ошибки выше."
  exit 1
fi
