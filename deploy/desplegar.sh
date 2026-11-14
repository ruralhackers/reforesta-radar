#!/usr/bin/env bash
# Despliega Radar Reforesta en anceu-vps. Un solo comando, repetible:  deploy/desplegar.sh
# Construye la imagen EN LOCAL, la copia con `docker save | ssh docker load` (como puntodeagua)
# y reinicia. No toca .env, data/ ni logs/ del servidor (salvo crearlos y ajustar el dueño de data/).
# SERVIDOR=anceu@anceu-vps por defecto; DIR=/opt/apps/reforesta-radar.
set -euo pipefail
cd "$(dirname "$0")/.."
SERVIDOR="${SERVIDOR:-anceu@anceu-vps}"
DIR="${DIR:-/opt/apps/reforesta-radar}"
IMAGEN=reforesta-radar:local

echo "== Construyendo $IMAGEN"
docker build -t "$IMAGEN" .

echo "== Preparando $DIR en $SERVIDOR"
ssh "$SERVIDOR" "mkdir -p '$DIR/data' '$DIR/logs' '$DIR/deploy'"
scp -q compose.yaml "$SERVIDOR:$DIR/compose.yaml"
scp -q deploy/logrotate.conf deploy/crontab.txt "$SERVIDOR:$DIR/deploy/"

echo "== Copiando la imagen"
docker save "$IMAGEN" | gzip | ssh "$SERVIDOR" 'gunzip | docker load'

echo "== Arrancando"
ssh "$SERVIDOR" bash -s "$DIR" <<'REMOTO'
set -euo pipefail
cd "$1"
[ -f .env ] || { echo "Falta $1/.env (ver deploy/PASOS.md paso 2)" >&2; exit 1; }
docker compose run --rm -T --no-deps --user root --entrypoint chown radar -R node:node /app/data
docker compose up -d --no-build --remove-orphans
docker compose ps
REMOTO

echo "== Listo. Comprueba:  ssh $SERVIDOR 'curl -fsS http://127.0.0.1:8116/api/salud'"
