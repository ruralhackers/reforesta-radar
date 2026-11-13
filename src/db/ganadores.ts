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
}

export function edicionesDeSerie(db: DatabaseSync, serie: string): Edicion[] {
  const filas = db.prepare('SELECT numero_convocatoria, titulo, anio FROM ediciones_serie WHERE serie = ? ORDER BY anio DESC, numero_convocatoria DESC')
    .all(serie) as { numero_convocatoria: string; titulo: string; anio: number | null }[];
  return filas.map((f) => ({ numeroConvocatoria: f.numero_convocatoria, titulo: f.titulo, anio: f.anio }));
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
