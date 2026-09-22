#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -z "$(git status --porcelain)" ]] || { echo 'El árbol debe estar limpio'; exit 1; }
sha=$(git rev-parse HEAD)
[[ "$sha" == "$(git ls-remote origin refs/heads/main | cut -f1)" ]] || { echo 'HEAD debe coincidir con origin/main'; exit 1; }
ssh "${ORGANIMA_DEPLOY_HOST:-root@187.77.9.8}" bash -s -- "$sha" <<'REMOTE'
set -euo pipefail
sha="$1"
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 1
base=/opt/organima
release="$base/releases/$sha"
previous=$(readlink -f "$base/current" 2>/dev/null || true)
mkdir -p "$base/releases" /var/lib/organima
[[ -f /etc/organima/demo.env ]] || { echo 'Falta /etc/organima/demo.env'; exit 1; }
if [[ ! -d "$release/.git" ]]; then
  git clone --quiet https://github.com/abraxacreativelab-cell/Organima.git "$release"
fi
cd "$release"
git fetch --quiet origin main
git checkout --quiet --detach "$sha"
npm ci --no-audit --no-fund
npm run build
ln -sfn /etc/organima/demo.env "$release/.env"
ORGANIMA_RELEASE="$sha" pm2 startOrReload "$release/ecosystem.config.cjs" --only organima --update-env
healthy=0
for attempt in $(seq 1 20); do
 if curl -fsS http://127.0.0.1:3210/api/health | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{const h=JSON.parse(s);process.exit(h.ok&&h.release===process.argv[1]?0:1)}catch{process.exit(1)}})' "$sha"; then healthy=1; break; fi
 sleep 1
done
if [[ "$healthy" != 1 ]]; then
 echo 'Verificación fallida; restaurando versión anterior'
 if [[ -n "$previous" && -f "$previous/ecosystem.config.cjs" ]]; then
  ORGANIMA_RELEASE="$(basename "$previous")" pm2 startOrReload "$previous/ecosystem.config.cjs" --only organima --update-env
 else
  pm2 stop organima || true
 fi
 exit 1
fi
ln -sfn "$release" "$base/current"
pm2 save
printf 'DEPLOYED=%s\n' "$sha"
curl -fsS http://127.0.0.1:3210/api/health
REMOTE
