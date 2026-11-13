# Radar Reforesta

Radar de convocatorias y financiadores para Reforesta. (README completo pendiente.)

## Arrancar

Requiere Node 24 (ejecuta TypeScript directamente) o Docker.

```sh
npm install
npm run radar      # una pasada: BDNS → reglas → criba (Haiku) → análisis con citas (Sonnet) → SQLite (data/radar.sqlite)
npm run build      # compila la web (dist/web)
npm start          # web + API en http://127.0.0.1:8116
npm test           # node --test (motor con respuestas reales grabadas de BDNS + API)
```

Con Docker:

```sh
docker compose up -d                          # web + API en http://127.0.0.1:8116 (PORT en .env para cambiarlo)
docker compose run --rm radar npm run radar   # una pasada del radar
```

Variables: ver `.env.example`. Sin `ANTHROPIC_API_KEY` el radar se salta la criba y el análisis y lo apunta en
el registro de la ejecución (`/api/ejecuciones`), donde también queda el coste de LLM de cada pasada.

Para grabar las respuestas de BDNS y los PDF que faltan en los tests: `npm run record:bdns` (`-- --todo` para regrabar todo).

## Plazos de solicitud

Cada candidata tiene una fecha de cierre **literal** (la da la fuente o está escrita en el texto), **calculada** o **desconocida**
(con el texto original a la vista). Se calcula en código, sin LLM, en cada ejecución (`src/plazos.ts`, tabla `plazos`).

Calculado, siempre desde la publicación (del extracto en boletín si consta su fecha; si no, desde el registro en BDNS y se marca
como *aproximada*):

- "N días hábiles" (cifras o letra, "décimo quinto día hábil"): desde el día siguiente, sin sábados, domingos ni festivos.
  "N días" sin calificar se entienden hábiles (art. 30.2 Ley 39/2015).
- "N días naturales" y "un mes / N meses" (de fecha a fecha; si el mes no tiene ese día, el último): si el último día es inhábil,
  pasa al primer hábil siguiente.
- Desconocido: "desde el inicio del plazo" si el texto de inicio no es "día siguiente a la publicación"; notificación, aprobación, apertura; semanas; "días laborables"; varios plazos en el
  mismo texto; sin referencia a la publicación; años sin festivos en el fichero.

Los festivos viven en `seed/festivos.json` (2025–2027: nacionales y Comunidad de Madrid, de las resoluciones de la Dirección General
de Trabajo en el BOE); se aplican los de las regiones del perfil. No incluye fiestas locales. Para otro año, añadirlo al fichero
(`FESTIVOS_FILE` cambia la ruta).

## Puntuación y ranking

Cada candidata en juego recibe una puntuación **0–100 explicable**, calculada en código, sin LLM, en cada ejecución
(`src/puntuacion.ts`, fase `puntuacion`; el desglose se guarda en la tabla `puntuaciones` y se ve en la ficha, "Por qué está donde está").
Es una suma ponderada de cinco factores, cada uno con una subpuntuación 0–1 y una explicación de una línea:

| Factor | Qué mira |
|---|---|
| encaje | líneas de Reforesta con las que encaja el análisis (Sonnet) y si admite entidades sin ánimo de lucro |
| importe | máximo por proyecto (o, si solo consta, el total, que vale menos) frente al mínimo del perfil, en escala logarítmica |
| cierre | días que faltan según el plazo (poco tiempo penaliza; muy lejano, algo menos) |
| esfuerzo | % de cofinanciación y número de requisitos con cita |
| probabilidad | enchufable (`ProveedorProbabilidad`): hoy sin datos (valor neutro, "desconocida"); el ticket de ganadoras e historial propio lo rellena |

Un dato que falta **no cuenta como bueno**: el factor vale su `valorDesconocido` y la explicación dice "desconocido".
Quedan fuera del ranking (con el motivo guardado) las que no admiten entidades sin ánimo de lucro y las ya cerradas.

**Pesos y umbrales: `seed/puntuacion.json`** (`PUNTUACION_FILE` cambia la ruta; documentado dentro, campo `_`). Los pesos son relativos
(no tienen que sumar 100). Al cambiarlos, la siguiente pasada del radar recalcula todo.

