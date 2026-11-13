// Decisiones del equipo (nos interesa / descartada + motivo) y notas. Tablas propias: ninguna pasada del radar las modifica.
// Aquí viven también las lecturas privadas que Task 9 esconderá si hay TEAM_PASSWORD.
import type { DatabaseSync } from 'node:sqlite';
import { leerPlazo } from './repo.ts';

export type Decision = 'nos_interesa' | 'descartada';

/** Motivos de un clic para descartar. "Otro" exige texto libre. */
export const MOTIVOS_DESCARTE = [
  'No encaja con nuestras líneas',
  'Importe demasiado bajo',
  'Plazo imposible',
  'Requisitos que no cumplimos',
  'Ya presentada',
  'Otro',
] as const;

export interface DecisionGuardada {
  convocatoriaId: string;
  decision: Decision;
  motivo: string | null;
  detalle: string | null;
  decididaEn: string;
}

export interface Nota {
  id: number;
  convocatoriaId: string;
  texto: string;
  autor: string | null;
  creadaEn: string;
}

export class ErrorDecision extends Error {
  estado: 400 | 404;
  constructor(mensaje: string, estado: 400 | 404 = 400) { super(mensaje); this.estado = estado; }
}

const aDecision = (f: Record<string, unknown>): DecisionGuardada => ({
  convocatoriaId: String(f.convocatoria_id), decision: f.decision as Decision, motivo: (f.motivo as string | null) ?? null,
  detalle: (f.detalle as string | null) ?? null, decididaEn: String(f.decidida_en),
});

const existe = (db: DatabaseSync, id: string) => db.prepare('SELECT 1 FROM convocatorias WHERE id = ?').get(id) !== undefined;

/** Valida y guarda (o cambia) la decisión. Descartar exige un motivo de la lista; "Otro" exige texto libre. */
export function decidir(db: DatabaseSync, id: string, cuerpo: unknown, ahora: Date): DecisionGuardada {
  const o = (cuerpo ?? {}) as Record<string, unknown>;
  if (o.decision !== 'nos_interesa' && o.decision !== 'descartada') throw new ErrorDecision('"decision" debe ser "nos_interesa" o "descartada"');
  if (!existe(db, id)) throw new ErrorDecision('No existe esa convocatoria', 404);
  let motivo: string | null = null;
  let detalle: string | null = null;
  if (o.decision === 'descartada') {
    if (typeof o.motivo !== 'string' || !(MOTIVOS_DESCARTE as readonly string[]).includes(o.motivo)) throw new ErrorDecision(`Falta el motivo: ${MOTIVOS_DESCARTE.join(', ')}`);
    motivo = o.motivo;
    if (o.detalle !== undefined && o.detalle !== null && typeof o.detalle !== 'string') throw new ErrorDecision('"detalle" debe ser texto');
    detalle = typeof o.detalle === 'string' && o.detalle.trim() ? o.detalle.trim().slice(0, 500) : null;
    if (motivo === 'Otro' && !detalle) throw new ErrorDecision('Con el motivo "Otro" hay que escribir cuál');
  }
  db.prepare(`
    INSERT INTO decisiones (convocatoria_id, decision, motivo, detalle, decidida_en) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (convocatoria_id) DO UPDATE SET decision = excluded.decision, motivo = excluded.motivo, detalle = excluded.detalle, decidida_en = excluded.decidida_en
  `).run(id, o.decision, motivo, detalle, ahora.toISOString());
  return leerDecision(db, id)!;
}

/** Deshace la decisión (la convocatoria vuelve a su estado normal). false si no había. */
export function deshacerDecision(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM decisiones WHERE convocatoria_id = ?').run(id).changes) > 0;
}

export function leerDecision(db: DatabaseSync, id: string): DecisionGuardada | null {
  const f = db.prepare('SELECT * FROM decisiones WHERE convocatoria_id = ?').get(id) as Record<string, unknown> | undefined;
  return f ? aDecision(f) : null;
}

export function leerDecisiones(db: DatabaseSync): DecisionGuardada[] {
  return (db.prepare('SELECT * FROM decisiones ORDER BY decidida_en DESC, convocatoria_id').all() as Record<string, unknown>[]).map(aDecision);
}

