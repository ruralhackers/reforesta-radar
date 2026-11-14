# Glosario

Términos del dominio tal como se usan en el código, la web y la documentación. El código está en castellano: los nombres de
funciones y tablas usan estas mismas palabras.

## Convocatorias

- **Convocatoria**: una ayuda, subvención o premio al que la organización podría presentarse. Id con prefijo de su fuente:
  `bdns:<número>`, `ft:<topic>` (UE), `cascada:<id>` (UE en cascada), `fund:<host>:<hash>` (fundación). Tabla `convocatorias`.
- **Fuente**: de dónde sale una convocatoria: BDNS (subvenciones públicas españolas), EU Funding & Tenders (`eu_ft`), convocatorias en cascada de la UE (`eu_cascada`), fundaciones
  vigiladas (`fundacion`), licitaciones públicas de PLACSP (`placsp`, ver [Licitaciones](#licitaciones)). Cada una implementa `Fuente` (`src/sources/`).
- **BDNS**: Base de Datos Nacional de Subvenciones. Publica convocatorias y, desde 2022, sus **concesiones** (quién ganó y cuánto).
- **ESFL**: entidad sin fines (ánimo) de lucro: asociación, fundación, ONG. "Admite ESFL" = puede ser beneficiaria.
- **Pasada / ejecución**: una vuelta completa del radar (`npm run radar`): fuentes → reglas → criba → ganadores → análisis → plazos →
  puntuación. Queda registrada con sus contadores, avisos, errores y coste (`/api/ejecuciones`).
- **Regla**: descarte determinista en código (`src/rules.ts`): nominativa o concesión directa, ámbito fuera del perfil, finalidad ajena.
- **Ámbito de actuación**: territorios (comunidad y, si no es entera, provincias) donde el proyecto puede ejecutarse; lo que cuenta es dónde se
  hace el proyecto, no la sede. Perfil `ambito.territorios`.
- **Condición**: lo que deja a una convocatoria "a medias": las autonómicas de una comunidad que solo vale en parte (p. ej. Castilla y León con
  Segovia y Ávila) entran solo si la criba confirma que admiten proyectos en esas provincias.
- **Consorcio**: convocatoria de la UE (Horizon Europe) a la que solo se va como socia de un consorcio; sección aparte en "Esta semana",
  con el esfuerzo penalizado (`consorcio` en `seed/puntuacion.json`).
- **Cascada (FSTP)**: convocatoria que abre un proyecto financiado por la UE (Horizon, LIFE, Digital Europe…) para dar subvenciones pequeñas a terceros (*financial support to third parties*).
  Una entidad sola se presenta, sin consorcio: va en el ranking principal con el chip «UE · en cascada». Fuente `eu_cascada`, id `cascada:<id>`; el territorio se comprueba como en las fundaciones.
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
- **Premio**: convocatoria de una fuente vigilada de tipo `premio` (premios medioambientales). Chip «Premio» en tarjeta y ficha; su importe es la dotación del
  premio y no cuenta cofinanciación en la puntuación.
- **Retirada**: convocatoria de fundación que ya no aparece en su página en dos revisiones seguidas.
- **Ficha**: la página de una convocatoria (`/convocatoria/:id`): datos de la fuente, criba, análisis con citas, plazo, puntuación,
  ganadores previos y enlaces.
- **Plazo**: fecha de cierre **literal** (la da la fuente), **calculada** (a partir de un texto como "15 días hábiles desde la publicación
  del extracto", con festivos) o **desconocida** (se muestra el texto original).

## Licitaciones

- **Licitación**: un contrato público de servicios u obras al que la entidad podría presentar oferta como adjudicataria (restauración, plantación, control de invasoras, charcas y humedales, educación ambiental y
  voluntariado, mantenimiento forestal). No es una subvención: tiene su página («Licitaciones»), su contador y su puntuación, y no se mezcla con las convocatorias de «Esta semana». Se guarda en la tabla
  `convocatorias` con fuente `placsp`, tipo `licitacion` e id `licitacion:<número de la entrada del feed>` (el expediente va en los datos: no es único entre órganos).
- **PLACSP**: Plataforma de Contratación del Sector Público. Su sindicación ATOM de datos abiertos (licitaciones de perfiles de contratante, formato CODICE) es la fuente `placsp` (`src/sources/placsp.ts`).
- **CPV**: vocabulario común de contratos públicos (p. ej. 77310000 plantación y mantenimiento de zonas verdes). El pre-filtro usa prefijos sin los ceros finales (`seed/licitaciones.json`).
- **Pre-filtro de licitaciones**: descarte en código, antes de guardar nada: estado «en plazo» (PUB), plazo de ofertas vigente, servicios u obras (no suministros ni concesiones), tema (un CPV de la lista o una palabra en el título) y
  lugar de ejecución (NUTS) dentro de los territorios del perfil. Lo que no pasa no se guarda; el recuento queda en los avisos de la fuente.
- **Cobertura del feed**: lo ya leído del feed de PLACSP, una ventana continua (`hasta`) más los **huecos** que dejó una pasada interrumpida (URL por la que seguir y límite inferior), en `fuente_estado`; la guarda el motor en la misma transacción que las licitaciones. La pasada diaria pagina hacia atrás hasta `hasta` y luego cierra los huecos, con tope de páginas y de bytes. `npm run licitaciones` rellena hacia atrás una vez.
- **Presupuesto base de licitación (sin IVA)**: lo que el órgano está dispuesto a pagar sin IVA; no es el **valor estimado** (con prórrogas y modificaciones). Con lotes, cuenta el del lote más pequeño (se puede ofertar a uno).
- **Probablemente fuera de escala**: presupuesto base sin IVA por encima del máximo del perfil (`licitaciones.presupuestoMaximo` del perfil; 300.000 € en la semilla, unas 3 veces los ingresos anuales por servicios). La criba lo descarta con ese motivo
  y, si pasa por lotes, la puntuación de escala vale 0.
- **Solvencia**: lo que el pliego exige para poder licitar: **económica** (volumen anual de negocio mínimo) y **técnica** (trabajos similares, medios). Se compara con los ingresos anuales del perfil (`licitaciones.ingresosAnuales`).
- **Reserva social**: contrato reservado a centros especiales de empleo de iniciativa social, empresas de inserción u otras entidades de economía social. Si la entidad no es de ese tipo, el análisis descarta la licitación.
- **PCAP / PPT**: pliego de cláusulas administrativas particulares y pliego de prescripciones técnicas, los PDF que el análisis lee (la Plataforma los rechaza a veces con «Request Rejected»: el análisis sigue con el anuncio).

## Puntuación y ranking

- **Puntuación**: 0–100, suma ponderada de cinco **factores** (encaje, importe, cierre, esfuerzo, probabilidad), cada uno con su
  explicación. Un dato desconocido nunca cuenta como bueno. Pesos en `seed/puntuacion.json`.
- **Puntuación de licitación**: 0–100 con otros cinco factores (`licitaciones` en `seed/puntuacion.json`): encaje del objeto con las líneas, escala del presupuesto, plazo de ofertas, viabilidad de la solvencia y peso del
  precio en la adjudicación (cuanto más pesan la memoria técnica y la calidad, mejor para una ONG).
- **Excluida**: no entra en el ranking aunque esté en juego: no admite ESFL, cerrada, o plazo desconocido tras 60 días.
- **Esta semana**: el ranking, en tres **secciones** excluyentes: cierran pronto, nuevas y abiertas; más la lista paralela "las ganan
  organizaciones como vosotros".
- **Serie / edición**: convocatorias del mismo órgano con el mismo título salvo el año ("… 2024", "… 2025") son ediciones de una serie.
  Los **ganadores previos** son los de las ediciones anteriores.
- **Predicción de apertura**: para una serie con al menos dos ediciones pasadas de las que se sabe cuándo abrieron (inicio de solicitudes o,
  si no, publicación en BDNS), la ventana en la que suele abrir la siguiente («suele abrir entre mediados de mayo y principios de junio»):
  el arco más corto del año que contiene esas aperturas. Es un hábito pasado, no una fecha anunciada; con menos de dos ediciones no se predice.
  Función pura (`src/prediccion.ts`), sin LLM.
- **Se espera que abran pronto**: sección plegada de «Esta semana» con las series relevantes (alguna edición pasó la criba, la última no la
  descartó el equipo) cuya ventana empieza en los próximos 60 días (`proximasDias`). Si la ventana del ciclo vigente ya pasó y la edición no ha
  aparecido, se marca «debería haber abierto ya; puede retrasarse o haberse suprimido». Las series con la edición de este ciclo (por fecha de apertura) o abandonadas (última apertura de hace más de ~18 meses) no salen.
- **Organización parecida**: entidad que ganó las mismas convocatorias que Reforesta (calculada) o añadida a mano. Sirve para la
  probabilidad y para **descubrir** convocatorias (origen "parecidas").

## Equipo

- **Decisión**: lo que el equipo marca en una convocatoria: **nos interesa** o **descartada** (con motivo). Reversible; sirve de ejemplo
  a los prompts de lo nuevo. Es privada con `TEAM_PASSWORD`.
- **Nota**: comentario del equipo en una convocatoria o una empresa.
- **Domicilio social**: dónde está registrada la entidad (municipio, provincia, comunidad, distrito opcional). La criba descarta las convocatorias que exigen sede,
  domicilio o inscripción en otro municipio o distrito. Perfil `domicilio`.
- **Perfil**: lo que el radar sabe de la organización (líneas de trabajo, ámbito, importe mínimo). Viene de `seed/perfil.json` y se
  edita en la web.

## Empresas

- **Empresa**: posible patrocinadora de proyectos de restauración. Una por nombre normalizado o CIF; solo personas jurídicas.
- **Señal**: cada motivo por el que una empresa aparece (una DIA, una fila del registro de huella, una compra de absorciones), con su cita y enlace.
- **DIA**: declaración (o informe) de impacto ambiental publicada en el BOE. Si obliga al promotor a restaurar o compensar, es una señal.
- **Nivel (tier) A / B**: del registro de huella de carbono del MITECO. A = compensa su huella (motivo concreto); B = gran empresa de un
  sector afín en la zona del perfil, sin compensación conocida (baja confianza, oculta por defecto). Las DIA van por delante de ambas.
- **Compra de absorción**: señal de una empresa que compensó su huella con créditos (tCO2) de un proyecto de absorción forestal, del listado de compensaciones del MITECO (origen `compra_absorcion`; sin LLM). Es un buen
  prospecto de RSC: ya paga por restauración. El motivo dice cuántas tCO2, cuándo, con qué proyecto y en qué provincia; la cita es la fila literal del registro. Compensar con un proyecto que la empresa misma promueve no cuenta como compra.
- **Proyecto de absorción**: proyecto forestal inscrito en el registro del MITECO (nombre, provincia, promotor, tCO2 previstas y retiradas). Se une a las compensaciones por su código; el promotor sale en el desplegable de la empresa.
- **Comprador relevante**: prioridad 2 (como el nivel A): compró en un proyecto dentro de los territorios del perfil, o hace menos de 2 años. Con una DIA además, sigue en 3. Sin NIF en el listado, se une a otras empresas solo por nombre con forma societaria y nunca con un CIF distinto.
- **Estado de empresa**: pendiente, contactada o descartada. Trabajo del equipo: privado con `TEAM_PASSWORD`.

## Coste y control

- **Tope**: máximo de algo por ejecución (análisis, peticiones, resoluciones). Lo que no cabe queda "sin hacer por el tope" para la siguiente.
- **Presupuesto**: techo en USD de todas las llamadas al LLM de una ejecución (`RADAR_PRESUPUESTO_USD`).
- **Huella de página**: hash del texto principal de una página de fundación, sin contadores ni horas: si no cambia, no se llama al LLM.
- **Backtest ("Cómo sabemos")**: medición con convocatorias pasadas: conjunto **(a)** las conocidas que Reforesta ganó o le interesaban y
  conjunto **(b)** las ganadas por organizaciones parecidas (descubrimiento).
