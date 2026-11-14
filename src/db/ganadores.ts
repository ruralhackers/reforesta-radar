// Acceso a datos de concesiones (ganadores), ediciones de series y organizaciones parecidas.
import type { DatabaseSync } from 'node:sqlite';
import { anioEdicion, claveSerie, leerBeneficiario } from '../concesiones.ts';
import type { ConcesionBdns } from '../sources/bdns-concesiones.ts';
import { transaccion } from './repo.ts';

export interface Concesion {
  id: number;
  numeroConvocatoria: string;
  nif: string | null;
  nombre: string;
  esPersona: boolean;
  importe: number | null;
  fechaConcesion: string | null;
  titulo: string;
}

const SQL_UPSERT = `
  INSERT INTO concesiones (id, numero_convocatoria, nif, nombre, es_persona, beneficiario, importe, fecha_concesion, titulo,
    organo_nivel1, organo_nivel2, organo_nivel3, url_bases, actualizado_en)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET numero_convocatoria = excluded.numero_convocatoria, nif = excluded.nif, nombre = excluded.nombre,
    es_persona = excluded.es_persona, beneficiario = excluded.beneficiario, importe = excluded.importe,
    fecha_concesion = excluded.fecha_concesion, titulo = excluded.titulo, organo_nivel1 = excluded.organo_nivel1,
    organo_nivel2 = excluded.organo_nivel2, organo_nivel3 = excluded.organo_nivel3, url_bases = excluded.url_bases,
    actualizado_en = excluded.actualizado_en
`;

function insertar(db: DatabaseSync, filas: ConcesionBdns[], ahora: Date): void {
  const q = db.prepare(SQL_UPSERT);
  for (const c of filas) {
    const b = leerBeneficiario(c.beneficiario);
    q.run(c.id, String(c.numeroConvocatoria), b.nif, b.nombre, Number(b.esPersona), c.beneficiario, c.importe ?? null,
      c.fechaConcesion ?? null, c.convocatoria.trim(), c.nivel1 ?? null, c.nivel2 ?? null, c.nivel3 ?? null, c.urlBR ?? null, ahora.toISOString());
    registrarEdicion(db, String(c.numeroConvocatoria), c.convocatoria, { nivel1: c.nivel1, nivel2: c.nivel2, nivel3: c.nivel3 }, c.fechaConcesion);
  }
}

/** Reemplaza las concesiones guardadas de una convocatoria (lo que BDNS corrige o retira desaparece). */
export function guardarConcesionesDeConvocatoria(db: DatabaseSync, numero: string, filas: ConcesionBdns[], ahora: Date): void {
  transaccion(db, () => {
    db.prepare('DELETE FROM concesiones WHERE numero_convocatoria = ?').run(numero);
    insertar(db, filas, ahora);
    marcarConsulta(db, `conv:${numero}`, filas.length, ahora);
  });
}

/** Añade o actualiza concesiones sueltas (las de una entidad por NIF). */
export function guardarConcesionesSueltas(db: DatabaseSync, clave: string, filas: ConcesionBdns[], ahora: Date): void {
  transaccion(db, () => {
    insertar(db, filas, ahora);
    marcarConsulta(db, clave, filas.length, ahora);
  });
}

export function marcarConsulta(db: DatabaseSync, clave: string, total: number, ahora: Date): void {
  db.prepare(`INSERT INTO consultas_concesiones (clave, consultado_en, total) VALUES (?, ?, ?)
    ON CONFLICT (clave) DO UPDATE SET consultado_en = excluded.consultado_en, total = excluded.total`).run(clave, ahora.toISOString(), total);
}

/** ¿Se consultó `clave` hace menos de `dias` días? */
export function consultaReciente(db: DatabaseSync, clave: string, ahora: Date, dias: number): boolean {
  const f = db.prepare('SELECT consultado_en FROM consultas_concesiones WHERE clave = ?').get(clave) as { consultado_en: string } | undefined;
  return f !== undefined && ahora.getTime() - new Date(f.consultado_en).getTime() < dias * 86_400_000;
}

