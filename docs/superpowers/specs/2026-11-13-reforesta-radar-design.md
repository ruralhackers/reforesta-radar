# Radar Reforesta — diseño

Fecha: 2026-11-13 · Autor: Agustín (Rural Hackers) con Claude · Estado: borrador para aprobar

## 1. Por qué

Reto **1hack A Coruña / Common Seeds** (The Agile Monkeys): <https://common-seeds.theagilemonkeys.com/onehack>.

Reforesta (ONG, 30+ años, 6–7 personas, NIF G80428204, Tres Cantos) solo presenta 4–5 solicitudes al año,
encontradas "en Google o mirando las mismas cuatro fuentes". El canal de empresas (RSC) está a cero: solo llegan
cuando vienen ellas. **Lo que les falta es capacidad de encontrar y priorizar**, no de redactar.

Pregunta del reto: *¿qué construirías para que Reforesta nunca pierda una convocatoria que merezca la pena, y restaure
más tierra gracias a ello?* Objetivos: ×2 solicitudes (de 4–5 a ~10/año), 2–4 primeras empresas RSC, más hectáreas.

Criterios del jurado, en orden: (1) ataca lo que de verdad duele, con criterio; (2) funciona **con convocatorias
reales**; (3) **"el lunes"**: lo abren y lo usan, listo para producción. Entrega: repo público en GitHub con README +
vídeo corto, por email a hackathons@theagilemonkeys.com.

### Lo que sabemos de Reforesta (datos públicos, verificados)

- Líneas: restauración de ecosistemas (charcas para anfibios, plantación de árboles y otras especies), conservación y
  mejora de hábitats (tritones, control de ailanto, paisajes en Guadarrama) y educación ambiental. También programa
  agroambiental con agricultores y proyectos de hábitat de aves con eléctricas.
- Estatutos: <https://reforesta.es/wp-content/uploads/2026/09/Estatutos-2026-Web.pdf>. Memorias anuales 2011–2024 en
  <https://reforesta.es/quienes-somos/> (patrón `wp-content/uploads/YYYY/MM/Memoria-YYYY.pdf`).
- **Ingresos 2023**: donaciones 343.461 €, subvenciones 58.161 €, servicios 105.008 € → solo ~10 % público.
  Donantes privados recurrentes: Fundación Montemadrid + CaixaBank, Fundación "la Caixa", Repsol, Caterpillar (vía CAF
  America), Alstom, Iberdrola (+ Save the Children). **Por eso lo privado/RSC tiene la misma prioridad que lo público.**
- Concesiones en BDNS (la API solo expone desde 2022-01-01): Comunidad de Madrid, "Subvención entidades sin ánimo de
  lucro proyectos ambientales": 2022 (numConv 626301) 50.532,31 €; 2024 (782630) 29.076,85 €; 2025 (825309)
  29.378,15 €. En 2023 (703977) no ganó. 2026 (904719) pendiente de resolver. Más 4.000 € de minimis 2020 (509776).
- Ganadores recurrentes de esa misma línea CAM ("organizaciones parecidas"): GREFA (G78456118), Grupo Brinzal
  (G78616893), SEO/BirdLife (G28795961), AHE (G78291788), Fundación Artemisan (G13598545), Terra Naturalis
  (G86795002), Fund. Sta. María la Real (G34147827), International Birdwatching Assoc. (G86433836), SEBiCoP
  (G97335798), Halcones Urbanos (G44906352), Federación Madrileña de Caza (G79275632).
- Convocatorias de ejemplo del reto: CAM Orden 1689/2026 y MITECO BDNS 923290 (PDFs enlazados en la página del reto).
- La lista de convocatorias solicitadas/ganadas que el reto dice que Reforesta aporta **no está publicada**; el
  historial se reconstruye con lo de arriba.

## 2. Qué es

