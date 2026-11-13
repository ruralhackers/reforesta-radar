# Plan — Radar Reforesta

Spec: GitHub issue #1 (ruralhackers/reforesta-radar) y docs/superpowers/specs/2026-11-13-reforesta-radar-design.md

## Global Constraints

- Node 24 + TypeScript; Hono sirve `/api` y la SPA; SQLite vía `node:sqlite` (sin dependencias nativas); un solo fichero de BD en volumen.
- Web: Vite + React + Tailwind, en castellano, legible en móvil.
- Nada específico de Reforesta en el código: todo en la semilla → perfil en BD.
- Motor con dependencias inyectadas (fetch, LLM, reloj, emisor de correo). Dos puntos de prueba: motor (fetch falso con respuestas reales grabadas, LLM falso, reloj fijo, emisor falso → se comprueba BD y correo) y API Hono en memoria contra SQLite temporal. Sin tests de la web React. Runner `node --test`.
- Nunca inventar importes/plazos/requisitos: cita literal o "desconocido".
- LLM: Claude Haiku 5.5 (`claude-haiku-5-5`) criba; Claude Sonnet 5.5 (`claude-sonnet-5-5`) análisis. Tope de llamadas por ejecución; caché de PDFs por hash.
- BDNS API: base `https://www.infosubvenciones.es/bdnstrans/api`; en concesiones filtrar por `numeroConvocatoria` (NO `numConv`, se ignora); concesiones solo desde 2022; `nifCif` para una entidad; fechas `dd/MM/yyyy`; metadatos poco fiables.
- Reforesta: NIF G80428204, idPersona BDNS 5886517.
- Correo: Resend, remitente `no-reply@out.ruralhackers.com`; sin destinatarios no se envía.
- `TEAM_PASSWORD` opcional: sin ella todo abierto; con ella lo privado protegido por cookie firmada.
- Dominio demo: radar-reforesta.ruralhackers.com; despliegue anceu-vps puerto 127.0.0.1:8116.
- Commits con línea final: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Cada commit referencia su issue (`Refs #N`).

## Task 1: Recorrido completo mínimo desde BDNS (issue #2)

#### Parent

#1

#### What to build

Un recorrido completo mínimo: `npm run radar` trae las convocatorias recientes de BDNS, aplica reglas deterministas (fuera nominativas, fuera ámbito geográfico no permitido según el perfil, fuera finalidad ajena), guarda las que quedan en SQLite y la web **"Esta semana"** las lista con título, órgano, fecha y enlace a la fuente.

Incluye los cimientos que usarán todos los demás tickets:
- Servicio Node 24 + TypeScript, Hono sirviendo `/api` y la SPA (Vite + React + Tailwind), SQLite con `node:sqlite` en un fichero de volumen.
- **Semilla de Reforesta** (NIF, idPersona BDNS, líneas, ámbito, importes mínimos, organizaciones parecidas iniciales, fundaciones iniciales) cargada al perfil en la base de datos. Nada específico de Reforesta en el código.
- **Motor** con dependencias inyectadas (`fetch`, LLM, reloj, emisor de correo) y su punto de prueba: `fetch` falso con **respuestas reales grabadas** de BDNS y reloj fijo, con `node --test`.
- Registro de ejecución (inicio, fin, fuentes, contadores, errores).
- Dockerfile + compose que levantan el servicio con un volumen de datos.

#### Acceptance criteria

- [ ] `npm run radar` contra BDNS real guarda convocatorias recientes y es idempotente (re-ejecutar no duplica).
- [ ] Las subvenciones nominativas y las de ámbito no permitido quedan descartadas con motivo registrado.
- [ ] La semilla carga el perfil de Reforesta en una base vacía.
- [ ] La web muestra "Esta semana" con las convocatorias guardadas, legible en móvil.
- [ ] Test del motor con respuestas grabadas de BDNS (incluidas 923290 y 825309) y reloj fijo: comprueba qué entra y qué se descarta.
- [ ] Un fallo de red en BDNS queda registrado en la ejecución sin romper el proceso.
- [ ] `docker compose up` levanta web + API con datos persistentes.