export function registrarEdicion(
  db: DatabaseSync, numero: string, titulo: string, organo: { nivel1: string | null; nivel2: string | null; nivel3: string | null }, fecha: string | null,
): void {
  const serie = claveSerie(titulo, organo);
  if (!serie) return;
  db.prepare(`INSERT INTO ediciones_serie (numero_convocatoria, serie, titulo, anio, fecha) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (numero_convocatoria) DO UPDATE SET serie = excluded.serie, titulo = excluded.titulo,
      anio = COALESCE(excluded.anio, ediciones_serie.anio), fecha = COALESCE(excluded.fecha, ediciones_serie.fecha)`)
    .run(numero, serie, titulo.trim(), anioEdicion(titulo, fecha), fecha);
}

export interface Edicion {
  numeroConvocatoria: string;
  titulo: string;
  anio: number | null;
  /** Fecha de registro (YYYY-MM-DD) si se conoce. */
  fecha: string | null;
}

export function edicionesDeSerie(db: DatabaseSync, serie: string): Edicion[] {
  const filas = db.prepare('SELECT numero_convocatoria, titulo, anio, fecha FROM ediciones_serie WHERE serie = ? ORDER BY anio DESC, numero_convocatoria DESC')
    .all(serie) as { numero_convocatoria: string; titulo: string; anio: number | null; fecha: string | null }[];
  return filas.map((f) => ({ numeroConvocatoria: f.numero_convocatoria, titulo: f.titulo, anio: f.anio, fecha: f.fecha }));
}

export function concesionesDe(db: DatabaseSync, numero: string): Concesion[] {
  const filas = db.prepare('SELECT * FROM concesiones WHERE numero_convocatoria = ? ORDER BY importe DESC, nombre, id').all(numero) as Record<string, unknown>[];
  return filas.map((f) => ({
    id: Number(f.id), numeroConvocatoria: String(f.numero_convocatoria), nif: (f.nif as string | null) ?? null, nombre: String(f.nombre),
    esPersona: f.es_persona === 1, importe: (f.importe as number | null) ?? null, fechaConcesion: (f.fecha_concesion as string | null) ?? null,
    titulo: String(f.titulo),
  }));
}

/** Números de convocatoria en los que figura `nif` como beneficiario. */
export function convocatoriasGanadasPor(db: DatabaseSync, nif: string): string[] {
  return (db.prepare('SELECT DISTINCT numero_convocatoria AS n FROM concesiones WHERE nif = ? ORDER BY n').all(nif) as { n: string }[]).map((r) => r.n);
}

// --- Organizaciones parecidas ---

export type OrigenParecida = 'semilla' | 'calculada' | 'manual' | 'derivada';

export interface Parecida {
  nif: string;
  nombre: string;
  origen: OrigenParecida;
  activa: boolean;
  /** Convocatorias ganadas por Reforesta que esta organización también ganó. */
  coincidencias: number;
  /** Números de esas convocatorias. */
  evidencia: string[];
}

export function leerParecidas(db: DatabaseSync, soloActivas = false): Parecida[] {
  const filas = db.prepare(`SELECT * FROM organizaciones_parecidas ${soloActivas ? 'WHERE activa = 1' : ''} ORDER BY coincidencias DESC, nombre`).all() as Record<string, unknown>[];
  return filas.map((f) => ({
    nif: String(f.nif), nombre: String(f.nombre), origen: f.origen as OrigenParecida, activa: f.activa === 1,
    coincidencias: Number(f.coincidencias), evidencia: JSON.parse(String(f.evidencia)) as string[],
  }));
}

export interface ParecidaCalculada {
  nif: string;
  nombre: string;
  evidencia: string[];
}

/**
 * Guarda el resultado del cálculo sin pisar decisiones humanas:
 * - las `manual` solo actualizan sus coincidencias; nunca se borran ni cambian de nombre u origen;
 * - `activa` no se toca nunca (una desactivada sigue desactivada aunque se recalcule);
 * - las de semilla confirmadas por los datos pasan a `calculada` (conservan su nombre);
 * - las `calculada` que ya no salen se borran, salvo las desactivadas (se queda con 0 coincidencias).
 * Las de semilla que los datos no confirman se quedan como están.
 */