Un **radar** que cada día recoge convocatorias (públicas y privadas) y señales de empresas, decide cuáles encajan con
Reforesta, las **prioriza con una puntuación explicable**, y lo enseña en:

- una **web** que pueden abrir desde el lunes sin esperar a ningún correo, y
- un **correo cada lunes a las 8:00** (Europe/Madrid) con lo que toca esta semana.

### Objetivos

- No perder ninguna convocatoria abierta que encaje (alta cobertura), y que las 3–5 primeras de cada semana sean las
  que de verdad merecen el esfuerzo (buena priorización).
- Abrir el canal privado/RSC: fundaciones con convocatoria pública y empresas con motivos verificables para financiar
  restauración.
- Demostrar que funciona con datos reales (backtest con su histórico y con el de organizaciones parecidas).
- Usable el lunes por un equipo no técnico, sin depender de Agustín (perfil editable desde la web).
- Desplegable por cualquiera (open source, `docker compose up`).

### No objetivos

- **No redacta propuestas.** Queda fuera del reto. Como mucho una **idea de proyecto en 3–4 líneas** por convocatoria,
  para ayudar a decidir si presentarse.
- No presenta solicitudes ni rellena formularios de sedes electrónicas.
- No es un CRM completo.

### Antiobjetivos (fallaría aunque "funcione")

- Inventar importes, plazos o requisitos. Cada dato extraído lleva **cita literal** de la fuente y enlace; lo que no se
  sabe se marca como desconocido (patrón del harness de Rural Hackers: nunca inventar €/fechas → `TODO`/desconocido).
- Un correo con 40 convocatorias que nadie lee. El correo es corto (3–5 destacadas + "cierran pronto" + empresas).
- Puntuación de caja negra: cada factor visible en la ficha.
- Ruido de BDNS: las **subvenciones nominativas** (ya adjudicadas a nombre de alguien) y las que no admiten entidades
  como Reforesta deben quedar fuera.

## 3. Restricciones y datos técnicos conocidos

### API BDNS (sin autenticación)

Base: `https://www.infosubvenciones.es/bdnstrans/api`

- `GET /convocatorias/busqueda?page=0&pageSize=N&descripcion=...&order=fechaRecepcion&direccion=desc` — listado.
- `GET /convocatorias?numConv=923290` — detalle: órgano (nivel1–3), `tipoConvocatoria`, `presupuestoTotal`,
  `abierto`, `fechaInicioSolicitud`/`fechaFinSolicitud` (a menudo `null`), `textInicio`/`textFin` (plazo en texto,
  p. ej. "15 días hábiles tras publicación extracto BOE"), `tiposBeneficiarios`, `regiones`, `documentos[]`,
  `anuncios[]` (texto del extracto), `urlBasesReguladoras`.
- `GET /concesiones/busqueda?page=0&pageSize=N&numeroConvocatoria=825309` — **todos los ganadores de una convocatoria**
  (beneficiario, importe, fecha). Ojo: `numConv` aquí se ignora en silencio y devuelve los 31,8 M de concesiones.
- `GET /concesiones/busqueda?...&nifCif=G80428204` o `&beneficiario=<idPersona numérico>` — concesiones de una entidad
  (idPersona de Reforesta: 5886517). `fechaDesde`/`fechaHasta` en `dd/MM/yyyy`.
- `GET /minimis/busqueda?...&nifCif=...` — ayudas de minimis.
- Concesiones solo desde 2022-01-01. Personas físicas anonimizadas (las entidades no).
- **Los metadatos no son fiables**: la 923290 (a la que Reforesta encaja) dice beneficiarios "personas físicas" y
  sector "actividades inmobiliarias". La elegibilidad se decide leyendo extracto/bases, no los campos.

### Otras fuentes

- **EU Funding & Tenders Portal** (LIFE y otros): API de búsqueda pública del portal.
- **Fundaciones privadas / RSC**: no hay base común. Lista curada de páginas de convocatorias + agregadores (p. ej.
  Canal Solidario). Se revisan con LLM y se detectan altas/cambios.
