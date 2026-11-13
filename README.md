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
- Desconocido: "desde el inicio del plazo", notificación, aprobación, apertura; semanas; "días laborables"; varios plazos en el
  mismo texto; sin referencia a la publicación; años sin festivos en el fichero.

Los festivos viven en `seed/festivos.json` (2025–2027: nacionales y Comunidad de Madrid, de las resoluciones de la Dirección General
de Trabajo en el BOE); se aplican los de las regiones del perfil. No incluye fiestas locales. Para otro año, añadirlo al fichero
(`FESTIVOS_FILE` cambia la ruta).