## Task 2: Criba con Haiku y análisis con Sonnet, con citas (issue #3)

#### Parent

#1

#### What to build

Las convocatorias que pasan las reglas fijas pasan por una **criba con Haiku** ("puede encajar / descartar + motivo") y las que sobreviven por un **análisis con Sonnet** que lee extracto y bases (PDF → texto) y extrae: elegibilidad de entidades sin ánimo de lucro, importe máximo y total, plazo literal, cofinanciación, requisitos, líneas de Reforesta con las que encaja e **idea de proyecto de 3–4 líneas**. Cada campo lleva su **cita literal** o queda como **desconocido**; nunca se inventa.

La web gana la **ficha de convocatoria** con esos campos, sus citas y enlaces a bases, extracto y sede electrónica.

La elegibilidad se decide por el texto, no por los metadatos de BDNS (la 923290 dice "personas físicas" y debe salir elegible para ESFL).

#### Acceptance criteria

- [ ] Descartes de la criba guardados con motivo y visibles (al menos en la API).
- [ ] Ficha con campos extraídos, cita por campo y "desconocido" cuando no hay cita.
- [ ] Textos de PDF cacheados por hash: un PDF ya leído no se vuelve a enviar al LLM.
- [ ] Tope configurable de llamadas a Sonnet por ejecución; al alcanzarlo se registra y se sigue sin análisis.
- [ ] Coste de LLM por ejecución registrado.
- [ ] Test del motor con LLM falso: un campo sin cita queda como desconocido; la 923290 sale elegible pese a sus metadatos; el tope se respeta.


## Task 3: Plazos calculados en días hábiles (issue #4)

#### Parent

#1

#### What to build

Cuando BDNS no da fecha de cierre y el plazo viene en texto (p. ej. "15 días hábiles tras publicación extracto BOE"), el radar **calcula la fecha** en días hábiles (festivos nacionales + Comunidad de Madrid como mínimo) desde la fecha de publicación y la marca como **calculada**. La ficha muestra la fecha y si es literal o calculada, y el texto original. Las convocatorias con fecha conocida tienen "días hasta el cierre" disponible para "cierran pronto".

#### Acceptance criteria

- [ ] "15 días hábiles tras publicación" con una fecha de publicación conocida produce la fecha correcta, saltando fines de semana y festivos.
- [ ] Si no se puede calcular, queda como desconocida con el texto original visible.
- [ ] La ficha distingue fecha literal / calculada.
- [ ] Test del motor con reloj fijo y una convocatoria grabada con plazo en texto.


## Task 4: Puntuación explicable y ranking por secciones (issue #5)

#### Parent

#1

#### What to build

Cada convocatoria analizada recibe una **puntuación 0–100 explicable** con factores **encaje**, **importe**, **días hasta el cierre**, **esfuerzo** (cofinanciación, requisitos) y **probabilidad** (de momento con lo disponible; el ticket de ganadores la enriquece). Pesos documentados y configurables. Se guarda el desglose.

"Esta semana" se ordena por puntuación y se divide en **nuevas** y **cierran pronto**. La ficha muestra el desglose de cada factor con su explicación en una línea.

#### Acceptance criteria

- [ ] Puntuación y desglose guardados por convocatoria.
- [ ] Ranking ordenado y dividido en "nuevas" / "cierran pronto".
- [ ] Ficha con el desglose legible ("por qué está arriba").
- [ ] Pesos configurables sin tocar la lógica.
- [ ] Test del motor: con LLM falso y reloj fijo, el orden del ranking es el esperado; una convocatoria cerrada no aparece.


## Task 5: Ganadores previos y organizaciones parecidas (issue #6)

#### Parent

#1

#### What to build

El radar consulta en BDNS las **concesiones** de cada convocatoria (por `numeroConvocatoria`; ojo: `numConv` se ignora en ese endpoint) y las de Reforesta (por `nifCif`). Calcula las **organizaciones parecidas** como co-ganadoras de las convocatorias que gana Reforesta, y las guarda (origen: calculada).

La ficha muestra **quién la ganó antes y cuánto**, y si **Reforesta ya la ganó o perdió**. El factor de **probabilidad** usa esto (sube si la ganan parecidas o si Reforesta ya la ganó) y la idea de proyecto se apoya en los ganadores previos.