- **BOE — Declaraciones de Impacto Ambiental** (sección III, MITECO) con medidas compensatorias de restauración /
  hábitat: señal de empresas obligadas a restaurar (encaja con los proyectos de aves con eléctricas). Fuente: datos
  abiertos del BOE (sumario diario en XML/JSON).
- **Registro de huella de carbono, compensación y proyectos de absorción (MITECO)**: empresas inscritas que compensan.
- BOE/BOCM sueltos **no** como fuente de convocatorias: toda subvención pública pasa por BDNS.

### Despliegue

- Servidor **anceu-vps**, como el resto de apps (ver `~/src/anceu/anceu-vps/apps.md`): `/opt/apps/reforesta-radar`,
  Docker Compose, puerto `127.0.0.1:8116`, expuesto solo por el túnel Cloudflare `anceu-vps`,
  hostname **`radar-reforesta.ruralhackers.com`** (zona ruralhackers.com en Cloudflare). Añadir fila en `apps.md`.
  Backup: restic general del servidor.
- Tareas programadas desde el crontab del usuario `anceu` en el host (`docker compose run --rm ...`).
- Repo público **`ruralhackers/reforesta-radar`**; local `~/src/ruralhackers/reforesta-radar`.
- Correo: **Resend**, remitente **`no-reply@out.ruralhackers.com`** (Agustín da de alta el dominio de envío). Si no hay
  destinatario configurado, no se envía nada y la web sigue funcionando.
- LLM: **Claude** con la clave de Agustín para el hackathon; README explica cómo poner la suya y el coste mensual
  estimado.

## 4. Enfoques considerados

| Enfoque | Pros | Contras | Decisión |
|---|---|---|---|
| A. GitHub Actions + JSON en el repo + web estática | Gratis, sin servidor, fork y listo | Sin estado para decisiones del equipo; web estática | Descartado: queremos web dinámica con botones |
| B. Cloudflare Pages (Vite) + Pages Functions + D1 | Stack habitual, sin servidor | El proceso de recogida (largo, PDFs, LLM) encaja mal en Workers; datos repartidos | Se eligió primero y **se descartó** al decidir usar anceu-vps |
| C. **VPS anceu-vps: un contenedor Node (Hono) que sirve la SPA Vite + API, SQLite en volumen, cron en el host** | Un solo sitio para datos, proceso y web; patrón probado en el servidor; portable con `docker compose` | Hay que mantener un servidor | **Elegido** |

Además se descartaron: correo solo (sin web) — Reforesta no tendría dónde mirar si no llega el mail; web en Astro —
Agustín prefirió Vite para hacerla más dinámica.

## 5. Decisiones tomadas

### Stack

- **Web**: Vite + React + Tailwind (SPA), en castellano.
- **API y proceso**: TypeScript sobre **Node 24**, **Hono** para la API, **`node:sqlite`** (sin dependencias nativas).
  Un solo contenedor sirve `dist/` y `/api/*`.
- **Base de datos**: un único SQLite en volumen (`data/radar.sqlite`). No hay copia local que sincronizar.
- **Comandos**: `npm run radar` (recoger → cribar → puntuar → guardar) y `npm run digest` (correo).
  Crontab de `anceu`: radar a diario a las 7:00, digest los lunes a las 8:00 (Europe/Madrid).
  Se deja preparado (desactivado) un workflow de GitHub Actions / instrucciones para quien quiera otro hosting.
- **Idioma**: web, correo y README en castellano; README con resumen en inglés para la Common Seeds Library.

### LLM

- **Haiku** criba en bloque (cientos por semana): ¿puede encajar con Reforesta? descarta lo obvio.
- **Sonnet** lee extracto y bases (PDF) de lo que pasa el filtro: elegibilidad, importes, plazo, cofinanciación,
  requisitos, encaje por línea, con **citas literales** que respaldan cada campo; y genera la **idea de proyecto en
  3–4 líneas** apoyada en quién ganó antes.
