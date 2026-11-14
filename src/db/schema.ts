// Esquema SQLite (node:sqlite). Migraciones en orden; PRAGMA user_version guarda cuántas se aplicaron.
// Para cambiar el esquema, añade una migración al final: nunca edites una ya publicada.
//
// Quién escribe qué en una convocatoria:
// - `convocatorias`: lo que dicen la fuente y las reglas deterministas. Cada pasada del radar lo refresca
//   (guardarConvocatoria lista sus columnas una a una; nunca toca otras).
// - `convocatoria_fases`: el veredicto de cada fase posterior (criba LLM, análisis, decisión del equipo…),
//   una fila por convocatoria y fase. Ninguna pasada del radar la toca. Una fase nueva no necesita migración;
//   si necesita columnas propias, que cree su tabla con FK a convocatorias(id), no columnas en `convocatorias`.
//   Task 2 escribe `criba_llm` (Haiku: puede encajar / descartar + motivo) y `analisis` (Sonnet: campos con cita).
// - `documentos`, `textos`, `llm_cache`: cachés (por url, por hash de contenido y por hash de petición).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRACIONES: string[] = [
  `
  CREATE TABLE perfil (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    datos TEXT NOT NULL,              -- JSON de Perfil
    actualizado_en TEXT NOT NULL
  );
  CREATE TABLE organizaciones_parecidas (
    nif TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    origen TEXT NOT NULL DEFAULT 'semilla'  -- semilla | derivada | manual
  );
  CREATE TABLE fundaciones (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE,
    url TEXT,
    notas TEXT,
    activa INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE convocatorias (
    id TEXT PRIMARY KEY,              -- fuente:fuente_id
    fuente TEXT NOT NULL,
    fuente_id TEXT NOT NULL,
    titulo TEXT NOT NULL,
    organo_nivel1 TEXT NOT NULL,
    organo_nivel2 TEXT,
    organo_nivel3 TEXT,
    fecha_publicacion TEXT NOT NULL,  -- YYYY-MM-DD
    url TEXT NOT NULL,
    tipo TEXT,
    finalidad TEXT,
    regiones TEXT NOT NULL DEFAULT '[]',
    abierto INTEGER,
    descarte_regla TEXT,              -- null = candidata
    descarte_motivo TEXT,
    datos TEXT NOT NULL,              -- JSON original de la fuente
    primera_vez TEXT NOT NULL,
    ultima_vez TEXT NOT NULL
  );
  CREATE INDEX convocatorias_fecha ON convocatorias (fecha_publicacion);
  CREATE INDEX convocatorias_descarte ON convocatorias (descarte_regla);
  CREATE TABLE ejecuciones (
    id INTEGER PRIMARY KEY,
    inicio TEXT NOT NULL,
    fin TEXT,
    estado TEXT NOT NULL              -- en_curso | ok | con_errores
  );
  CREATE TABLE ejecucion_fuentes (
    ejecucion_id INTEGER NOT NULL REFERENCES ejecuciones (id),
    fuente TEXT NOT NULL,
    inicio TEXT NOT NULL,
    fin TEXT,
    recibidas INTEGER NOT NULL DEFAULT 0,
    nuevas INTEGER NOT NULL DEFAULT 0,
    candidatas INTEGER NOT NULL DEFAULT 0,
    descartadas INTEGER NOT NULL DEFAULT 0,
    errores TEXT NOT NULL DEFAULT '[]', -- JSON string[]
    PRIMARY KEY (ejecucion_id, fuente)
  );
  `,
  `
  ALTER TABLE ejecuciones ADD COLUMN error TEXT; -- fallo general (no de una fuente) que cortó la ejecución
  CREATE TABLE convocatoria_fases (
    convocatoria_id TEXT NOT NULL REFERENCES convocatorias (id),
    fase TEXT NOT NULL,                 -- criba_llm | analisis | equipo | …
    descarta INTEGER NOT NULL DEFAULT 0, -- 1 = esta fase la saca de las candidatas
    motivo TEXT,
    datos TEXT NOT NULL DEFAULT '{}',   -- JSON propio de la fase
    actualizado_en TEXT NOT NULL,
    PRIMARY KEY (convocatoria_id, fase)
  );
  `,
  `
  -- Condición de las reglas (p. ej. otra comunidad: solo si no exige sede). La refresca cada pasada, como descarte_*.
  -- Una candidata con condición no sale en las listas hasta que la criba LLM la da por buena.
  ALTER TABLE convocatorias ADD COLUMN condicion TEXT;
  -- Caché de documentos: url → hash del contenido (no se vuelve a descargar) y hash → texto (no se vuelve a extraer).
  CREATE TABLE documentos (
    url TEXT PRIMARY KEY,
    hash TEXT,                          -- sha256 del contenido; null si la descarga falló
    tipo TEXT,                          -- pdf | html | texto
    error TEXT,
    descargado_en TEXT NOT NULL
  );
  CREATE TABLE textos (
    hash TEXT PRIMARY KEY,
    texto TEXT NOT NULL,
    paginas INTEGER,
    creado_en TEXT NOT NULL
  );
  -- Caché de respuestas del LLM por hash de la petición (modelo + prompt + esquema):
  -- la misma entrada (mismos textos) no se vuelve a enviar.
  CREATE TABLE llm_cache (
    clave TEXT PRIMARY KEY,
    modelo TEXT NOT NULL,
    respuesta TEXT NOT NULL,            -- JSON
    creado_en TEXT NOT NULL
  );
  -- Registro por ejecución de cada fase posterior (criba LLM, análisis): contadores, tokens, coste, avisos y errores.
  CREATE TABLE ejecucion_fases (
    ejecucion_id INTEGER NOT NULL REFERENCES ejecuciones (id),
    fase TEXT NOT NULL,
    modelo TEXT,
    procesadas INTEGER NOT NULL DEFAULT 0,  -- con veredicto nuevo en esta ejecución
    descartadas INTEGER NOT NULL DEFAULT 0,
    omitidas_por_tope INTEGER NOT NULL DEFAULT 0,
    llamadas INTEGER NOT NULL DEFAULT 0,    -- llamadas reales al LLM (sin contar la caché)
    desde_cache INTEGER NOT NULL DEFAULT 0,
    tokens_entrada INTEGER NOT NULL DEFAULT 0,
    tokens_salida INTEGER NOT NULL DEFAULT 0,
    tokens_cache_lectura INTEGER NOT NULL DEFAULT 0,
    tokens_cache_escritura INTEGER NOT NULL DEFAULT 0,
    coste_usd REAL NOT NULL DEFAULT 0,
    avisos TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
    errores TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
    PRIMARY KEY (ejecucion_id, fase)
  );
  `,
  `
  -- Fallos pasajeros seguidos al descargar un documento (se pone a 0 al descargarlo bien). Pasado un límite,
  -- el fallo cuenta como definitivo y el análisis sigue sin ese documento.
  ALTER TABLE documentos ADD COLUMN fallos INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Plazo de solicitud (fase determinista, sin LLM; se recalcula en cada ejecución). Una fila por convocatoria.
  CREATE TABLE plazos (
    convocatoria_id TEXT PRIMARY KEY REFERENCES convocatorias (id),
    fecha_cierre TEXT,                  -- YYYY-MM-DD; null = desconocida
    tipo TEXT NOT NULL,                 -- literal | calculada | desconocida
    texto_original TEXT,
    fecha_base TEXT,                    -- día de publicación desde el que se contó (calculada)
    base_origen TEXT,                   -- extracto | registro
    aproximada INTEGER NOT NULL DEFAULT 0,
    detalle TEXT NOT NULL,
    calculado_en TEXT NOT NULL
  );
  CREATE INDEX plazos_cierre ON plazos (fecha_cierre);
  `,
  `
  -- Puntuación explicable 0-100 (fase determinista, sin LLM; se recalcula en cada ejecución). Una fila por convocatoria.
  CREATE TABLE puntuaciones (
    convocatoria_id TEXT PRIMARY KEY REFERENCES convocatorias (id),
    total INTEGER NOT NULL,
    excluida TEXT,                      -- motivo si no entra en el ranking (no admite ESFL, cerrada); null = entra
    analizada INTEGER NOT NULL,
    factores TEXT NOT NULL,             -- JSON Factor[]: id, nombre, peso, subpuntuacion, conocido, explicacion
    calculado_en TEXT NOT NULL
  );
  `,
  `
  -- Concesiones de BDNS (ganadores), solo desde 2022. Una fila por concesión (id de BDNS). Las de una convocatoria se
  -- reemplazan enteras al volver a consultarla; las de Reforesta por NIF solo se añaden o actualizan.
  CREATE TABLE concesiones (
    id INTEGER PRIMARY KEY,
    numero_convocatoria TEXT NOT NULL,
    nif TEXT,                           -- null = persona anonimizada o sin NIF
    nombre TEXT NOT NULL,
    es_persona INTEGER NOT NULL,
    beneficiario TEXT NOT NULL,         -- tal y como viene de BDNS
    importe REAL,
    fecha_concesion TEXT,
    titulo TEXT NOT NULL,
    organo_nivel1 TEXT,
    organo_nivel2 TEXT,
    organo_nivel3 TEXT,
    url_bases TEXT,
    actualizado_en TEXT NOT NULL
  );
  CREATE INDEX concesiones_convocatoria ON concesiones (numero_convocatoria);
  CREATE INDEX concesiones_nif ON concesiones (nif);
  -- Qué se ha consultado y cuándo (clave "conv:<número>", "nif:<NIF>" o "serie:<clave>"), para no repetir la consulta cada ejecución.
  CREATE TABLE consultas_concesiones (
    clave TEXT PRIMARY KEY,
    consultado_en TEXT NOT NULL,
    total INTEGER NOT NULL
  );
  -- Ediciones de series de convocatorias que se repiten (mismo órgano y título salvo el año).
  CREATE TABLE ediciones_serie (
    numero_convocatoria TEXT PRIMARY KEY,
    serie TEXT NOT NULL,
    titulo TEXT NOT NULL,
    anio INTEGER,
    fecha TEXT
  );
  CREATE INDEX ediciones_serie_serie ON ediciones_serie (serie);
  -- Organizaciones parecidas: origen semilla | calculada | manual (derivada = antiguo). "activa = 0" la desactiva
  -- (el recálculo no la toca); las manuales nunca se borran ni se sobrescriben.
  ALTER TABLE organizaciones_parecidas ADD COLUMN activa INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE organizaciones_parecidas ADD COLUMN coincidencias INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE organizaciones_parecidas ADD COLUMN evidencia TEXT NOT NULL DEFAULT '[]';  -- JSON: números de convocatoria ganados junto a Reforesta
  ALTER TABLE organizaciones_parecidas ADD COLUMN actualizado_en TEXT;
  `,
  `
  -- Descubrimiento por organizaciones parecidas. Lo que han ganado las parecidas activas (una fila por organización y
  -- convocatoria; se reemplaza al reconsultar su NIF), de qué parecida viene cada candidata (se reconstruye en cada
  -- ejecución desde lo guardado, así desactivar una organización retira sus etiquetas) y qué candidatas se guardaron
  -- SOLO por este camino (la fuente directa las desmarca si luego las trae).
  CREATE TABLE ganadas_parecidas (
    nif TEXT NOT NULL,
    numero_convocatoria TEXT NOT NULL,
    titulo TEXT NOT NULL,
    organo_nivel1 TEXT,
    organo_nivel2 TEXT,
    organo_nivel3 TEXT,
    fecha_concesion TEXT,
    importe REAL,
    PRIMARY KEY (nif, numero_convocatoria)
  );
  CREATE TABLE origenes_convocatoria (
    convocatoria_id TEXT NOT NULL REFERENCES convocatorias (id),
    origen TEXT NOT NULL,                -- 'parecidas'
    nif TEXT NOT NULL,                   -- la parecida que ganó la edición anterior
    nombre TEXT NOT NULL,
    numero_previo TEXT NOT NULL,         -- número BDNS de esa edición anterior
    anio_previo INTEGER,
    PRIMARY KEY (convocatoria_id, origen, nif, numero_previo)
  );
  CREATE TABLE descubiertas_parecidas (
    convocatoria_id TEXT PRIMARY KEY REFERENCES convocatorias (id)
  );
  `,
  `
  -- El texto de búsqueda de ediciones cambió (hasta el primer año, no el título sin año): lo cacheado con el anterior,
  -- sobre todo las búsquedas con 0 resultados, no vale. Se vuelven a hacer.
  DELETE FROM consultas_concesiones WHERE clave LIKE 'serie:%';
  `,
  `
  -- Decisiones del equipo y notas: tablas propias. Ninguna pasada del radar las toca (ni las reglas ni las fases).
  CREATE TABLE decisiones (
    convocatoria_id TEXT PRIMARY KEY REFERENCES convocatorias (id),
    decision TEXT NOT NULL CHECK (decision IN ('nos_interesa', 'descartada')),
    motivo TEXT,                         -- solo al descartar (uno de los motivos de un clic, o 'Otro')
    detalle TEXT,                        -- texto libre (obligatorio con 'Otro')
    decidida_en TEXT NOT NULL
  );
  CREATE INDEX decisiones_por_fecha ON decisiones (decidida_en);
  CREATE TABLE notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    convocatoria_id TEXT NOT NULL REFERENCES convocatorias (id),
    texto TEXT NOT NULL,
    autor TEXT,
    creada_en TEXT NOT NULL
  );
  CREATE INDEX notas_por_convocatoria ON notas (convocatoria_id, creada_en);
  `,
  `
  -- Registro de los correos del resumen semanal: cuándo, a cuántos, qué convocatorias y el id del proveedor o el error.
  -- semana (ISO, p. ej. 2026-W47) con error NULL = ya enviado esa semana (idempotencia).
  CREATE TABLE envios_resumen (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    semana TEXT NOT NULL,
    enviado_en TEXT NOT NULL,
    destinatarios INTEGER NOT NULL,
    convocatorias TEXT NOT NULL,         -- JSON: ids incluidos
    proveedor_id TEXT,
    error TEXT
  );
  CREATE INDEX envios_resumen_por_semana ON envios_resumen (semana);
  `,
  `
  -- Fundaciones y agregadores vigilados: tipo, huella del último texto principal leído (si no cambia, no hay llamada al LLM),
  -- cuándo cambió, cuándo se revisó por última vez y el último error (NULL = la última lectura fue bien).
  ALTER TABLE fundaciones ADD COLUMN tipo TEXT NOT NULL DEFAULT 'fundacion' CHECK (tipo IN ('fundacion', 'agregador'));
  ALTER TABLE fundaciones ADD COLUMN huella TEXT;
  ALTER TABLE fundaciones ADD COLUMN ultimo_cambio TEXT;
  ALTER TABLE fundaciones ADD COLUMN ultima_revision TEXT;
  ALTER TABLE fundaciones ADD COLUMN ultimo_error TEXT;
  `,
  `
  -- Empresas con obligación legal de restaurar (DIA del BOE con medidas compensatorias). Una fila por empresa (clave = CIF si
  -- consta, si no el nombre normalizado); cada DIA es una señal enlazada. Solo datos de la empresa: nunca personas de contacto.
  -- estado y nota son del equipo (las escrituras van tras el acceso del equipo; la lectura pública no incluye la nota).
  CREATE TABLE empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clave TEXT NOT NULL UNIQUE,            -- nombre normalizado (sin acentos ni forma societaria) para unir duplicados
    nombre TEXT NOT NULL,
    cif TEXT UNIQUE,
    origen TEXT NOT NULL,                  -- 'dia_boe'
    motivo TEXT NOT NULL,                  -- una línea
    cita TEXT NOT NULL,                    -- literal de la DIA
    enlace TEXT NOT NULL,                  -- DIA en el BOE
    provincia TEXT,
    pagina_rsc TEXT,                       -- página pública de RSC o fundación (aún sin rellenar)
    primera_vez_vista TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'contactada', 'descartada')),
    nota TEXT,
    actualizada_en TEXT
  );
  CREATE INDEX empresas_por_primera_vez ON empresas (primera_vez_vista);
  CREATE TABLE empresa_senales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas (id),
    tipo TEXT NOT NULL,                    -- 'dia_boe'
    boe_id TEXT NOT NULL,
    titulo TEXT NOT NULL,                  -- título oficial de la resolución
    proyecto TEXT,
    provincia TEXT,
    motivo TEXT NOT NULL,
    medidas TEXT NOT NULL,                 -- JSON: [{ tipo, cita }] con cita comprobada contra el texto
    enlace TEXT NOT NULL,
    fecha_publicacion TEXT NOT NULL,
    vista_en TEXT NOT NULL,
    UNIQUE (empresa_id, boe_id)
  );
  CREATE INDEX empresa_senales_por_empresa ON empresa_senales (empresa_id);
  -- Qué resoluciones del BOE ya se leyeron (con el resultado) y qué días ya se revisaron del todo.
  CREATE TABLE dia_boe_procesadas (
    boe_id TEXT PRIMARY KEY,
    fecha TEXT NOT NULL,
    titulo TEXT NOT NULL,
    resultado TEXT NOT NULL CHECK (resultado IN ('con_medidas', 'sin_medidas', 'sin_promotor', 'desfavorable')),
    procesada_en TEXT NOT NULL
  );
  CREATE TABLE boe_dias (
    fecha TEXT PRIMARY KEY,
    revisado_en TEXT NOT NULL
  );
  `,
  // 14: registro de huella de carbono del MITECO (segunda fuente del canal de empresas)
  `
  -- Registro de huella de carbono (MITECO): organizaciones ya cribadas (por el hash de lo que el registro dice de ellas; si cambia, se vuelve a cribar)
  -- y versión de cada fichero del registro ya recorrida entera (si no cambia y no queda nada pendiente, no se vuelve a bajar).
  CREATE TABLE huella_cribadas (
    hash TEXT PRIMARY KEY,
    clave TEXT NOT NULL,                   -- NIF o nombre normalizado de la organización
    nombre TEXT NOT NULL,
    resultado TEXT NOT NULL CHECK (resultado IN ('financiador', 'descartada')),
    cribada_en TEXT NOT NULL
  );
  CREATE INDEX huella_cribadas_por_clave ON huella_cribadas (clave);
  CREATE TABLE huella_ficheros (
    url TEXT PRIMARY KEY,
    firma TEXT NOT NULL,
    completo INTEGER NOT NULL DEFAULT 0,
    revisado_en TEXT NOT NULL
  );
  `,
  // 15: prioridad de las empresas (3 = DIA del BOE, 2 = registro con compensación, 1 = registro solo por zona y sector, baja confianza)
  `
  ALTER TABLE empresas ADD COLUMN prioridad INTEGER NOT NULL DEFAULT 0;
  -- Recalculada con lo guardado: con señal de DIA → 3; con compensación o sello COMPENSO en la cita → 2; el resto del registro → 1.
  UPDATE empresas SET prioridad = CASE
    WHEN origen = 'dia_boe' OR EXISTS (SELECT 1 FROM empresa_senales s WHERE s.empresa_id = empresas.id AND s.tipo = 'dia_boe') THEN 3
    WHEN cita LIKE '%COMPENSACIÓN:%' OR cita LIKE '%SELLO: %COMPENSO%' THEN 2
    ELSE 1 END;
  CREATE INDEX empresas_por_prioridad ON empresas (prioridad DESC, primera_vez_vista DESC);
  -- Motivos del registro demasiado largos (de antes de acortarlos): se quedan con la primera frase, o con 200 caracteres.
  UPDATE empresas SET motivo = CASE WHEN instr(motivo, '. ') BETWEEN 1 AND 200 THEN substr(motivo, 1, instr(motivo, '. ')) ELSE substr(motivo, 1, 199) || '…' END
    WHERE origen = 'huella_carbono' AND length(motivo) > 200;
  UPDATE empresa_senales SET motivo = CASE WHEN instr(motivo, '. ') BETWEEN 1 AND 200 THEN substr(motivo, 1, instr(motivo, '. ')) ELSE substr(motivo, 1, 199) || '…' END
    WHERE tipo = 'huella_carbono' AND length(motivo) > 200;
  -- Que la próxima ejecución recorra el registro entero con los criterios nuevos (la cola de la criba se rehace por hash).
  DELETE FROM huella_ficheros;
  `,
  // 16: la prioridad de una empresa se deriva de sus señales (la de cada señal se guarda aparte) y las empresas sin forma jurídica pueden quedar ocultas
  `
  ALTER TABLE empresa_senales ADD COLUMN prioridad INTEGER NOT NULL DEFAULT 0;
  UPDATE empresa_senales SET prioridad = CASE
    WHEN tipo = 'dia_boe' THEN 3
    WHEN EXISTS (SELECT 1 FROM empresas e WHERE e.id = empresa_senales.empresa_id AND (e.cita LIKE '%COMPENSACIÓN:%' OR e.cita LIKE '%SELLO: %COMPENSO%')) THEN 2
    ELSE 1 END;
  ALTER TABLE empresas ADD COLUMN oculta TEXT;   -- motivo por el que no se muestra (p. ej. 'sin forma jurídica'); NULL = visible
  `,
];

export function migrar(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRACIONES.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRACIONES[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Abre (o crea) la BD y la deja migrada. `:memory:` para pruebas. */
export function abrirBd(ruta: string): DatabaseSync {
  if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrar(db);
  return db;
}
