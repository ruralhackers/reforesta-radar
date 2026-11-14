# Pasos del despliegue en anceu-vps (los ejecuta el dueño)

Destino: `/opt/apps/reforesta-radar`, `127.0.0.1:8116`, `https://radar-reforesta.ruralhackers.com` por el túnel `anceu-vps`. Modo demo (sin `TEAM_PASSWORD`).
Datos: bind mount `./data` (SQLite, uid 1000 = usuario `node` del contenedor), cubierto por el restic general de `/opt/apps`.

## 1. Primer despliegue (desde tu máquina, en el repo)
Requiere `ssh anceu@anceu-vps` y que `anceu` esté en el grupo `docker`. Crea la carpeta, copia `compose.yaml`, construye la imagen, la copia con `docker save | ssh docker load`:
```bash
ssh anceu@anceu-vps 'sudo mkdir -p /opt/apps/reforesta-radar && sudo chown anceu: /opt/apps/reforesta-radar'   # solo si no existe
deploy/desplegar.sh     # la primera vez parará pidiendo el .env: es normal, sigue en el paso 2 y repite
```

## 2. `.env` en el servidor
```bash
scp deploy/.env.produccion.example anceu@anceu-vps:/opt/apps/reforesta-radar/.env
ssh anceu@anceu-vps 'chmod 600 /opt/apps/reforesta-radar/.env && nano /opt/apps/reforesta-radar/.env'
# rellenar ANTHROPIC_API_KEY, RESEND_API_KEY, RADAR_DIGEST_DESTINATARIOS. TEAM_PASSWORD vacío.
```

## 3. Arrancar
```bash
deploy/desplegar.sh     # este mismo comando es el redespliegue de siempre
```

## 4. Verificar el servicio (en el servidor)
```bash
ssh anceu@anceu-vps
cd /opt/apps/reforesta-radar
docker compose ps                                  # radar: Up (healthy)
curl -fsS http://127.0.0.1:8116/api/salud          # {"ok":true}
curl -fsS http://127.0.0.1:8116/api/semana | head -c 300
ls -ln data                                        # radar.sqlite, dueño 1000
```

## 5. Primera pasada del radar (manual, la que hará cron)
```bash
cd /opt/apps/reforesta-radar
docker compose run --rm -T radar npm run radar 2>&1 | tee -a logs/radar.log
```

## 6. Ruta en el túnel Cloudflare `anceu-vps`
Dashboard: Zero Trust > Networks > Tunnels > `anceu-vps` > Published application routes > Add:
hostname `radar-reforesta.ruralhackers.com`, servicio `HTTP` → `localhost:8116`. (El DNS CNAME proxied se crea con la ruta si la zona ruralhackers.com está en la misma cuenta; si no, crear a mano CNAME → `<id-del-túnel>.cfargotunnel.com`.) Si el túnel se gestiona por fichero, añadir antes de la regla final: `- hostname: radar-reforesta.ruralhackers.com` / `service: http://localhost:8116` y reiniciar `cloudflared`.

## 7. Cron (usuario anceu)
```bash
timedatectl | grep 'Time zone'        # si no es Europe/Madrid, CRON_TZ de la primera línea lo cubre (cron de Ubuntu/Debian)
( crontab -l 2>/dev/null; cat /opt/apps/reforesta-radar/deploy/crontab.txt ) | crontab -   # el script ya copia crontab.txt al servidor
crontab -l
```
Si ya hay otro `CRON_TZ` en el crontab, afecta a las líneas siguientes: pon el bloque del radar al final o fija la zona en cada línea.
Probar la línea de cron a mano: copiar el comando de la línea del radar de `crontab -l` y ejecutarlo en una shell; deja registro en `logs/radar.log`.

## 8. Verificación pública
```bash
curl -fsS https://radar-reforesta.ruralhackers.com/api/salud
curl -fsSI https://radar-reforesta.ruralhackers.com/ | head -3
```

## 9. apps.md
Añadir la fila de `deploy/apps-md-fila.md` a `anceu-vps/apps.md`.

## Redespliegue / operación
`deploy/desplegar.sh` · logs: `docker compose logs -f radar`, `logs/radar.log` · rotación semanal por cron (logrotate de usuario, 8 copias).
Restaurar datos: parar (`docker compose down`), copiar `radar.sqlite` a `data/`, `chown 1000:1000`, `up -d`.
