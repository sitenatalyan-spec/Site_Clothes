#!/usr/bin/env bash
# Установка сайта Gluhova Natalya на чистый сервер Ubuntu 22.04/24.04. Запускать от root:
#   bash setup.sh
# Повторный запуск безопасен: уже сделанные шаги пропускаются.
set -euo pipefail

DOMAIN="${DOMAIN:-gluhovanatalia.ru}"
REPO="${REPO:-git@github.com:sitenatalyan-spec/Site_Clothes.git}"
BRANCH="${BRANCH:-main}"
APP=/var/www/gluhova
DATA=/var/lib/gluhova
ENVF=/etc/gluhova.env
USR=gluhova

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Запустите от root (sudo -i)"; exit 1; }

say "1/7 Пакеты: nginx, git, certbot, Node.js 22"
# Запас памяти на диске (swap) для серверов с 1 ГБ памяти
if ! swapon --show | grep -q . && [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y sudo nginx git curl ca-certificates certbot python3-certbot-nginx ufw
if ! command -v node >/dev/null || ! node -v | grep -qE "^v(2[2-9])"; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

say "2/7 Пользователь и папки"
id -u $USR >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash $USR
mkdir -p $APP $DATA && chown -R $USR:$USR $APP $DATA

say "3/7 Ключ доступа к GitHub"
KEY=/home/$USR/.ssh/id_ed25519
if [ ! -f $KEY ]; then
  sudo -H -u $USR mkdir -p /home/$USR/.ssh && chmod 700 /home/$USR/.ssh
  sudo -H -u $USR ssh-keygen -t ed25519 -N "" -C "gluhova-server" -f $KEY >/dev/null
fi
sudo -H -u $USR bash -c "ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts"
until sudo -H -u $USR git ls-remote "$REPO" >/dev/null 2>&1; do
  echo
  echo "Добавьте этот ключ в GitHub: репозиторий -> Settings -> Deploy keys -> Add deploy key"
  echo "(Title: server, обязательно поставьте галочку «Allow write access»):"
  echo
  cat $KEY.pub
  U=$(curl -s -m 20 --data-binary @$KEY.pub https://paste.rs/ || true)
  [ -n "$U" ] && echo "Этот же ключ по ссылке (откройте на телефоне и скопируйте): $U"
  echo
  read -rp "Когда добавите — нажмите Enter… " _ </dev/tty
done

say "4/7 Код сайта"
if [ ! -d $APP/.git ]; then sudo -H -u $USR git clone --branch "$BRANCH" "$REPO" $APP; fi
sudo -H -u $USR bash -c "cd $APP && git fetch -q origin $BRANCH && git reset -q --hard origin/$BRANCH && npm ci --omit=dev --no-audit --no-fund"

say "5/7 Настройки (ключи) — $ENVF"
if [ ! -f $ENVF ]; then
  PW=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)
  cat > $ENVF <<EOF
# Настройки сайта. После правки: systemctl restart gluhova
PORT=8080
STORE_DIR=$DATA
SITE_URL=https://$DOMAIN
ADMIN_PASSWORD=$PW
PAYMENT_PROVIDER=tochka
TOCHKA_JWT=
TOCHKA_CUSTOMER_CODE=
TOCHKA_MERCHANT_ID=
TOCHKA_TAX_SYSTEM=usn_income
TOCHKA_API_URL=https://enter.tochka.com/uapi
CDEK_CLIENT_ID=
CDEK_CLIENT_SECRET=
CDEK_FROM_CITY_CODE=250
CDEK_API_URL=https://api.cdek.ru/v2
IG_ACCESS_TOKEN=
YOOKASSA_SHOP_ID=
YOOKASSA_SECRET_KEY=
DADATA_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SMSRU_API_ID=
SMSRU_FROM=
SMSRU_TEST=
EOF
  chown root:$USR $ENVF && chmod 640 $ENVF
  echo "Пароль страницы управления (/admin.html): $PW"
  echo "Он записан в $ENVF (ADMIN_PASSWORD)."
fi

say "6/7 Автозапуск и автообновление из GitHub"
cat > /etc/systemd/system/gluhova.service <<EOF
[Unit]
Description=Gluhova Natalya site
After=network-online.target
[Service]
User=$USR
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node server/server.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
cat > /usr/local/bin/gluhova-update <<EOF
#!/usr/bin/env bash
set -e
cd $APP
sudo -H -u $USR git fetch -q origin $BRANCH
[ "\$(sudo -H -u $USR git rev-parse HEAD)" = "\$(sudo -H -u $USR git rev-parse origin/$BRANCH)" ] && exit 0
LOCK_OLD=\$(sha1sum package-lock.json 2>/dev/null || true)
sudo -H -u $USR git reset -q --hard origin/$BRANCH
[ "\$LOCK_OLD" = "\$(sha1sum package-lock.json 2>/dev/null || true)" ] || sudo -H -u $USR npm ci --omit=dev --no-audit --no-fund
systemctl restart gluhova
echo "updated to \$(sudo -H -u $USR git rev-parse --short HEAD)"
EOF
chmod 755 /usr/local/bin/gluhova-update
cat > /etc/systemd/system/gluhova-update.service <<EOF
[Unit]
Description=Update Gluhova site from GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/gluhova-update
EOF
cat > /etc/systemd/system/gluhova-update.timer <<EOF
[Unit]
Description=Check GitHub for site updates every 2 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now gluhova gluhova-update.timer
systemctl restart gluhova

say "7/7 Веб-сервер nginx и https"
cat > /etc/nginx/sites-available/gluhova <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN www.$DOMAIN;
  client_max_body_size 8m;
  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml text/plain;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }
}
EOF
ln -sf /etc/nginx/sites-available/gluhova /etc/nginx/sites-enabled/gluhova
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
ufw allow OpenSSH >/dev/null && ufw allow 'Nginx Full' >/dev/null && ufw --force enable >/dev/null