"Esta semana" (`GET /api/semana`) lista **todas las abiertas en juego**, ordenadas por puntuación y divididas en tres secciones:
**cierran pronto** (cierre en `cierranProntoDias`, 21 por defecto), **nuevas** (vistas por primera vez en los últimos `nuevasDias`, 7) y
**abiertas** (el resto: cierre lejano o desconocido). Una convocatoria sale en **una sola** (cierran pronto > nuevas > abiertas), así que
nunca se pierde una que encaja. Las cerradas y las excluidas no salen. La API calcula la puntuación en el momento de la petición con el
reloj de ese momento (función pura y barata): total, explicación del cierre y secciones son siempre coherentes; lo guardado en
`puntuaciones` por cada pasada es solo registro (y se borra para las que dejan de estar en juego).

## Ganadores previos y organizaciones parecidas

Cada ejecución consulta en BDNS las concesiones de Reforesta (por NIF), de cada candidata y de las ediciones anteriores de su serie
(mismo órgano y título salvo el año, p. ej. «proyectos ambientales» de la CAM 2022-2026). BDNS solo tiene concesiones desde 2022 y solo
publica ganadores: la ficha dice «no figura entre los ganadores», nunca «perdió». Las organizaciones parecidas (origen `calculada`) son las
entidades que ganaron lo mismo que Reforesta; las `manual` y las desactivadas (`activa = 0`) no se tocan al recalcular. El factor de
probabilidad sube con las ediciones ganadas por Reforesta y con las parecidas entre los ganadores. `npm run record:concesiones` regraba los
datos de prueba (`test/fixtures/bdns-concesiones`).

## Descubrimiento por organizaciones parecidas

Antes de la criba, el radar trae de BDNS lo que han ganado desde 2022 las organizaciones parecidas **activas** (por NIF; caché de 7 días) y,
de cada convocatoria que ganaron (desde 2022, configurable con `RADAR_DESDE_ANIO_PARECIDAS`), busca si su serie tiene una **edición nueva** (año posterior) que no esté resuelta
ni haya cerrado. Esa edición es candidata y sigue el camino normal (reglas, criba, análisis, puntuación) con el origen «parecidas» y la
organización y edición anterior que la ganó. Sin duplicados: el id es el de BDNS (`bdns:<número>`); si ya venía del listado directo solo se
le añade la etiqueta. Las descubiertas solo por esta vía dejan de estar en juego en cuanto ninguna parecida activa las respalda (desactivar
una organización la excluye en la siguiente ejecución; las etiquetas se reconstruyen en cada pasada). Comparte con la fase de ganadores el
tope de peticiones a BDNS (`RADAR_MAX_PETICIONES_GANADORES`; el descubrimiento gasta como mucho `RADAR_MAX_PETICIONES_PARECIDAS`) y la pausa.
Usa las parecidas ya guardadas (semilla, manuales y las calculadas en la ejecución anterior).

**«Las ganan organizaciones como vosotros»** es una lista **paralela** en «Esta semana» (campo `lasGananParecidas` de `/api/semana`, por
puntuación): convocatorias en juego con origen «parecidas» o con una parecida activa entre sus ganadores previos. No es una cuarta
sección excluyente: la convocatoria sale además en su sección principal (cierran pronto > nuevas > abiertas), para que una urgente no se
pierda por ser también de parecidas. Cada convocatoria lleva `parecidas: { descubierta, organizaciones[{nif, nombre, anios}] } | null`.

Ajuste en la web (`/parecidas`) y API: `GET /api/parecidas` (nombre, NIF, origen, coincidencias, activa, convocatorias aportadas),
`PATCH /api/parecidas/:nif {activa}`, `POST /api/parecidas {nif, nombre?}` (alta manual; solo NIF de entidad), `DELETE /api/parecidas/:nif`
(solo manuales; las demás se desactivan). Las escrituras están en un sub-router aparte para protegerlas con `TEAM_PASSWORD`.
`npm run record:parecidas` regraba los datos de prueba (GREFA y Grupo Brinzal, reloj 20/08/2026).

## Decisiones del equipo y aprendizaje

