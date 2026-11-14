# Glosario

Términos del dominio tal como se usan en el código, la web y la documentación. El código está en castellano: los nombres de
funciones y tablas usan estas mismas palabras.

## Convocatorias

- **Convocatoria**: una ayuda, subvención o premio al que la organización podría presentarse. Id con prefijo de su fuente:
  `bdns:<número>`, `ft:<topic>` (UE), `fund:<host>:<hash>` (fundación). Tabla `convocatorias`.
- **Fuente**: de dónde sale una convocatoria: BDNS (subvenciones públicas españolas), EU Funding & Tenders (`eu_ft`), fundaciones
  vigiladas (`fundacion`). Cada una implementa `Fuente` (`src/sources/`).
- **BDNS**: Base de Datos Nacional de Subvenciones. Publica convocatorias y, desde 2022, sus **concesiones** (quién ganó y cuánto).
- **ESFL**: entidad sin fines (ánimo) de lucro: asociación, fundación, ONG. "Admite ESFL" = puede ser beneficiaria.
- **Pasada / ejecución**: una vuelta completa del radar (`npm run radar`): fuentes → reglas → criba → ganadores → análisis → plazos →
  puntuación. Queda registrada con sus contadores, avisos, errores y coste (`/api/ejecuciones`).
- **Regla**: descarte determinista en código (`src/rules.ts`): nominativa o concesión directa, ámbito fuera del perfil, finalidad ajena.
- **Condición**: lo que deja a una convocatoria "a medias": las autonómicas de otra comunidad solo entran si la criba confirma que no
  exigen sede o actividad allí.
- **Criba**: primer filtro con LLM (Haiku) sobre los textos que ya trae la fuente: "puede encajar" o "descartar" con motivo. Fase `criba_llm`.
- **Análisis**: lectura a fondo con LLM (Sonnet) de la ficha, extractos, bases y PDF: elegibilidad ESFL, importes, plazo, cofinanciación,
  requisitos, líneas con las que encaja e idea de proyecto, cada dato con su **cita** literal. Fase `analisis`.
- **Cita**: fragmento copiado literalmente de un documento. El código comprueba que está en el texto (y que las cifras del valor están en
  la cita); si no, el dato queda como "desconocido". Nunca se inventa.
- **Veredicto**: lo que una fase decide sobre una convocatoria (descarta o no, con motivo). Tabla `convocatoria_fases`.
- **Obsoleto**: veredicto hecho con otra versión del perfil. No se borra: conserva su efecto y se rehace si está en la ventana de pendientes.
- **Ventana de pendientes**: las convocatorias publicadas en los últimos `RADAR_DIAS_PENDIENTES` (30) días, que se criban o analizan aunque
  la fuente ya no las devuelva.
- **En juego**: sin descarte de reglas ni de ninguna fase (y, si tiene condición, aceptada por la criba). Solo lo que está en juego puntúa.
- **Duplicada**: la misma convocatoria vista en otra fuente y en BDNS (mismo título): se queda la de BDNS.
- **Retirada**: convocatoria de fundación que ya no aparece en su página en dos revisiones seguidas.
- **Ficha**: la página de una convocatoria (`/convocatoria/:id`): datos de la fuente, criba, análisis con citas, plazo, puntuación,
  ganadores previos y enlaces.
- **Plazo**: fecha de cierre **literal** (la da la fuente), **calculada** (a partir de un texto como "15 días hábiles desde la publicación
  del extracto", con festivos) o **desconocida** (se muestra el texto original).

## Puntuación y ranking

- **Puntuación**: 0–100, suma ponderada de cinco **factores** (encaje, importe, cierre, esfuerzo, probabilidad), cada uno con su
  explicación. Un dato desconocido nunca cuenta como bueno. Pesos en `seed/puntuacion.json`.
- **Excluida**: no entra en el ranking aunque esté en juego: no admite ESFL, cerrada, o plazo desconocido tras 60 días.
- **Esta semana**: el ranking, en tres **secciones** excluyentes: cierran pronto, nuevas y abiertas; más la lista paralela "las ganan
  organizaciones como vosotros".
- **Serie / edición**: convocatorias del mismo órgano con el mismo título salvo el año ("… 2024", "… 2025") son ediciones de una serie.
  Los **ganadores previos** son los de las ediciones anteriores.
- **Organización parecida**: entidad que ganó las mismas convocatorias que Reforesta (calculada) o añadida a mano. Sirve para la
  probabilidad y para **descubrir** convocatorias (origen "parecidas").

## Equipo

- **Decisión**: lo que el equipo marca en una convocatoria: **nos interesa** o **descartada** (con motivo). Reversible; sirve de ejemplo
  a los prompts de lo nuevo. Es privada con `TEAM_PASSWORD`.
- **Nota**: comentario del equipo en una convocatoria o una empresa.
- **Perfil**: lo que el radar sabe de la organización (líneas de trabajo, ámbito, importe mínimo). Viene de `seed/perfil.json` y se
  edita en la web.

## Empresas

- **Empresa**: posible patrocinadora de proyectos de restauración. Una por nombre normalizado o CIF; solo personas jurídicas.
- **Señal**: cada motivo por el que una empresa aparece (una DIA, una fila del registro de huella), con su cita y enlace.
- **DIA**: declaración (o informe) de impacto ambiental publicada en el BOE. Si obliga al promotor a restaurar o compensar, es una señal.
- **Nivel (tier) A / B**: del registro de huella de carbono del MITECO. A = compensa su huella (motivo concreto); B = gran empresa de un
  sector afín en la zona del perfil, sin compensación conocida (baja confianza, oculta por defecto). Las DIA van por delante de ambas.
- **Estado de empresa**: pendiente, contactada o descartada. Trabajo del equipo: privado con `TEAM_PASSWORD`.

## Coste y control

- **Tope**: máximo de algo por ejecución (análisis, peticiones, resoluciones). Lo que no cabe queda "sin hacer por el tope" para la siguiente.
- **Presupuesto**: techo en USD de todas las llamadas al LLM de una ejecución (`RADAR_PRESUPUESTO_USD`).
- **Huella de página**: hash del texto principal de una página de fundación, sin contadores ni horas: si no cambia, no se llama al LLM.
- **Backtest ("Cómo sabemos")**: medición con convocatorias pasadas: conjunto **(a)** las conocidas que Reforesta ganó o le interesaban y
  conjunto **(b)** las ganadas por organizaciones parecidas (descubrimiento).