export function anadirNota(db: DatabaseSync, id: string, cuerpo: unknown, ahora: Date): Nota {
  const o = (cuerpo ?? {}) as Record<string, unknown>;
  if (typeof o.texto !== 'string' || !o.texto.trim()) throw new ErrorDecision('La nota está vacía');
  if (o.autor !== undefined && o.autor !== null && typeof o.autor !== 'string') throw new ErrorDecision('"autor" debe ser texto');
  if (!existe(db, id)) throw new ErrorDecision('No existe esa convocatoria', 404);
  const autor = typeof o.autor === 'string' && o.autor.trim() ? o.autor.trim().slice(0, 80) : null;
  const r = db.prepare('INSERT INTO notas (convocatoria_id, texto, autor, creada_en) VALUES (?, ?, ?, ?)').run(id, o.texto.trim().slice(0, 2000), autor, ahora.toISOString());
  return leerNotas(db, id).find((n) => n.id === Number(r.lastInsertRowid))!;
}

export function borrarNota(db: DatabaseSync, id: string, notaId: number): boolean {
  return Number(db.prepare('DELETE FROM notas WHERE id = ? AND convocatoria_id = ?').run(notaId, id).changes) > 0;
}

/** Notas de una convocatoria, de la más antigua a la más reciente. */
export function leerNotas(db: DatabaseSync, id: string): Nota[] {
  return (db.prepare('SELECT * FROM notas WHERE convocatoria_id = ? ORDER BY creada_en, id').all(id) as Record<string, unknown>[])
    .map((f) => ({ id: Number(f.id), convocatoriaId: String(f.convocatoria_id), texto: String(f.texto), autor: (f.autor as string | null) ?? null, creadaEn: String(f.creada_en) }));
}

export interface NosInteresa {
  id: string;
  titulo: string;
  organo: string;
  url: string;
  decididaEn: string;
  fechaCierre: string | null;
  /** Negativo = ya cerrada; null = plazo desconocido. */
  diasHastaCierre: number | null;
}

/** "Nos interesa" por plazo: la que cierra antes primero y las de plazo desconocido al final (las ya cerradas conservan su lugar por fecha). */
export function nosInteresa(db: DatabaseSync, hoy: string): NosInteresa[] {
  const filas = db.prepare(`
    SELECT c.id, c.titulo, c.organo_nivel1, c.organo_nivel2, c.organo_nivel3, c.url, d.decidida_en
    FROM decisiones d JOIN convocatorias c ON c.id = d.convocatoria_id WHERE d.decision = 'nos_interesa'
  `).all() as Record<string, string | null>[];
  return filas.map((f) => {
    const plazo = leerPlazo(db, f.id!, hoy);
    return {
      id: f.id!, titulo: f.titulo!, url: f.url!, decididaEn: f.decidida_en!,
      organo: [f.organo_nivel2, f.organo_nivel3].filter(Boolean).join(' · ') || String(f.organo_nivel1),
      fechaCierre: plazo?.fechaCierre ?? null, diasHastaCierre: plazo?.diasHastaCierre ?? null,
    };
  }).sort((a, b) => (a.fechaCierre ?? '9999').localeCompare(b.fechaCierre ?? '9999') || a.id.localeCompare(b.id));
}

// --- Aprendizaje ligero: las últimas decisiones como ejemplos para los prompts de las convocatorias NUEVAS ---

export interface EjemploDecision {
  decision: Decision;
  motivo: string | null;
  titulo: string;
  organo: string;
  resumen: string | null;
}

const recortar = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Las últimas `max` decisiones (más recientes primero) con título, órgano y resumen corto (finalidad o tipo). */
export function ejemplosDecisiones(db: DatabaseSync, max: number): EjemploDecision[] {
  if (max <= 0) return [];
  const filas = db.prepare(`
    SELECT d.decision, d.motivo, d.detalle, c.titulo, c.organo_nivel1, c.organo_nivel2, c.organo_nivel3, c.finalidad, c.tipo
    FROM decisiones d JOIN convocatorias c ON c.id = d.convocatoria_id ORDER BY d.decidida_en DESC, d.convocatoria_id LIMIT ?
  `).all(max) as Record<string, string | null>[];
  return filas.map((f) => ({
    decision: f.decision as Decision,
    motivo: f.decision === 'descartada' ? (f.motivo === 'Otro' ? (f.detalle ?? 'Otro') : [f.motivo, f.detalle].filter(Boolean).join(': ')) : null,
    titulo: recortar(f.titulo!, 250),
    organo: [f.organo_nivel1, f.organo_nivel2, f.organo_nivel3].filter(Boolean).join(' · '),
    resumen: f.finalidad || f.tipo ? recortar([f.finalidad, f.tipo].filter(Boolean).join(' — '), 200) : null,
  }));
}

