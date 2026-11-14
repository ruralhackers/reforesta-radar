// Empresas candidatas a apoyar proyectos de restauración (canal de empresas): una fila por empresa y una señal por cada DIA del BOE
// (u otro origen futuro) que la señala. Se unen por CIF (si consta) o por el nombre normalizado. Nunca se guardan personas de contacto.
import type { DatabaseSync } from 'node:sqlite';
import { diaLocal } from '../dates.ts';
import type { Perfil } from '../types.ts';
import { rangoTerritorio } from '../zona.ts';
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

/** Prioridad de una empresa: cuanto mayor, antes se muestra. */
export const PRIORIDAD_DIA = 3;
export const PRIORIDAD_REGISTRO_COMPENSA = 2;
export const PRIORIDAD_REGISTRO_ZONA = 1;
/** Por debajo de esta prioridad (solo zona y sector, sin compensación) la empresa es de baja confianza: se guarda pero no se muestra por defecto ni va al correo. */
export const PRIORIDAD_MINIMA_VISIBLE = PRIORIDAD_REGISTRO_COMPENSA;

export type OrigenEmpresa = 'dia_boe' | 'huella_carbono' | 'compra_absorcion';

export interface SenalEmpresa {
  tipo: OrigenEmpresa;
  /** Referencia única de la señal para la empresa: id de la resolución del BOE o `huella:<NIF o nombre>` en el registro de huella. */
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
  prioridad: number;
  primeraVezVista: string;
  estado: EstadoEmpresa;
  /** Solo en la lectura del equipo; la pública no la trae. */
  nota?: string | null;
  senales: SenalEmpresa[];
}

/**
 * Forma canónica del nombre de una empresa para unir duplicados: minúsculas, sin acentos, sin puntos ni comas y con una sola separación.
 * La forma societaria SE CONSERVA (SL y SA son sociedades distintas); solo se unifican sus grafías ("S.L.U." = "SLU" = "sociedad limitada
 * unipersonal"). Dos nombres iguales salvo la forma societaria no se unen por nombre.
 */