- Las decisiones del equipo ("nos interesa"/"descartar · motivo") se usan como ejemplos en el prompt de puntuación
  (aprendizaje ligero, patrón LEARNINGS del harness).

### Fuentes (v1)

1. **BDNS** — convocatorias nuevas/abiertas; filtrar nominativas y las que no admiten ESFL.
2. **Descubrimiento por organizaciones parecidas** — ganadores de las convocatorias que gana Reforesta → qué otras
   convocatorias ganan ellos → convocatorias candidatas que Reforesta nunca ha mirado. La lista de parecidas se deriva
   automáticamente (co-ganadores) y se puede ajustar.
3. **EU Funding & Tenders** (LIFE y afines).
4. **Fundaciones privadas / RSC con convocatoria** — lista curada (empezando por los donantes de sus memorias:
   Montemadrid, "la Caixa", Repsol, Iberdrola, Endesa, BBVA, Mapfre, Ecoembes, Caterpillar, Alstom…) + agregadores.
   La lista se gestiona desde la web (página Fundaciones).
5. **Canal empresas** (no son convocatorias, son posibles financiadores): **DIA del BOE** con medidas compensatorias
   de restauración/hábitat (prioritaria) y **registro de huella de carbono** del MITECO. Cada empresa con el motivo,
   la cita y enlace a la fuente, y quién de su sector ya financia a ONG parecidas cuando se sepa.

### Ámbito geográfico

Estatal + UE + Comunidad de Madrid + ayuntamientos de Madrid; de otras comunidades solo las que no exigen sede allí.
Configurable desde el perfil.

### Puntuación (0–100, explicable)

Factores, todos visibles en la ficha: **encaje** con sus líneas, **importe** posible, **días hasta el cierre**,
**esfuerzo** (cofinanciación, requisitos), **probabilidad** (si la ganan organizaciones como ellos; si Reforesta la ganó
antes). El plazo se **calcula** cuando viene en texto ("15 días hábiles tras publicación") y se indica que es calculado.

### Web (páginas)

```
Esta semana    ranking: nuevas · cierran pronto · "las ganan orgs como vosotros"
Ficha          puntuación desglosada · plazo (calculado o literal) · citas de las bases ·
               idea de proyecto (3–4 líneas) · quién la ganó antes y cuánto · botones
Empresas       DIA y huella de carbono: empresa · por qué · cita · fuente
Fundaciones    fuentes privadas vigiladas (añadir/quitar)
Perfil         líneas, ámbito geográfico, importes mínimos → afectan a la puntuación
Cómo sabemos   backtest: su histórico + organizaciones parecidas
```

### Parte privada (variable `TEAM_PASSWORD`)

- **Sin la variable (demo pública):** todo visible y todo usable por cualquiera (botones, notas, perfil, fundaciones).
- **Con la variable (uso real):** convocatorias, empresas y "Cómo sabemos" públicos; decisiones, notas, edición de
  perfil y de fundaciones requieren contraseña y no se muestran sin ella. README menciona Cloudflare Access como
  alternativa (como en pultec).

### Correo del lunes

Corto: 3–5 destacadas con el porqué en una línea, "cierran pronto", y empresas nuevas a contactar; cada elemento enlaza
a su ficha en la web. Destinatarios en `.env`; vacío = no se envía.

### Demostrar que funciona ("Cómo sabemos")

- **(a) Reproducción 2022–2026**: el radar debe detectar todas las convocatorias anuales CAM "proyectos ambientales"
  (626301, 703977, 782630, 825309, 904719) y las dos de ejemplo del reto (CAM 1689/2026, MITECO 923290).
- **(b) Organizaciones parecidas**: conjunto de prueba = convocatorias ganadas por las parecidas desde 2022; métrica =
  % detectado y en qué posición del ranking queda.
