// Empresas candidatas a apoyar proyectos de restauración (canal de empresas): una fila por empresa y una señal por cada DIA del BOE
// (u otro origen futuro) que la señala. Se unen por CIF (si consta) o por el nombre normalizado. Nunca se guardan personas de contacto.
import type { DatabaseSync } from 'node:sqlite';
import { diaLocal } from '../dates.ts';
import { transaccion } from './repo.ts';

export type EstadoEmpresa = 'pendiente' | 'contactada' | 'descartada';
export const ESTADOS_EMPRESA: readonly EstadoEmpresa[] = ['pendiente', 'contactada', 'descartada'];
export const MAX_NOTA_EMPRESA = 2000;

export class ErrorEmpresa extends Error {
  estado: 400 | 404;
  constructor(mensaje: string, estado: 400 | 404) {
    super(mensaje);
    this.estado = estado;
  }
}

export interface MedidaDia { tipo: string; cita: string }

export interface SenalEmpresa {
  tipo: 'dia_boe';
  boeId: string;
  titulo: string;
  proyecto: string | null;
  provincia: string | null;
  motivo: string;
  medidas: MedidaDia[];
  enlace: string;
  fechaPublicacion: string;
  vistaEn: string;
}

export interface Empresa {
  id: number;
  nombre: string;
  cif: string | null;
  origen: string;
  motivo: string;
  cita: string;
  enlace: string;
  provincia: string | null;
  paginaRsc: string | null;
  primeraVezVista: string;
  estado: EstadoEmpresa;
  /** Solo en la lectura del equipo; la pública no la trae. */
  nota?: string | null;
  senales: SenalEmpresa[];
}

const FORMAS = /\b(?:sociedad limitada unipersonal|sociedad anonima unipersonal|sociedad limitada|sociedad anonima|sociedad cooperativa|s ?l ?u|s ?a ?u|s ?l ?l|s ?l|s ?a|s ?coop|slu|sau|sl|sa)$/;

/**
 * Forma canónica del nombre de una empresa para unir duplicados: minúsculas, sin acentos ni puntuación y sin la forma
 * societaria final ("Antila Solar, S.L." y "ANTILA SOLAR SL" → "antila solar").
 */
export function claveEmpresa(nombre: string): string {
  let s = nombre.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const t = s.replace(FORMAS, '').trim();
    if (t === s || !t) break;
    s = t;
  }
  return s;
}

export interface NuevaSenal {
  nombre: string;
  cif: string | null;
  origen: 'dia_boe';
  motivo: string;
  cita: string;
  provincia: string | null;
  senal: Omit<SenalEmpresa, 'tipo' | 'vistaEn' | 'motivo'>;
}

