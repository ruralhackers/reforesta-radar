// Acceso a datos. Funciones pequeñas sobre DatabaseSync; nada de lógica de negocio.
import type { DatabaseSync } from 'node:sqlite';
import type { Cribada, Perfil, Semilla } from '../types.ts';

export function transaccion<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// --- Perfil y semilla ---

export function leerPerfil(db: DatabaseSync): Perfil | null {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  return fila ? (JSON.parse(fila.datos) as Perfil) : null;
}

export function guardarSemilla(db: DatabaseSync, s: Semilla, ahora: Date): void {
  transaccion(db, () => {
    db.prepare('INSERT INTO perfil (id, datos, actualizado_en) VALUES (1, ?, ?)').run(JSON.stringify(s.perfil), ahora.toISOString());
    const org = db.prepare("INSERT OR IGNORE INTO organizaciones_parecidas (nif, nombre, origen) VALUES (?, ?, 'semilla')");
    for (const o of s.organizacionesParecidas) org.run(o.nif, o.nombre);
    const fun = db.prepare('INSERT OR IGNORE INTO fundaciones (nombre, url, notas) VALUES (?, ?, ?)');
    for (const f of s.fundaciones) fun.run(f.nombre, f.url, f.notas);
  });
}

// --- Convocatorias ---

/**
 * Inserta o actualiza lo que dicen la fuente y las reglas deterministas. Devuelve true si era nueva.
 * Conserva `primera_vez` y no toca el estado de fases posteriores (`convocatoria_fases`).
 */
export function guardarConvocatoria(db: DatabaseSync, { convocatoria: c, descarte }: Cribada, ahora: Date): boolean {
  const existe = db.prepare('SELECT 1 FROM convocatorias WHERE id = ?').get(c.id) !== undefined;
  const t = ahora.toISOString();
  db.prepare(`
    INSERT INTO convocatorias (id, fuente, fuente_id, titulo, organo_nivel1, organo_nivel2, organo_nivel3, fecha_publicacion,
      url, tipo, finalidad, regiones, abierto, descarte_regla, descarte_motivo, datos, primera_vez, ultima_vez)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      titulo = excluded.titulo, organo_nivel1 = excluded.organo_nivel1, organo_nivel2 = excluded.organo_nivel2,
      organo_nivel3 = excluded.organo_nivel3, fecha_publicacion = excluded.fecha_publicacion, url = excluded.url,
      tipo = excluded.tipo, finalidad = excluded.finalidad, regiones = excluded.regiones, abierto = excluded.abierto,
      descarte_regla = excluded.descarte_regla, descarte_motivo = excluded.descarte_motivo, datos = excluded.datos,
      ultima_vez = excluded.ultima_vez
  `).run(
    c.id, c.fuente, c.fuenteId, c.titulo, c.organo.nivel1, c.organo.nivel2, c.organo.nivel3, c.fechaPublicacion,
    c.url, c.tipo, c.finalidad, JSON.stringify(c.regiones), c.abierto === null ? null : Number(c.abierto),
    descarte?.regla ?? null, descarte?.motivo ?? null, JSON.stringify(c.datos), t, t,
  );
  return !existe;
}

// --- Fases posteriores (criba LLM, análisis, decisión del equipo…) ---

export interface VeredictoFase {
  convocatoriaId: string;
  fase: string;
  /** true = esta fase la saca de las candidatas. */
  descarta: boolean;
  motivo: string | null;
  datos?: unknown;
}

export function guardarFase(db: DatabaseSync, v: VeredictoFase, ahora: Date): void {
  db.prepare(`
    INSERT INTO convocatoria_fases (convocatoria_id, fase, descarta, motivo, datos, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (convocatoria_id, fase) DO UPDATE SET
      descarta = excluded.descarta, motivo = excluded.motivo, datos = excluded.datos, actualizado_en = excluded.actualizado_en
  `).run(v.convocatoriaId, v.fase, Number(v.descarta), v.motivo, JSON.stringify(v.datos ?? {}), ahora.toISOString());
}

export function leerFases(db: DatabaseSync, convocatoriaId: string): VeredictoFase[] {
  const filas = db.prepare('SELECT fase, descarta, motivo, datos FROM convocatoria_fases WHERE convocatoria_id = ? ORDER BY fase')
    .all(convocatoriaId) as { fase: string; descarta: number; motivo: string | null; datos: string }[];
  return filas.map((f) => ({ convocatoriaId, fase: f.fase, descarta: f.descarta === 1, motivo: f.motivo, datos: JSON.parse(f.datos) }));
}