export function claveEmpresa(nombre: string | null | undefined): string {
  return (nombre ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ').trim()
    .replace(/\bsociedad limitada unipersonal\b/g, 'slu').replace(/\bsociedad anonima unipersonal\b/g, 'sau')
    .replace(/\bsociedad limitada\b/g, 'sl').replace(/\bsociedad anonima\b/g, 'sa')
    .replace(/\bs l u\b/g, 'slu').replace(/\bs a u\b/g, 'sau').replace(/\bs l\b/g, 'sl').replace(/\bs a\b/g, 'sa')
    .replace(/\s+/g, ' ');
}

const MARCA_ENTIDAD = /(^| )(sl|slu|sa|sau|sll|scoop|s coop|aie|ute|sociedad|fundacion|asociacion|cooperativa|ayuntamiento)( |$)/;
const DNI_NIE = /\b(?:\d{8}[a-z]|[xyz]\d{7}[a-z])\b/i;
const CIF_ENTIDAD = /^[A-HJNP-SU-W]\d{7}[0-9A-J]$/;

/**
 * ¿Es una persona jurídica? Solo se guardan empresas: se acepta con CIF de entidad (letra A–H, J, N, P–S, U–W) o con una forma societaria
 * en el nombre (SL, SLU, SA, SAU, SLL, SCoop, AIE, UTE, Fundación, Asociación…), y nunca con un DNI/NIE. Un nombre de persona queda fuera.
 */
export function esEntidadJuridica(nombre: string, cif: string | null): boolean {
  if (DNI_NIE.test(nombre) || (cif && !CIF_ENTIDAD.test(cif))) return false;
  if (cif && CIF_ENTIDAD.test(cif)) return true;
  return MARCA_ENTIDAD.test(claveEmpresa(nombre));
}

export interface NuevaSenal {
  nombre: string;
  cif: string | null;
  origen: OrigenEmpresa;
  motivo: string;
  cita: string;
  provincia: string | null;
  /** Por defecto: DIA → 3, registro → 2. El registro solo por zona y sector es 1. La de la empresa es la mayor de sus señales (una criba posterior puede bajar la de una señal del registro). */
  prioridad?: number;
  senal: Omit<SenalEmpresa, 'tipo' | 'vistaEn' | 'motivo'>;
}

/** Guarda la señal y la empresa (la crea o la une a la existente). `nueva` = la empresa se ve por primera vez. */
export function registrarSenal(db: DatabaseSync, n: NuevaSenal, ahora: Date): { empresaId: number; nueva: boolean } {
  const clave = claveEmpresa(n.nombre);
  const prioridad = n.prioridad ?? (n.origen === 'dia_boe' ? PRIORIDAD_DIA : PRIORIDAD_REGISTRO_COMPENSA);
  if (!clave) throw new Error('Nombre de empresa vacío');
  return transaccion(db, () => {
    const porCif = n.cif ? (db.prepare('SELECT id, cif FROM empresas WHERE cif = ?').get(n.cif) as { id: number; cif: string | null } | undefined) : undefined;
    const porClave = db.prepare('SELECT id, cif FROM empresas WHERE clave = ?').get(clave) as { id: number; cif: string | null } | undefined;
    // Por nombre solo se une si no hay CIF que lo contradiga: dos CIF distintos son dos empresas aunque se llamen igual.
    const existente = porCif ?? (porClave && (!n.cif || !porClave.cif || porClave.cif === n.cif) ? porClave : undefined);
    let empresaId: number;
    let nueva = false;
    if (existente) {
      empresaId = Number(existente.id);
      // Una empresa oculta por baja confianza que esta señal sube a visible adopta su motivo, su cita y su enlace (si no, seguiría diciendo «no consta compensación»).
      const previa = (db.prepare('SELECT prioridad FROM empresas WHERE id = ?').get(empresaId) as { prioridad: number }).prioridad;
      if (previa < PRIORIDAD_MINIMA_VISIBLE && prioridad >= PRIORIDAD_MINIMA_VISIBLE) {
        db.prepare('UPDATE empresas SET origen = ?, motivo = ?, cita = ?, enlace = ?, provincia = COALESCE(?, provincia) WHERE id = ?').run(n.origen, n.motivo, n.cita, n.senal.enlace, n.provincia, empresaId);
      }
      // Si antes no constaba el CIF y ahora sí, se completa (salvo que ese CIF ya sea de otra fila: entonces no se toca).
      if (n.cif && !porCif && !existente.cif) db.prepare('UPDATE empresas SET cif = ?, actualizada_en = ? WHERE id = ?').run(n.cif, ahora.toISOString(), empresaId);
      if (n.cif && !porCif && !existente.cif && CIF_ENTIDAD.test(n.cif)) db.prepare("UPDATE empresas SET oculta = NULL WHERE id = ? AND oculta = 'sin forma jurídica'").run(empresaId); // con el CIF consta la forma jurídica
    } else {
      nueva = true;
      empresaId = Number(db.prepare(`
        INSERT INTO empresas (clave, nombre, cif, origen, motivo, cita, enlace, provincia, prioridad, primera_vez_vista, actualizada_en)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(porClave && n.cif ? `${clave} ${n.cif.toLowerCase()}` : clave, n.nombre, n.cif, n.origen, n.motivo, n.cita, n.senal.enlace, n.provincia, prioridad, ahora.toISOString(), ahora.toISOString()).lastInsertRowid);
    }
    // Una señal que ya estaba se actualiza (prioridad y motivo): así una criba nueva puede subirla o bajarla; la de la empresa es la mayor de sus señales.
    db.prepare(`
      INSERT INTO empresa_senales (empresa_id, tipo, boe_id, titulo, proyecto, provincia, motivo, medidas, enlace, fecha_publicacion, vista_en, prioridad)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (empresa_id, boe_id) DO UPDATE SET prioridad = excluded.prioridad, motivo = excluded.motivo
    `).run(empresaId, n.origen, n.senal.boeId, n.senal.titulo, n.senal.proyecto, n.senal.provincia, n.motivo, JSON.stringify(n.senal.medidas), n.senal.enlace, n.senal.fechaPublicacion, ahora.toISOString(), prioridad);
    recalcularPrioridad(db, empresaId, n.motivo);
    return { empresaId, nueva };
  });
}

/** Prioridad de la empresa = la mayor de sus señales. Si baja de la visible y la empresa es del registro, su motivo pasa al de la señal vigente. */
function recalcularPrioridad(db: DatabaseSync, empresaId: number, motivoVigente?: string): void {
  const antes = (db.prepare('SELECT prioridad FROM empresas WHERE id = ?').get(empresaId) as { prioridad: number }).prioridad;
  const { p } = db.prepare('SELECT COALESCE(MAX(prioridad), 0) AS p FROM empresa_senales WHERE empresa_id = ?').get(empresaId) as { p: number };
  db.prepare('UPDATE empresas SET prioridad = ? WHERE id = ?').run(p, empresaId);
  if (motivoVigente && p < antes && p < PRIORIDAD_MINIMA_VISIBLE) db.prepare(`UPDATE empresas SET motivo = ? WHERE id = ? AND origen IN ('huella_carbono', 'compra_absorcion')`).run(motivoVigente, empresaId);
}

/** Baja a prioridad 1 la señal del registro con ese id (una criba posterior la degradó y ya no cumple ni zona y sector): la empresa sigue guardada pero oculta, salvo que tenga una DIA. */
export function bajarSenalRegistro(db: DatabaseSync, boeId: string, motivo: string): void {
  transaccion(db, () => {
    for (const f of db.prepare(`SELECT empresa_id FROM empresa_senales WHERE boe_id = ? AND tipo = 'huella_carbono' AND prioridad > ?`).all(boeId, PRIORIDAD_REGISTRO_ZONA) as { empresa_id: number }[]) {
      db.prepare('UPDATE empresa_senales SET prioridad = ?, motivo = ? WHERE empresa_id = ? AND boe_id = ?').run(PRIORIDAD_REGISTRO_ZONA, motivo, f.empresa_id, boeId);
      recalcularPrioridad(db, Number(f.empresa_id), motivo);
    }
  });
}

/**
 * Oculta (no borra) las empresas guardadas que no son una persona jurídica identificable (de antes del filtro `esEntidadJuridica`), con el motivo «sin forma jurídica»;
 * y vuelve a mostrar las que antes se ocultaron por eso y ahora sí pasan (p. ej. se les completó el CIF). Devuelve los nombres ocultados.
 */
export function ocultarSinFormaJuridica(db: DatabaseSync): string[] {
  const ocultadas: string[] = [];
  for (const f of db.prepare('SELECT id, nombre, cif, oculta FROM empresas').all() as { id: number; nombre: string; cif: string | null; oculta: string | null }[]) {
    const valida = esEntidadJuridica(f.nombre, f.cif);
    if (!valida && !f.oculta) { db.prepare('UPDATE empresas SET oculta = ? WHERE id = ?').run('sin forma jurídica', f.id); ocultadas.push(f.nombre); }
    else if (valida && f.oculta === 'sin forma jurídica') db.prepare('UPDATE empresas SET oculta = NULL WHERE id = ?').run(f.id);
  }
  return ocultadas;
}

function aSenal(f: Record<string, unknown>): SenalEmpresa {
  return {
    tipo: f.tipo as OrigenEmpresa, boeId: String(f.boe_id), titulo: String(f.titulo), proyecto: (f.proyecto as string | null) ?? null, provincia: (f.provincia as string | null) ?? null,
    motivo: String(f.motivo), medidas: JSON.parse(String(f.medidas)) as MedidaDia[], enlace: String(f.enlace), fechaPublicacion: String(f.fecha_publicacion), vistaEn: String(f.vista_en),
  };
}

/**
 * Empresas por prioridad (DIA del BOE, luego registro con compensación, luego registro solo por zona y sector) y, dentro de cada una, las vistas por
 * primera vez más recientemente primero. Las de baja confianza (prioridad 1) solo con `incluirBaja`. `conNota`: incluir la nota del equipo (lectura
 * privada). `estado` filtra. Cada una con sus señales (la más reciente primero). Con `perfil`, las que compensan su huella (prioridad 2) se reordenan por zona
 * (ver `ordenarPorZona`).
 */
export function leerEmpresas(db: DatabaseSync, opciones: { estado?: EstadoEmpresa | null; conNota?: boolean; incluirBaja?: boolean; perfil?: Perfil | null } = {}): Empresa[] {
  const filas = db.prepare(`SELECT * FROM empresas WHERE oculta IS NULL AND (? IS NULL OR estado = ?) AND (? = 1 OR prioridad >= ?) ORDER BY prioridad DESC, primera_vez_vista DESC, id DESC`)
    .all(opciones.estado ?? null, opciones.estado ?? null, opciones.incluirBaja ? 1 : 0, PRIORIDAD_MINIMA_VISIBLE) as Record<string, unknown>[];
  const senales = db.prepare('SELECT * FROM empresa_senales WHERE empresa_id = ? ORDER BY fecha_publicacion DESC, id DESC');
  const lista = filas.map((f) => ({
    id: Number(f.id), nombre: String(f.nombre), cif: (f.cif as string | null) ?? null, origen: String(f.origen), motivo: String(f.motivo), cita: String(f.cita),
    enlace: String(f.enlace), provincia: (f.provincia as string | null) ?? null, paginaRsc: (f.pagina_rsc as string | null) ?? null, prioridad: Number(f.prioridad),
    primeraVezVista: String(f.primera_vez_vista), estado: f.estado as EstadoEmpresa,
    ...(opciones.conNota ? { nota: (f.nota as string | null) ?? null } : {}),
    senales: (senales.all(Number(f.id)) as Record<string, unknown>[]).map(aSenal),
  }));
  return opciones.perfil ? ordenarPorZona(lista, opciones.perfil) : lista;
}

/** Posición de la empresa entre los territorios del perfil (0 = el de casa, 1.. = limítrofes); null = fuera. Mira su zona y la de sus señales. */
export function rangoEmpresa(e: Empresa, perfil: Perfil): number | null {
  const rangos = [e.provincia, ...e.senales.map((s) => s.provincia)].map((l) => rangoTerritorio(l, perfil)).filter((r): r is number => r !== null);
  return rangos.length ? Math.min(...rangos) : null;
}

/** Día de su compensación más reciente en el registro (la inscripción más nueva, o la compra de absorciones más reciente); si no consta, el día en que se vio. */
function diaCompensacion(e: Empresa): string {
  const fechas = e.senales.filter((s) => s.tipo === 'huella_carbono' || s.tipo === 'compra_absorcion').map((s) => s.fechaPublicacion).sort();
  return fechas.length ? fechas[fechas.length - 1] : diaLocal(new Date(e.primeraVezVista));
}

/**
 * Orden del grupo "Compensan su huella" (prioridad 2): primero las de los territorios del perfil (en el orden del perfil: el de casa y luego los limítrofes),
 * después el resto; dentro de cada zona, la compensación más reciente primero. Las demás prioridades conservan su orden y su sitio.
 */
export function ordenarPorZona(lista: Empresa[], perfil: Perfil): Empresa[] {
  const compensan = lista.filter((e) => e.prioridad === PRIORIDAD_REGISTRO_COMPENSA)
    .map((e, i) => ({ e, i, rango: rangoEmpresa(e, perfil) ?? Number.MAX_SAFE_INTEGER, dia: diaCompensacion(e) }))
    .sort((a, b) => a.rango - b.rango || (a.dia < b.dia ? 1 : a.dia > b.dia ? -1 : 0) || a.i - b.i)
    .map((x) => x.e);
  let k = 0;
  return lista.map((e) => (e.prioridad === PRIORIDAD_REGISTRO_COMPENSA ? compensan[k++] : e));
}

/** Una empresa nueva que merece avisar: con DIA (obligada a restaurar) o que compensa su huella dentro de los territorios del perfil. */
export function esNuevaRelevante(e: Empresa, perfil: Perfil): boolean {
  return e.prioridad >= PRIORIDAD_DIA || (e.prioridad >= PRIORIDAD_REGISTRO_COMPENSA && rangoEmpresa(e, perfil) !== null);
}

/** Cuántas empresas de baja confianza hay (las que `leerEmpresas` no devuelve por defecto). */
export function contarEmpresasBaja(db: DatabaseSync, estado?: EstadoEmpresa | null): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM empresas WHERE oculta IS NULL AND prioridad < ? AND (? IS NULL OR estado = ?)').get(PRIORIDAD_MINIMA_VISIBLE, estado ?? null, estado ?? null) as { n: number }).n);
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

/** Empresas (sin las de baja confianza) vistas por primera vez entre dos días locales (incluidos), por prioridad y luego las más recientes: lo que cuenta el correo del lunes. Con `perfil`, solo las relevantes (`esNuevaRelevante`): las de una DIA y las que compensan dentro de sus territorios. */
export function empresasNuevasEntre(db: DatabaseSync, desde: string, hasta: string, perfil?: Perfil | null): Empresa[] {
  return leerEmpresas(db).filter((e) => {
    const d = diaLocal(new Date(e.primeraVezVista));
    return d >= desde && d <= hasta && (!perfil || esNuevaRelevante(e, perfil));
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