#### Acceptance criteria

- [ ] Concesiones guardadas por convocatoria (solo desde 2022, límite de BDNS).
- [ ] Organizaciones parecidas calculadas: con datos grabados de 626301/782630/825309 salen GREFA, Brinzal, SEO/BirdLife… entre ellas.
- [ ] Ficha con ganadores previos, importes y marca si Reforesta la ganó.
- [ ] Probabilidad en el desglose refleja ganadores parecidos / historial propio.
- [ ] Test del motor con concesiones grabadas.


## Task 6: Descubrimiento por organizaciones parecidas (issue #7)

#### Parent

#1

#### What to build

Nueva fuente de **descubrimiento**: las otras convocatorias que han ganado las organizaciones parecidas desde 2022 entran como candidatas (si siguen abiertas o tienen una nueva edición) y pasan por la misma criba, análisis y puntuación. "Esta semana" gana la sección **"las ganan organizaciones como vosotros"**.

En la web se puede **ajustar la lista de organizaciones parecidas** (desactivar, p. ej. federaciones de caza, o añadir manualmente por NIF).

#### Acceptance criteria

- [ ] Las convocatorias descubiertas por parecidas llegan al ranking marcadas con su origen.
- [ ] Sección "las ganan organizaciones como vosotros" en "Esta semana".
- [ ] Desactivar una organización parecida la excluye de la siguiente ejecución; añadir una la incluye.
- [ ] Sin duplicados con las convocatorias que ya vienen de BDNS directo.
- [ ] Test del motor con concesiones grabadas de parecidas.


## Task 7: Perfil editable desde la web (issue #8)

#### Parent

#1

#### What to build

Página **Perfil** en la web para editar líneas de trabajo, ámbito geográfico (incluido si se aceptan otras comunidades sin requisito de sede) e importe mínimo. Las reglas fijas, la criba, el análisis y la puntuación leen el perfil en la siguiente ejecución.

#### Acceptance criteria

- [ ] El perfil se ve y se edita desde la web y se guarda en la base de datos.
- [ ] Cambiar el ámbito o el importe mínimo cambia qué entra en la siguiente ejecución (test del motor).
- [ ] Test de la API: lectura y escritura del perfil.


## Task 8: Decisiones del equipo y aprendizaje (issue #9)

#### Parent

#1

#### What to build

En la ficha y en el ranking, botones **"Nos interesa"** y **"Descartar · motivo"** (motivos de un clic + libre) y **notas**. Lista de **"nos interesa"** con sus plazos. Las convocatorias descartadas dejan de salir en el ranking.

Las decisiones anteriores se pasan como **ejemplos** al análisis/puntuación de las nuevas (aprendizaje ligero).

#### Acceptance criteria

- [ ] Marcar, descartar con motivo y anotar desde la web; persiste.
- [ ] Lista "nos interesa" ordenada por plazo.
- [ ] Una descartada no vuelve a salir en "Esta semana".
- [ ] Las decisiones aparecen como ejemplos en la siguiente llamada de análisis (test del motor comprobando lo que recibe el LLM falso).
- [ ] Test de la API para decisiones y notas.


## Task 9: Modo privado con TEAM_PASSWORD (issue #10)

#### Parent

#1

#### What to build

Modo privado controlado por la variable **`TEAM_PASSWORD`**:
- **Sin la variable**: todo visible y usable por cualquiera (demo pública).
- **Con la variable**: convocatorias, empresas y "Cómo sabemos" públicas; **decisiones, notas, perfil, fuentes vigiladas, organizaciones parecidas y estado de empresas** solo con contraseña. La contraseña se cambia por una **cookie firmada** de larga duración. Las respuestas públicas no incluyen decisiones ni notas.

La web muestra un acceso de equipo y oculta los controles privados a quien no ha entrado.

#### Acceptance criteria

