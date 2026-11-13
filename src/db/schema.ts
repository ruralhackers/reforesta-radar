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
