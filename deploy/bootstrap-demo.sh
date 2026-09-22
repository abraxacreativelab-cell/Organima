#!/usr/bin/env bash
set -euo pipefail
# One-time isolated simulation host. No external API credentials are copied.
ssh "${ORGANIMA_DEPLOY_HOST:-root@187.77.9.8}" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p /etc/organima /var/lib/organima
if [[ ! -e /etc/organima/demo.env ]]; then
 umask 077
 cat > /etc/organima/demo.env <<'ENV'
PORT=3210
HOST=127.0.0.1
ORGANIMA_MODE=simulation
ORGANIMA_DATA_DIR=/var/lib/organima
ORGANIMA_OPERATOR_TOKEN=demo
ENV
fi
if [[ ! -e /etc/nginx/sites-available/organima-demo ]]; then
 cat > /etc/nginx/sites-available/organima-demo <<'NGINX'
server {
 listen 80;
 server_name organima.187-77-9-8.sslip.io;
 client_max_body_size 3m;
 location / {
  proxy_pass http://127.0.0.1:3210;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_buffering off;
  proxy_read_timeout 90s;
 }
}
NGINX
 ln -s /etc/nginx/sites-available/organima-demo /etc/nginx/sites-enabled/organima-demo
fi
nginx -t
systemctl reload nginx
certbot --nginx -d organima.187-77-9-8.sslip.io --non-interactive --agree-tos --register-unsafely-without-email
REMOTE