- [ ] Tests de la API en ambos modos: sin variable todo abierto; con variable, escrituras y lecturas privadas devuelven 401 sin cookie y funcionan con ella.
- [ ] Las lecturas públicas con variable activa no filtran decisiones ni notas.
- [ ] Contraseña incorrecta no da cookie.
- [ ] La web oculta los botones privados sin sesión y los muestra tras entrar.


## Task 10: Correo del lunes (issue #11)

#### Parent

#1

#### What to build

`npm run digest` compone y envía con **Resend** desde `no-reply@out.ruralhackers.com` el **correo del lunes**: 3–5 convocatorias destacadas con su porqué en una línea, las que **cierran pronto**, y enlaces a cada ficha en la web. Corto y legible en móvil. Destinatarios en `.env`; **sin destinatarios no se envía nada**.

#### Acceptance criteria

- [ ] Test del motor con emisor falso: contenido (destacadas, cierran pronto, enlaces con la URL pública) y destinatarios correctos.
- [ ] Sin destinatarios configurados no se llama al emisor.
- [ ] Envío real de prueba a Agustín desde el dominio verificado.
- [ ] Descartadas no aparecen en el correo.


## Task 11: Fuente EU Funding & Tenders (issue #12)

#### Parent

#1

#### What to build

Nueva fuente **EU Funding & Tenders** (LIFE y programas afines a restauración/biodiversidad) por su API pública de búsqueda. Las convocatorias abiertas entran en la criba, análisis y puntuación, y aparecen en el ranking y en la ficha con su origen.

#### Acceptance criteria

- [ ] Convocatorias abiertas de F&T relevantes llegan al ranking con enlace al portal.
- [ ] Sin duplicados con las que también estén en BDNS.
- [ ] Un fallo del portal no impide el resto de fuentes.
- [ ] Test del motor con respuestas grabadas de F&T.


## Task 12: Fundaciones privadas vigiladas (issue #13)

#### Parent

#1

#### What to build

Vigilancia de **fundaciones privadas y programas de RSC con convocatoria**: lista inicial desde la semilla (donantes de sus memorias: Montemadrid + CaixaBank, "la Caixa", Repsol, Iberdrola, Endesa, BBVA, Mapfre, Ecoembes, Caterpillar, Alstom…) más **agregadores** del tercer sector. Cada ejecución detecta **cambios de contenido** y, si los hay, el LLM extrae convocatorias nuevas o modificadas, que entran en criba, análisis y ranking.

Página **Fundaciones** para ver las fuentes vigiladas, cuándo cambiaron por última vez, y **añadir o quitar** fuentes.

#### Acceptance criteria

- [ ] Una página sin cambios no provoca llamadas al LLM.
- [ ] Una convocatoria nueva en una fuente vigilada llega al ranking con su origen y enlace.
- [ ] Añadir/quitar fuentes desde la web afecta a la siguiente ejecución.
- [ ] Test del motor con páginas grabadas (antes / después del cambio).


## Task 13: Empresas desde las DIA del BOE (issue #14)

#### Parent

#1

#### What to build

Canal de **empresas** a partir de las **Declaraciones de Impacto Ambiental** del BOE (sumario diario de datos abiertos, sección MITECO) que imponen **medidas compensatorias de restauración o hábitat**. Cada empresa se guarda con motivo en una línea, **cita literal**, enlace a la DIA y su página pública de RSC/fundación si existe. **No** se guardan personas de contacto ni correos personales.

Página **Empresas** con estado del equipo (**contactada / descartada** + nota). El **correo del lunes** añade las empresas **nuevas** de la semana.

#### Acceptance criteria

- [ ] Con un sumario del BOE grabado que contiene una DIA con medidas compensatorias, la empresa aparece con motivo, cita y enlace.
- [ ] Una DIA sin medidas de restauración/hábitat no genera empresa.
- [ ] Estado y nota editables desde la web.
- [ ] El correo incluye solo empresas vistas por primera vez esa semana.
- [ ] Tests del motor (BOE grabado) y de la API (estado de empresas).


## Task 14: Empresas del registro de huella de carbono (issue #15)

#### Parent

#1

#### What to build

Segunda fuente del canal de empresas: el **registro de huella de carbono, compensación y proyectos de absorción** del MITECO. Como son miles, solo entran las que pasan una **criba con LLM** por sector, zona (Madrid y alrededores) o por compensar con proyectos de absorción. Aparecen en Empresas con su origen, motivo, cita y enlace.