- Resultado visible en la web y usable en el vídeo ("no se os habría escapado ninguna; además había N que encajaban").

Concreción (decisión de diseño, no de Agustín):

- **No es una reproducción histórica completa** (sin instantáneas de BDNS en el tiempo). Es una **re-clasificación**:
  se pasa la criba + puntuación actuales sobre las convocatorias históricas, calculando los días de plazo como si
  hoy fuera su fecha de publicación. Éxito en (a) = pasa la criba **y** queda en el top 5 de las convocatorias
  publicadas esa misma semana (se puntúa también esa semana de BDNS para tener contra qué compararla).
- **Verdad de (b)** con reglas objetivas, no con el LLM: convocatorias ganadas por las parecidas desde 2022, quitando
  nominativas, las que no admiten ESFL y las de finalidad ajena (caza, deporte, servicios sociales…) por
  `descripcionFinalidad`/órgano. El conjunto resultante se puede revisar a mano en la web.
- **Sin fuga**: (b) mide el radar **sin** la fuente 2 (descubrimiento por parecidas), solo con el listado de BDNS.
- La lista de solicitudes de Reforesta **no está disponible**; si llega, se añade como conjunto (c) sin cambiar nada.

### Instancia de demo

`radar-reforesta.ruralhackers.com` corre **sin `TEAM_PASSWORD`** (demo pública): lo que se marque allí son datos de
prueba. Reforesta aún no se ha comprometido a usarlo; cuando lo adopte desplegará su instancia (o Agustín para ellos)
con contraseña y base de datos limpia. El correo de la demo llega a Agustín. No hace falta reinicio de demo ni dos
bases de datos.

### Una organización, pero sin atarla al código

Es **para Reforesta**, sin flujo de alta para otras ONG. Todo lo específico (NIF G80428204, idPersona 5886517, líneas,
ámbito, organizaciones parecidas, historial, lista inicial de fundaciones) vive en **datos**: un fichero de semilla
(`seed/reforesta.*`) que carga el perfil en la base de datos, editable luego desde la web. Prompts y backtest leen el
perfil, nunca constantes. Otra ONG podría usarlo cambiando la semilla; un alta automática por NIF queda para después.

### Canal empresas: qué se muestra y cuándo entra una

- Por empresa: nombre, por qué encaja (una línea), cita literal y enlace a la fuente, y su página pública de RSC /
  fundación si existe. **No se buscan personas de contacto ni correos personales** (RGPD).
- Entra si: tiene una **DIA con medidas compensatorias de restauración/hábitat** (siempre), o está en el **registro de
  huella de carbono** y pasa la criba del LLM por sector, zona (Madrid y alrededores) o compensación con proyectos de
  absorción. "Nueva" = primera vez que aparece; el correo solo lista las nuevas de la semana.

### Alcance de la entrega

Agustín gestiona el tiempo y quiere **todo** el alcance; no hay línea de corte. El plan ordena las fases para tener
pronto algo de punta a punta (BDNS → criba → puntuación → web → correo) y añade fuentes después.

## 6. Lo que queda a criterio de quien construya

- Esquema concreto de tablas SQLite y migraciones.
- Prompts exactos, formato de salida estructurada y umbrales de criba.
- Pesos de cada factor de la puntuación (documentados y fáciles de ajustar).
- Cómo calcular días hábiles (festivos nacionales + CAM mínimo).
- Mecanismo exacto de detección de cambios en páginas de fundaciones.
- Cómo consultar el portal F&T, el sumario del BOE y el registro de huella de carbono (APIs/formatos concretos).
- Diseño visual de la web y del correo (sobrio, legible en móvil).
- Límites de coste por ejecución (tope de llamadas a Sonnet por día) y caché de PDFs ya leídos.
- Orden de las fases: Agustín gestiona el tiempo; el plan debe dejar algo funcionando de punta a punta pronto y luego
  ir añadiendo fuentes.