export function guardarParecidasCalculadas(db: DatabaseSync, calculadas: ParecidaCalculada[], ahora: Date): void {
  transaccion(db, () => {
    const t = ahora.toISOString();
    const nifs = new Set(calculadas.map((c) => c.nif));
    for (const c of calculadas) {
      const existe = db.prepare('SELECT origen FROM organizaciones_parecidas WHERE nif = ?').get(c.nif) as { origen: string } | undefined;
      const ev = JSON.stringify(c.evidencia);
      if (!existe) {
        db.prepare("INSERT INTO organizaciones_parecidas (nif, nombre, origen, coincidencias, evidencia, actualizado_en) VALUES (?, ?, 'calculada', ?, ?, ?)")
          .run(c.nif, c.nombre, c.evidencia.length, ev, t);
      } else if (existe.origen === 'manual') {
        db.prepare('UPDATE organizaciones_parecidas SET coincidencias = ?, evidencia = ?, actualizado_en = ? WHERE nif = ?').run(c.evidencia.length, ev, t, c.nif);
      } else {
        db.prepare("UPDATE organizaciones_parecidas SET origen = 'calculada', coincidencias = ?, evidencia = ?, actualizado_en = ? WHERE nif = ?").run(c.evidencia.length, ev, t, c.nif);
      }
    }
    for (const f of db.prepare("SELECT nif, activa FROM organizaciones_parecidas WHERE origen = 'calculada'").all() as { nif: string; activa: number }[]) {
      if (nifs.has(f.nif)) continue;
      if (f.activa === 1) db.prepare('DELETE FROM organizaciones_parecidas WHERE nif = ?').run(f.nif);
      else db.prepare('UPDATE organizaciones_parecidas SET coincidencias = 0, evidencia = ?, actualizado_en = ? WHERE nif = ?').run('[]', t, f.nif);
    }
  });
}

// --- Ajuste de la lista desde la web (API /parecidas) ---

export const NIF_ENTIDAD_VALIDO = /^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/;

/** Parecidas con cuántas convocatorias candidatas han aportado (etiquetas de origen vigentes). */
export function leerParecidasConAportes(db: DatabaseSync): (Parecida & { convocatorias: number })[] {
  const cuenta = new Map((db.prepare("SELECT nif, COUNT(DISTINCT convocatoria_id) AS n FROM origenes_convocatoria WHERE origen = 'parecidas' GROUP BY nif").all() as { nif: string; n: number }[]).map((r) => [r.nif, Number(r.n)]));
  return leerParecidas(db).map((p) => ({ ...p, convocatorias: cuenta.get(p.nif) ?? 0 }));
}

export function activarParecida(db: DatabaseSync, nif: string, activa: boolean, ahora: Date): boolean {
  return Number(db.prepare('UPDATE organizaciones_parecidas SET activa = ?, actualizado_en = ? WHERE nif = ?').run(Number(activa), ahora.toISOString(), nif).changes) > 0;
}

/** Alta manual por NIF (sin nombre se usa el NIF hasta que BDNS dé el nombre). false si ya existe (de cualquier origen). */
export function altaParecidaManual(db: DatabaseSync, nif: string, nombre: string | null, ahora: Date): boolean {
  if (db.prepare('SELECT 1 FROM organizaciones_parecidas WHERE nif = ?').get(nif)) return false;
  db.prepare("INSERT INTO organizaciones_parecidas (nif, nombre, origen, activa, actualizado_en) VALUES (?, ?, 'manual', 1, ?)").run(nif, nombre?.trim() || nif, ahora.toISOString());
  return true;
}

/** Quita una organización manual. 'no_existe' | 'no_manual' (las calculadas y de semilla solo se desactivan) | 'ok'. */
export function quitarParecidaManual(db: DatabaseSync, nif: string): 'no_existe' | 'no_manual' | 'ok' {
  const f = db.prepare('SELECT origen FROM organizaciones_parecidas WHERE nif = ?').get(nif) as { origen: string } | undefined;
  if (!f) return 'no_existe';
  if (f.origen !== 'manual') return 'no_manual';
  transaccion(db, () => {
    db.prepare('DELETE FROM organizaciones_parecidas WHERE nif = ?').run(nif);
    db.prepare('DELETE FROM ganadas_parecidas WHERE nif = ?').run(nif);
    db.prepare('DELETE FROM origenes_convocatoria WHERE nif = ?').run(nif);
    db.prepare('DELETE FROM consultas_concesiones WHERE clave = ?').run(`parecida:${nif}`);
  });
  return 'ok';
}

// --- Descubrimiento por parecidas: lo que ganaron y de dónde viene cada candidata ---

export interface GanadaDeParecida {
  nif: string;
  nombre: string;
  numeroConvocatoria: string;
  titulo: string;
  organo: { nivel1: string | null; nivel2: string | null; nivel3: string | null };
  fechaConcesion: string | null;
}