/** Guarda la señal y la empresa (la crea o la une a la existente). `nueva` = la empresa se ve por primera vez. */
export function registrarSenal(db: DatabaseSync, n: NuevaSenal, ahora: Date): { empresaId: number; nueva: boolean } {
  const clave = claveEmpresa(n.nombre);
  if (!clave) throw new Error('Nombre de empresa vacío');
  return transaccion(db, () => {
    const porCif = n.cif ? (db.prepare('SELECT id, cif FROM empresas WHERE cif = ?').get(n.cif) as { id: number; cif: string | null } | undefined) : undefined;
    const existente = porCif ?? (db.prepare('SELECT id, cif FROM empresas WHERE clave = ?').get(clave) as { id: number; cif: string | null } | undefined);
    let empresaId: number;
    let nueva = false;
    if (existente) {
      empresaId = Number(existente.id);
      // Si antes no constaba el CIF y ahora sí, se completa (salvo que ese CIF ya sea de otra fila: entonces no se toca).
      if (n.cif && !porCif && !existente.cif) db.prepare('UPDATE empresas SET cif = ?, actualizada_en = ? WHERE id = ?').run(n.cif, ahora.toISOString(), empresaId);
    } else {
      nueva = true;
      empresaId = Number(db.prepare(`
        INSERT INTO empresas (clave, nombre, cif, origen, motivo, cita, enlace, provincia, primera_vez_vista, actualizada_en)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(clave, n.nombre, n.cif, n.origen, n.motivo, n.cita, n.senal.enlace, n.provincia, ahora.toISOString(), ahora.toISOString()).lastInsertRowid);
    }
    db.prepare(`
      INSERT OR IGNORE INTO empresa_senales (empresa_id, tipo, boe_id, titulo, proyecto, provincia, motivo, medidas, enlace, fecha_publicacion, vista_en)
      VALUES (?, 'dia_boe', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(empresaId, n.senal.boeId, n.senal.titulo, n.senal.proyecto, n.senal.provincia, n.motivo, JSON.stringify(n.senal.medidas), n.senal.enlace, n.senal.fechaPublicacion, ahora.toISOString());
    return { empresaId, nueva };
  });
}

function aSenal(f: Record<string, unknown>): SenalEmpresa {
  return {
    tipo: 'dia_boe', boeId: String(f.boe_id), titulo: String(f.titulo), proyecto: (f.proyecto as string | null) ?? null, provincia: (f.provincia as string | null) ?? null,
    motivo: String(f.motivo), medidas: JSON.parse(String(f.medidas)) as MedidaDia[], enlace: String(f.enlace), fechaPublicacion: String(f.fecha_publicacion), vistaEn: String(f.vista_en),
  };
}

/**
 * Empresas, las vistas por primera vez más recientemente primero. `conNota`: incluir la nota del equipo (lectura privada).
 * `estado` filtra. Cada una con sus señales (la DIA más reciente primero).
 */
export function leerEmpresas(db: DatabaseSync, opciones: { estado?: EstadoEmpresa | null; conNota?: boolean } = {}): Empresa[] {
  const filas = (opciones.estado
    ? db.prepare('SELECT * FROM empresas WHERE estado = ? ORDER BY primera_vez_vista DESC, id DESC').all(opciones.estado)
    : db.prepare('SELECT * FROM empresas ORDER BY primera_vez_vista DESC, id DESC').all()) as Record<string, unknown>[];
  const senales = db.prepare('SELECT * FROM empresa_senales WHERE empresa_id = ? ORDER BY fecha_publicacion DESC, id DESC');
  return filas.map((f) => ({
    id: Number(f.id), nombre: String(f.nombre), cif: (f.cif as string | null) ?? null, origen: String(f.origen), motivo: String(f.motivo), cita: String(f.cita),
    enlace: String(f.enlace), provincia: (f.provincia as string | null) ?? null, paginaRsc: (f.pagina_rsc as string | null) ?? null,
    primeraVezVista: String(f.primera_vez_vista), estado: f.estado as EstadoEmpresa,
    ...(opciones.conNota ? { nota: (f.nota as string | null) ?? null } : {}),
    senales: (senales.all(Number(f.id)) as Record<string, unknown>[]).map(aSenal),
  }));
}

/** Estado y/o nota del equipo. `nota` vacía la borra. Lanza ErrorEmpresa (400/404). */
export function actualizarEmpresa(db: DatabaseSync, id: number, cuerpo: unknown, ahora: Date): { id: number; estado: EstadoEmpresa; nota: string | null } {
  const c = (cuerpo && typeof cuerpo === 'object' ? cuerpo : null) as { estado?: unknown; nota?: unknown } | null;
  if (!c || (c.estado === undefined && c.nota === undefined)) throw new ErrorEmpresa('Indica "estado" y/o "nota"', 400);
  if (c.estado !== undefined && !ESTADOS_EMPRESA.includes(c.estado as EstadoEmpresa)) throw new ErrorEmpresa(`"estado" debe ser uno de: ${ESTADOS_EMPRESA.join(', ')}`, 400);
  let nota: string | null | undefined;
  if (c.nota !== undefined) {
    if (c.nota !== null && typeof c.nota !== 'string') throw new ErrorEmpresa('"nota" debe ser texto', 400);
    nota = typeof c.nota === 'string' && c.nota.trim() ? c.nota.trim() : null;
    if (nota && nota.length > MAX_NOTA_EMPRESA) throw new ErrorEmpresa(`La nota es demasiado larga (máximo ${MAX_NOTA_EMPRESA} caracteres)`, 400);
  }
  if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM empresas WHERE id = ?').get(id)) throw new ErrorEmpresa('No existe esa empresa', 404);
  if (c.estado !== undefined) db.prepare('UPDATE empresas SET estado = ?, actualizada_en = ? WHERE id = ?').run(c.estado as string, ahora.toISOString(), id);
  if (nota !== undefined) db.prepare('UPDATE empresas SET nota = ?, actualizada_en = ? WHERE id = ?').run(nota, ahora.toISOString(), id);
  const f = db.prepare('SELECT estado, nota FROM empresas WHERE id = ?').get(id) as { estado: EstadoEmpresa; nota: string | null };
  return { id, estado: f.estado, nota: f.nota };
}

/** Empresas vistas por primera vez entre dos días locales (incluidos), las más recientes primero: lo que cuenta el correo del lunes. */
export function empresasNuevasEntre(db: DatabaseSync, desde: string, hasta: string): Empresa[] {
  return leerEmpresas(db).filter((e) => {
    const d = diaLocal(new Date(e.primeraVezVista));
    return d >= desde && d <= hasta;
  });
}

// --- Seguimiento de lo ya leído del BOE ---

export function resolucionProcesada(db: DatabaseSync, boeId: string): boolean {
  return !!db.prepare('SELECT 1 FROM dia_boe_procesadas WHERE boe_id = ?').get(boeId);
}

export function marcarResolucion(db: DatabaseSync, boeId: string, fecha: string, titulo: string, resultado: 'con_medidas' | 'sin_medidas' | 'sin_promotor' | 'desfavorable', ahora: Date): void {
  db.prepare('INSERT OR REPLACE INTO dia_boe_procesadas (boe_id, fecha, titulo, resultado, procesada_en) VALUES (?, ?, ?, ?, ?)').run(boeId, fecha, titulo, resultado, ahora.toISOString());
}

export function diaRevisado(db: DatabaseSync, fecha: string): boolean {
  return !!db.prepare('SELECT 1 FROM boe_dias WHERE fecha = ?').get(fecha);
}

export function marcarDiaRevisado(db: DatabaseSync, fecha: string, ahora: Date): void {
  db.prepare('INSERT OR REPLACE INTO boe_dias (fecha, revisado_en) VALUES (?, ?)').run(fecha, ahora.toISOString());
}