export interface FilaConvocatoria {
  id: string;
  fuente: string;
  titulo: string;
  organo: string;
  fechaPublicacion: string;
  url: string;
}

/** Candidatas (sin descarte de reglas ni de ninguna fase) publicadas entre dos días incluidos, más recientes primero. */
export function candidatasEntre(db: DatabaseSync, desde: string, hasta: string): FilaConvocatoria[] {
  const filas = db.prepare(`
    SELECT id, fuente, titulo, organo_nivel1, organo_nivel2, organo_nivel3, fecha_publicacion, url
    FROM convocatorias c
    WHERE descarte_regla IS NULL AND fecha_publicacion BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.descarta = 1)
    ORDER BY fecha_publicacion DESC, id DESC
  `).all(desde, hasta) as Record<string, string | null>[];
  return filas.map((f) => ({
    id: f.id!,
    fuente: f.fuente!,
    titulo: f.titulo!,
    organo: [f.organo_nivel2, f.organo_nivel3].filter(Boolean).join(' · ') || f.organo_nivel1!,
    fechaPublicacion: f.fecha_publicacion!,
    url: f.url!,
  }));
}

// --- Registro de ejecuciones ---

export interface ContadoresFuente {
  recibidas: number;
  nuevas: number;
  candidatas: number;
  descartadas: number;
}

export function empezarEjecucion(db: DatabaseSync, ahora: Date): number {
  const r = db.prepare("INSERT INTO ejecuciones (inicio, estado) VALUES (?, 'en_curso')").run(ahora.toISOString());
  return Number(r.lastInsertRowid);
}

export function empezarFuente(db: DatabaseSync, ejecucionId: number, fuente: string, ahora: Date): void {
  db.prepare('INSERT INTO ejecucion_fuentes (ejecucion_id, fuente, inicio) VALUES (?, ?, ?)').run(ejecucionId, fuente, ahora.toISOString());
}

export function terminarFuente(
  db: DatabaseSync, ejecucionId: number, fuente: string, ahora: Date, n: ContadoresFuente, errores: string[],
): void {
  db.prepare(`
    UPDATE ejecucion_fuentes SET fin = ?, recibidas = ?, nuevas = ?, candidatas = ?, descartadas = ?, errores = ?
    WHERE ejecucion_id = ? AND fuente = ?
  `).run(ahora.toISOString(), n.recibidas, n.nuevas, n.candidatas, n.descartadas, JSON.stringify(errores), ejecucionId, fuente);
}

export function terminarEjecucion(db: DatabaseSync, ejecucionId: number, ahora: Date, conErrores: boolean, error: string | null = null): void {
  db.prepare('UPDATE ejecuciones SET fin = ?, estado = ?, error = ? WHERE id = ?')
    .run(ahora.toISOString(), conErrores || error ? 'con_errores' : 'ok', error, ejecucionId);
}

export interface Ejecucion {
  id: number;
  inicio: string;
  fin: string | null;
  estado: string;
  /** Fallo general que cortó la ejecución (no de una fuente concreta). */
  error: string | null;
  fuentes: (ContadoresFuente & { fuente: string; inicio: string; fin: string | null; errores: string[] })[];
}

export function ultimasEjecuciones(db: DatabaseSync, limite: number): Ejecucion[] {
  const ejecuciones = db.prepare('SELECT id, inicio, fin, estado, error FROM ejecuciones ORDER BY id DESC LIMIT ?').all(limite) as unknown as Omit<Ejecucion, 'fuentes'>[];
  const fuentes = db.prepare(`
    SELECT fuente, inicio, fin, recibidas, nuevas, candidatas, descartadas, errores
    FROM ejecucion_fuentes WHERE ejecucion_id = ? ORDER BY fuente
  `);
  return ejecuciones.map((e) => ({
    ...e,
    fuentes: (fuentes.all(e.id) as unknown as (Omit<Ejecucion['fuentes'][number], 'errores'> & { errores: string })[]).map((f) => ({
      ...f,
      errores: JSON.parse(f.errores) as string[],
    })),
  }));
}
