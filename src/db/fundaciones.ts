// Fuentes vigiladas (fundaciones privadas y agregadores del tercer sector): alta, baja, activación y estado de la última revisión.
import type { DatabaseSync } from 'node:sqlite';

export type TipoFundacion = 'fundacion' | 'agregador';

export interface FuenteVigilada {
  id: number;
  nombre: string;
  url: string | null;
  tipo: TipoFundacion;
  activa: boolean;
  notas: string | null;
  /** Huella del último texto principal leído y dado por bueno (null = nunca). */
  huella: string | null;
  ultimoCambio: string | null;
  ultimaRevision: string | null;
  ultimoError: string | null;
}

export class ErrorFundacion extends Error {
  estado: 400 | 404 | 409;
  constructor(mensaje: string, estado: 400 | 404 | 409) {
    super(mensaje);
    this.estado = estado;
  }
}

function aFuente(f: Record<string, unknown>): FuenteVigilada {
  return {
    id: Number(f.id), nombre: String(f.nombre), url: (f.url as string | null) ?? null, tipo: f.tipo as TipoFundacion, activa: f.activa === 1,
    notas: (f.notas as string | null) ?? null, huella: (f.huella as string | null) ?? null, ultimoCambio: (f.ultimo_cambio as string | null) ?? null,
    ultimaRevision: (f.ultima_revision as string | null) ?? null, ultimoError: (f.ultimo_error as string | null) ?? null,
  };
}

export function leerFuentesVigiladas(db: DatabaseSync): FuenteVigilada[] {
  return (db.prepare('SELECT * FROM fundaciones ORDER BY activa DESC, tipo, nombre').all() as Record<string, unknown>[]).map(aFuente);
}

/** Las que la siguiente ejecución revisará: activas y con URL. */
export function fuentesActivas(db: DatabaseSync): FuenteVigilada[] {
  return (db.prepare('SELECT * FROM fundaciones WHERE activa = 1 AND url IS NOT NULL ORDER BY id').all() as Record<string, unknown>[]).map(aFuente);
}

/** Solo http(s). Devuelve la URL normalizada o lanza ErrorFundacion. */
export function validarUrl(url: unknown): string {
  if (typeof url !== 'string') throw new ErrorFundacion('Falta la URL', 400);
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new ErrorFundacion('La URL no es válida (p. ej. https://fundacion.org/convocatorias)', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ErrorFundacion('La URL debe empezar por http:// o https://', 400);
  // El radar descarga estas páginas desde el servidor: nada de direcciones IP ni de nombres internos (localhost, sin punto, .local/.internal).
  const h = u.hostname;
  if (/^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.') || /\.(local|internal|localhost|lan)$/i.test(h)) throw new ErrorFundacion('La URL debe ser la de una web pública (con nombre de dominio, no una IP ni una dirección interna)', 400);
  return u.toString();
}

export function altaFuente(db: DatabaseSync, { nombre, url, tipo }: { nombre: unknown; url: unknown; tipo: unknown }): FuenteVigilada {
  const n = typeof nombre === 'string' ? nombre.trim() : '';
  if (!n) throw new ErrorFundacion('Falta el nombre', 400);
  if (tipo !== 'fundacion' && tipo !== 'agregador') throw new ErrorFundacion('El tipo debe ser "fundacion" o "agregador"', 400);
  const u = validarUrl(url);
  if (db.prepare('SELECT 1 FROM fundaciones WHERE nombre = ? OR url = ?').get(n, u)) throw new ErrorFundacion('Ya existe una fuente con ese nombre o esa URL', 409);
  const r = db.prepare("INSERT INTO fundaciones (nombre, url, tipo, activa, notas) VALUES (?, ?, ?, 1, 'Añadida desde la web')").run(n, u, tipo);
  return aFuente(db.prepare('SELECT * FROM fundaciones WHERE id = ?').get(Number(r.lastInsertRowid)) as Record<string, unknown>);
}

export function activarFuente(db: DatabaseSync, id: number, activa: boolean): void {
  const f = db.prepare('SELECT url FROM fundaciones WHERE id = ?').get(id) as { url: string | null } | undefined;
  if (!f) throw new ErrorFundacion('No existe esa fuente', 404);
  if (activa && !f.url) throw new ErrorFundacion('Esa fuente no tiene URL: no se puede vigilar', 400);
  db.prepare('UPDATE fundaciones SET activa = ? WHERE id = ?').run(Number(activa), id);
}

/** Quita la fuente. Las convocatorias que ya se extrajeron de ella se conservan (siguen su curso en el ranking). */
export function quitarFuente(db: DatabaseSync, id: number): void {
  if (Number(db.prepare('DELETE FROM fundaciones WHERE id = ?').run(id).changes) === 0) throw new ErrorFundacion('No existe esa fuente', 404);
}

export type ResultadoRevision =
  | { tipo: 'sin_cambios'; huella: string }
  | { tipo: 'cambiada'; huella: string }
  | { tipo: 'error'; mensaje: string };

/** Apunta el resultado de revisar una fuente. Un error no toca la huella (se vuelve a intentar entera la próxima vez). */
export function apuntarRevision(db: DatabaseSync, id: number, r: ResultadoRevision, ahora: Date): void {
  const t = ahora.toISOString();
  if (r.tipo === 'error') db.prepare('UPDATE fundaciones SET ultima_revision = ?, ultimo_error = ? WHERE id = ?').run(t, r.mensaje, id);
  else if (r.tipo === 'sin_cambios') db.prepare('UPDATE fundaciones SET ultima_revision = ?, ultimo_error = NULL WHERE id = ?').run(t, id);
  else db.prepare('UPDATE fundaciones SET huella = ?, ultimo_cambio = ?, ultima_revision = ?, ultimo_error = NULL WHERE id = ?').run(r.huella, t, t, id);
}