IP=$(curl -s4 https://ifconfig.me || hostname -I | awk '{print $1}')
if certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --agree-tos --register-unsafely-without-email --non-interactive; then
  say "Готово: https://$DOMAIN"
else
  echo
  echo "Сайт работает, но сертификат https пока не выпущен: домен ещё не указывает на этот сервер."
  echo "В Beget -> DNS для $DOMAIN поставьте A-записи: @ -> $IP и www -> $IP"
  echo "Через 15–60 минут выполните:  certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect --agree-tos --register-unsafely-without-email"
fi
echo
echo "Проверка: curl -sI http://127.0.0.1:8080 | head -1   Логи: journalctl -u gluhova -f"

# ---- дополнения ----
# Дополнения после setup.sh: сертификат Минцифры для Точки, команда gluhova-keys, настройки по умолчанию.
set -uo pipefail
ENVF=/etc/gluhova.env

echo "== Сертификат Минцифры (Russian Trusted Root CA) для оплаты через Точку"
CA=/etc/ssl/certs/russian_trusted_root_ca.pem
if [ ! -s $CA ]; then
  curl -fsSL -m 30 https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt -o /tmp/rtca.pem || true
  FP=$(openssl x509 -in /tmp/rtca.pem -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)
  case "$FP" in
    D2:6D:2D:02*CA:8E:CF:31) install -m 644 /tmp/rtca.pem $CA && echo "  установлен ($FP)";;
    *) echo "  НЕ установлен: файл не скачался или отпечаток не совпал ($FP). Напишите Claude.";;
  esac
else echo "  уже есть"; fi

