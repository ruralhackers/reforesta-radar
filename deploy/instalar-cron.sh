#!/usr/bin/env bash
# Instala/actualiza el bloque de cron del radar en el crontab del usuario actual (idempotente).
# Uso en el servidor, como anceu:  /opt/apps/reforesta-radar/deploy/instalar-cron.sh
set -euo pipefail
BLOQUE="$(dirname "$0")/crontab.txt"
{ crontab -l 2>/dev/null | sed '/^# BEGIN reforesta-radar$/,/^# END reforesta-radar$/d'; cat "$BLOQUE"; } | crontab -
crontab -l
