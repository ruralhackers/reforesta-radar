// Esquema SQLite (node:sqlite). Migraciones en orden; PRAGMA user_version guarda cuántas se aplicaron.
// Para cambiar el esquema, añade una migración al final: nunca edites una ya publicada.
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