En la ficha y en cada fila de "Esta semana": "Nos interesa" o "Descartar" con un motivo de un clic ("Otro" con texto libre), y notas con fecha y autor opcional en la ficha. `/nos-interesa` lista lo marcado por plazo (el más próximo primero, plazo desconocido al final). Todo es reversible. Se guarda en las tablas `decisiones` y `notas`, que ninguna ejecución toca. Lo descartado deja de salir en "Esta semana" (también en la lista de parecidas) y no se criba ni analiza si aún no tenía veredicto.

Aprendizaje: las últimas `RADAR_EJEMPLOS_DECISIONES` (20) decisiones, con título, órgano y resumen corto, van como ejemplos al final del texto de sistema de la criba y el análisis de las convocatorias NUEVAS. Los veredictos ya guardados no se rehacen al decidir. Añadir una decisión cambia el texto de sistema y por tanto la clave de `llm_cache` (esperado: solo lo aún sin veredicto paga una llamada nueva).

## Modo privado (`TEAM_PASSWORD`)

Sin `TEAM_PASSWORD` (ausente o vacía) todo es público y editable (demo). Con ella: convocatorias, "Esta semana", empresas y "Cómo sabemos" siguen
públicas, pero decisiones, notas, perfil (escritura), organizaciones parecidas (escritura) y lo que añadan las tareas de fuentes vigiladas y estado de
empresas piden contraseña (401 sin sesión). Las respuestas públicas nunca incluyen decisiones ni notas; lo descartado por el equipo sigue
ocultándose de `/api/semana` para todos.

- `POST /api/sesion {password}` compara en tiempo constante y da una cookie `radar_equipo` firmada (HMAC), HttpOnly, SameSite=Lax, de 180 días
  (Secure si la petición es https / `X-Forwarded-Proto: https`, o forzado con `RADAR_COOKIE_SECURE`). `DELETE /api/sesion` sale; `GET /api/sesion`
  devuelve `{ modoPrivado, autenticado }`.
- La clave de firma sale de `TEAM_PASSWORD` y `SESSION_SECRET` (opcional pero recomendado): cambiar cualquiera invalida las cookies antiguas.
- Fuerza bruta: pausa de 0,5 s ante contraseña errónea y límite en memoria de 10 intentos fallidos por IP cada 15 min (429; el intento se reserva antes de
  leer el cuerpo, así que las ráfagas en paralelo no lo esquivan). No hay bloqueo global: una contraseña correcta nunca se rechaza por fallos de otras IP.
  IP del cliente: `CF-Connecting-IP` (Cloudflare Tunnel); `X-Forwarded-For`/`X-Real-IP` solo con `RADAR_CONFIAR_X_FORWARDED_FOR=1`; sin cabecera, la
  dirección del socket. `CF-Connecting-IP` se acepta sin más porque el puerto está en 127.0.0.1 y solo se llega por Cloudflare Tunnel (que la fija):
  si se expone el puerto directamente, esa cabecera se puede falsificar y el límite se esquiva (no lo expongas, o ponlo tras un proxy que la sobrescriba).
  Ojo: el límite por IP bloquea también la contraseña correcta tras 10 fallos desde la misma IP/NAT durante 15 min (429). En el VPS pon `RADAR_COOKIE_SECURE=1` (la app ve http local tras el túnel).
- CSRF: SameSite=Lax y las escrituras exigen `Content-Type: application/json` (415 si no).
- Para marcar una ruta nueva como privada, ver la cabecera de `src/api/equipo.ts`: sub-router con `router.use('*', acceso.requiereEquipo)`.

## Correo del lunes

`npm run digest` envía por Resend (HTTP directo, sin dependencias) el resumen semanal: destacadas con su porqué, las que cierran pronto y las que ganan organizaciones parecidas, con enlace a cada ficha. Variables: `RESEND_API_KEY`, `RADAR_DIGEST_DESTINATARIOS` (separados por comas; vacío = no se envía nada), `RADAR_DIGEST_REMITENTE`, `RADAR_URL_PUBLICA`. Una vez por semana ISO (`--forzar` para repetir); cada envío queda en la tabla `envios_resumen`. `npm run digest -- --vista-previa` escribe `data/digest-preview.html` sin enviar.
