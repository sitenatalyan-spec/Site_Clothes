#!/usr/bin/env bash
# Установка сайта Gluhova Natalya на чистый сервер Ubuntu 22.04/24.04. Запускать от root:
#   bash setup.sh
# Повторный запуск безопасен: уже сделанные шаги пропускаются.
set -euo pipefail

DOMAIN="${DOMAIN:-gluhovanatalya.ru}"
REPO="${REPO:-git@github.com:xxeleor-cell/Site_Clothes.git}"
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
  echo "(Title: server, галочку «Allow write access» НЕ ставить):"
  echo
  cat $KEY.pub
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
SUPABASE_URL=
SUPABASE_ANON_KEY=
SMSRU_API_ID=
SMSRU_FROM=
SMSRU_TEST=
SEND_SMS_HOOK_SECRET=
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