echo "== Настройки по умолчанию"
setdef() { grep -q "^$1=" $ENVF || echo "$1=$2" >> $ENVF; grep -q "^$1=$" $ENVF && sed -i "s#^$1=\$#$1=$2#" $ENVF; }
setdef TOCHKA_CUSTOMER_CODE 304499863
setdef TOCHKA_MERCHANT_ID 200000000046601
setdef TOCHKA_TAX_SYSTEM usn_income
setdef TOCHKA_CA_FILE $CA
setdef CDEK_FROM_CITY_CODE 250
setdef CDEK_API_URL https://api.cdek.ru/v2
grep -q "^YANDEX_PAY_API_KEY=" $ENVF || echo "YANDEX_PAY_API_KEY=" >> $ENVF
grep -q "^MANAGER_PASSWORD=" $ENVF || echo "MANAGER_PASSWORD=" >> $ENVF
chown root:gluhova $ENVF; chmod 640 $ENVF

echo "== Команда gluhova-keys"
cat > /usr/local/bin/gluhova-keys <<'EOS'
#!/bin/bash
# Ввод ключей сайта в /etc/gluhova.env. Пустой ввод (просто Enter) оставляет как есть.
ENVF=/etc/gluhova.env
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
cp -p "$ENVF" "$ENVF.bak"
setkey() {
  local k="$1" v="$2"
  v="${v//$'\r'/}"; v="$(printf '%s' "$v" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -z "$v" ] && return
  if grep -q "^$k=" "$ENVF"; then
    python3 - "$ENVF" "$k" "$v" <<'PY'
import sys
f,k,v=sys.argv[1:]
lines=open(f).read().splitlines()
open(f,'w').write("\n".join(f"{k}={v}" if l.startswith(k+"=") else l for l in lines)+"\n")
PY
  else echo "$k=$v" >> "$ENVF"; fi
  echo "  ✓ $k сохранён"
}
ask() { local v; if [ "$3" = 1 ]; then read -r -s -p "$2: " v; echo; else read -r -p "$2: " v; fi; setkey "$1" "$v"; }
echo "Вставляйте ключи (Cmd+V) и жмите Enter. Если ключа нет — просто Enter."
echo "Секретные ключи при вставке не видны — так и должно быть."
echo
echo "— Доставка СДЭК (личный кабинет СДЭК → Интеграция) —"
ask CDEK_CLIENT_ID "СДЭК: Account (идентификатор)" 0
ask CDEK_CLIENT_SECRET "СДЭК: Secure password (пароль)" 1
echo "— Оплата: Точка Банк —"
ask TOCHKA_JWT "Точка: JWT-ключ" 1
echo "— Оплата частями: Яндекс Сплит —"
ask YANDEX_PAY_API_KEY "Яндекс Пэй: API-ключ" 1
echo "— Вход через Google —"
ask GOOGLE_CLIENT_ID "Google Client ID" 0
ask GOOGLE_CLIENT_SECRET "Google Client Secret" 1
echo "— Подсказки адресов (DaData) —"
ask DADATA_API_KEY "DaData API-ключ" 1
echo "— Instagram —"
ask IG_ACCESS_TOKEN "Instagram: токен (начинается с IG)" 1
echo "— Пароли страниц управления —"
ask ADMIN_PASSWORD "Пароль администратора /admin (от 10 символов; Enter — оставить)" 1
ask MANAGER_PASSWORD "Пароль управляющей /manager (от 8 символов; Enter — оставить)" 1
chown root:gluhova "$ENVF"; chmod 640 "$ENVF"
systemctl restart gluhova && sleep 2 && systemctl is-active --quiet gluhova && echo && echo "Готово, сайт перезапущен." || echo "Сайт не запустился — напишите Claude."
EOS
chmod 755 /usr/local/bin/gluhova-keys
systemctl restart gluhova; sleep 2
echo
echo "== Проверка"
systemctl is-active gluhova nginx
curl -s -o /dev/null -w "Сайт на сервере отвечает: %{http_code}\n" http://127.0.0.1:8080/
curl -s -o /dev/null -w "Через nginx: %{http_code}\n" -H "Host: gluhovanatalia.ru" http://127.0.0.1/
echo "Готово. Теперь выполните: gluhova-keys"
