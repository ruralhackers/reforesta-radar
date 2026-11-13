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