/** Sustituye lo que se sabe que ha ganado `nif` (una fila por convocatoria) y apunta la consulta; si su nombre era el NIF, adopta el de BDNS. */
export function guardarGanadasDeParecida(db: DatabaseSync, nif: string, filas: ConcesionBdns[], ahora: Date): void {
  transaccion(db, () => {
    db.prepare('DELETE FROM ganadas_parecidas WHERE nif = ?').run(nif);
    const porNumero = new Map<string, ConcesionBdns>();
    const nombres = new Map<string, number>();
    for (const c of filas) {
      const b = leerBeneficiario(c.beneficiario);
      if (b.nif !== nif) continue; // la búsqueda por NIF puede devolver otras filas parecidas: solo las de esta entidad
      nombres.set(b.nombre, (nombres.get(b.nombre) ?? 0) + 1);
      const previa = porNumero.get(String(c.numeroConvocatoria));
      if (!previa || (c.fechaConcesion ?? '') > (previa.fechaConcesion ?? '')) porNumero.set(String(c.numeroConvocatoria), c);
    }
    const q = db.prepare(`INSERT INTO ganadas_parecidas (nif, numero_convocatoria, titulo, organo_nivel1, organo_nivel2, organo_nivel3, fecha_concesion, importe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [numero, c] of porNumero) {
      q.run(nif, numero, c.convocatoria.trim(), c.nivel1 ?? null, c.nivel2 ?? null, c.nivel3 ?? null, c.fechaConcesion ?? null, c.importe ?? null);
      registrarEdicion(db, numero, c.convocatoria, { nivel1: c.nivel1, nivel2: c.nivel2, nivel3: c.nivel3 }, c.fechaConcesion);
    }
    const nombre = [...nombres].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (nombre) db.prepare('UPDATE organizaciones_parecidas SET nombre = ? WHERE nif = ? AND nombre = nif').run(nombre, nif);
    marcarConsulta(db, `parecida:${nif}`, porNumero.size, ahora);
  });
}

/** Lo ganado por las parecidas ACTIVAS. */
export function ganadasDeParecidasActivas(db: DatabaseSync): GanadaDeParecida[] {
  const filas = db.prepare(`SELECT g.*, p.nombre FROM ganadas_parecidas g JOIN organizaciones_parecidas p ON p.nif = g.nif
    WHERE p.activa = 1 ORDER BY g.nif, g.numero_convocatoria`).all() as Record<string, string | null>[];
  return filas.map((f) => ({
    nif: f.nif!, nombre: f.nombre!, numeroConvocatoria: f.numero_convocatoria!, titulo: f.titulo!, fechaConcesion: f.fecha_concesion ?? null,
    organo: { nivel1: f.organo_nivel1 ?? null, nivel2: f.organo_nivel2 ?? null, nivel3: f.organo_nivel3 ?? null },
  }));
}

export function borrarGanadasHuerfanas(db: DatabaseSync): void {
  db.prepare('DELETE FROM ganadas_parecidas WHERE nif NOT IN (SELECT nif FROM organizaciones_parecidas)').run();
}

export interface OrigenDescubierta {
  nif: string;
  nombre: string;
  numeroPrevio: string;
  anioPrevio: number | null;
}

/** Reconstruye todas las etiquetas 'parecidas' con lo calculado en esta ejecución (las de organizaciones desactivadas desaparecen). */
export function reemplazarOrigenesParecidas(db: DatabaseSync, origenes: Map<string, OrigenDescubierta[]>): void {
  transaccion(db, () => {
    db.prepare("DELETE FROM origenes_convocatoria WHERE origen = 'parecidas'").run();
    const q = db.prepare("INSERT OR IGNORE INTO origenes_convocatoria (convocatoria_id, origen, nif, nombre, numero_previo, anio_previo) VALUES (?, 'parecidas', ?, ?, ?, ?)");
    for (const [id, lista] of origenes) for (const o of lista) q.run(id, o.nif, o.nombre, o.numeroPrevio, o.anioPrevio);
  });
}

/** Etiquetas de origen 'parecidas' de una convocatoria. */
export function origenesDe(db: DatabaseSync, convocatoriaId: string): OrigenDescubierta[] {
  return (db.prepare("SELECT nif, nombre, numero_previo, anio_previo FROM origenes_convocatoria WHERE convocatoria_id = ? AND origen = 'parecidas' ORDER BY anio_previo DESC, nombre").all(convocatoriaId) as
    { nif: string; nombre: string; numero_previo: string; anio_previo: number | null }[])
    .map((f) => ({ nif: f.nif, nombre: f.nombre, numeroPrevio: f.numero_previo, anioPrevio: f.anio_previo }));
}

export const marcarDescubierta = (db: DatabaseSync, id: string): void => { db.prepare('INSERT OR IGNORE INTO descubiertas_parecidas (convocatoria_id) VALUES (?)').run(id); };
export const quitarMarcaDescubierta = (db: DatabaseSync, id: string): void => { db.prepare('DELETE FROM descubiertas_parecidas WHERE convocatoria_id = ?').run(id); };
export const existeConvocatoria = (db: DatabaseSync, id: string): boolean => db.prepare('SELECT 1 FROM convocatorias WHERE id = ?').get(id) !== undefined;

// --- Historial de series: datos fiables de cada edición (detalle de BDNS) ---

export interface DetalleEdicion {
  fechaPublicacion: string | null;
  inicioSolicitud: string | null;
  finSolicitud: string | null;
  presupuesto: number | null;
}

export function guardarDetalleEdicion(db: DatabaseSync, numero: string, d: DetalleEdicion, ahora: Date): void {
  db.prepare(`INSERT INTO ediciones_detalle (numero_convocatoria, fecha_publicacion, inicio_solicitud, fin_solicitud, presupuesto, detalle_en) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (numero_convocatoria) DO UPDATE SET fecha_publicacion = excluded.fecha_publicacion, inicio_solicitud = excluded.inicio_solicitud,
      fin_solicitud = excluded.fin_solicitud, presupuesto = excluded.presupuesto, detalle_en = excluded.detalle_en`)
    .run(numero, d.fechaPublicacion, d.inicioSolicitud, d.finSolicitud, d.presupuesto, ahora.toISOString());
}

/** Ediciones (de las series dadas) de las que aún no se ha traído el detalle y que no están guardadas como convocatoria. Más recientes primero. */
export function edicionesSinDetalle(db: DatabaseSync, series: string[]): { numero: string; serie: string; anio: number | null }[] {
  if (series.length === 0) return [];
  const marcas = series.map(() => '?').join(',');
  return (db.prepare(`SELECT numero_convocatoria AS numero, serie, anio FROM ediciones_serie es
    WHERE serie IN (${marcas}) AND NOT EXISTS (SELECT 1 FROM ediciones_detalle d WHERE d.numero_convocatoria = es.numero_convocatoria) AND NOT EXISTS (SELECT 1 FROM convocatorias c WHERE c.id = 'bdns:' || es.numero_convocatoria)
    ORDER BY anio DESC, numero_convocatoria DESC`).all(...series) as { numero: string; serie: string; anio: number | null }[]);
}

export interface FalloEdicion { intentos: number; ultimoEn: string }

/** Apunta un fallo al traer el detalle de una edición; devuelve cuántos intentos fallidos lleva. */
export function apuntarFalloEdicion(db: DatabaseSync, numero: string, error: string, ahora: Date): number {
  db.prepare(`INSERT INTO ediciones_fallos (numero_convocatoria, intentos, ultimo_error, ultimo_en) VALUES (?, 1, ?, ?)
    ON CONFLICT (numero_convocatoria) DO UPDATE SET intentos = intentos + 1, ultimo_error = excluded.ultimo_error, ultimo_en = excluded.ultimo_en`)
    .run(numero, error.slice(0, 300), ahora.toISOString());
  return Number((db.prepare('SELECT intentos FROM ediciones_fallos WHERE numero_convocatoria = ?').get(numero) as { intentos: number }).intentos);
}

export function fallosDeEdiciones(db: DatabaseSync): Map<string, FalloEdicion> {
  return new Map((db.prepare('SELECT numero_convocatoria AS n, intentos, ultimo_en FROM ediciones_fallos').all() as { n: string; intentos: number; ultimo_en: string }[])
    .map((f) => [f.n, { intentos: f.intentos, ultimoEn: f.ultimo_en }]));
}

export function borrarFalloEdicion(db: DatabaseSync, numero: string): void {
  db.prepare('DELETE FROM ediciones_fallos WHERE numero_convocatoria = ?').run(numero);
}