#### Acceptance criteria

- [ ] Con datos grabados del registro, solo las empresas que pasan la criba aparecen en Empresas.
- [ ] El coste de LLM de esta criba cuenta para el tope de la ejecución.
- [ ] Sin duplicar empresas que ya vienen de una DIA (se fusionan los motivos).
- [ ] Test del motor con datos grabados del registro.


## Task 15: Cómo sabemos (backtest) (issue #16)

#### Parent

#1

#### What to build

Página **"Cómo sabemos"** con el backtest. Es una **reclasificación**, no una reproducción histórica: se pasa la criba y puntuación actuales sobre convocatorias pasadas, calculando los días como si hoy fuera su fecha de publicación, y se compara con el resto de convocatorias de BDNS de esa misma semana.

- **(a)** CAM "proyectos ambientales" 626301, 703977, 782630, 825309, 904719 + ejemplos del reto CAM 1689/2026 y MITECO 923290. Éxito = pasa la criba y queda en el **top 5 de su semana**.
- **(b)** Convocatorias ganadas por organizaciones parecidas desde 2022, filtradas con **reglas objetivas** (sin nominativas, admite ESFL, finalidad ambiental). Métrica: **% detectado y posición**, calculada **sin** la fuente de descubrimiento por parecidas.

La página muestra los resultados, el conjunto de prueba revisable y cuántas convocatorias encajaban y Reforesta no vio.

#### Acceptance criteria

- [ ] Comando para ejecutar el backtest y guardar resultados.
- [ ] Página con resultados (a) por convocatoria y métrica (b), y lista revisable del conjunto (b).
- [ ] La métrica (b) se calcula con la fuente de parecidas desactivada.
- [ ] Test del motor con datos grabados: la 825309 queda en el top 5 de su semana.


## Task 16: Despliegue en anceu-vps (issue #17)

#### Parent

#1

#### What to build

La demo en internet en **`radar-reforesta.ruralhackers.com`**, como el resto de apps de **anceu-vps** (ver `~/src/anceu/anceu-vps/apps.md`): compose en `/opt/apps/reforesta-radar`, puerto `127.0.0.1:8116`, ruta en el túnel Cloudflare `anceu-vps`, `.env` con secretos en el servidor, **sin `TEAM_PASSWORD`** (demo pública). Crontab del usuario `anceu`: `radar` a diario a las 7:00 y `digest` los lunes a las 8:00 (Europe/Madrid). Fila nueva en `apps.md`. Script de despliegue repetible para que cada ticket posterior se publique igual. Workflow de GitHub Actions preparado y **desactivado** para otros hostings.

#### Acceptance criteria

- [ ] `https://radar-reforesta.ruralhackers.com` sirve la web y la API.
- [ ] Los datos sobreviven a un redespliegue (volumen) y entran en el backup restic.
- [ ] Crontab instalado con zona horaria correcta; una ejecución manual por cron deja registro.
- [ ] `apps.md` actualizado.
- [ ] Redesplegar es un solo comando documentado.


## Task 17: README y presentación (issue #18)

#### Parent

#1

#### What to build

**README** en castellano para la entrega y para que Reforesta (u otra ONG) lo ponga en marcha: qué problema resuelve, qué hace, capturas, fuentes, cómo funciona la puntuación, cómo desplegarlo (`docker compose`), variables y claves (Anthropic, Resend, `TEAM_PASSWORD`), coste mensual estimado, cómo adaptar la semilla a otra organización y **Cloudflare Access** como alternativa al modo contraseña. **Resumen en inglés** para la Common Seeds Library. **Guion del vídeo** corto apoyado en "Cómo sabemos".

#### Acceptance criteria

- [ ] Alguien sin contexto puede desplegarlo siguiendo solo el README.
- [ ] Coste mensual estimado con cifras de ejecuciones reales.
- [ ] Resumen en inglés.
- [ ] Guion del vídeo en el repo.
- [ ] Repo listo para hacerlo público (sin secretos, licencia open source).


