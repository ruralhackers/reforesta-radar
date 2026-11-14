// Memorias anuales de la propia entidad: qué ha hecho (proyectos_propios) y quién la ha financiado (financiadores_propios), con la cita literal
// de cada dato. Una memoria = un documento por URL; se guarda con el hash de lo leído para no volver a extraerla si no ha cambiado.
import type { DatabaseSync } from 'node:sqlite';
import { claveEmpresa } from './empresas.ts';
import { transaccion } from './repo.ts';

export type TipoFinanciador = 'fundacion' | 'empresa' | 'administracion' | 'otro';
export const TIPOS_FINANCIADOR: readonly TipoFinanciador[] = ['fundacion', 'empresa', 'administracion', 'otro'];
export type RelacionFinanciador = 'financiacion' | 'voluntariado_corporativo' | 'otra';
export const RELACIONES_FINANCIADOR: readonly RelacionFinanciador[] = ['financiacion', 'voluntariado_corporativo', 'otra'];

export interface DatoProyecto { concepto: string; etiqueta: string; valor: string; cita: string }
export interface Metrica { nombre: string; valor: string; cita: string }

export interface ProyectoPropio {
  id: number;
  memoriaUrl: string;
  nombre: string;
  anio: number | null;
  lugar: string;
  municipio: string;
  provincia: string;
  linea: string;
  descripcion: string;
  socios: string[];
  financiadores: string[];
  datos: DatoProyecto[];
  cita: string;
}

export interface FinanciadorPropio {
  id: number;
  memoriaUrl: string;
  nombre: string;
  clave: string;
  tipo: TipoFinanciador;
  relacion: RelacionFinanciador;
  anio: number | null;
  cita: string;
}

export interface MemoriaExtraida {
  url: string;
  hash: string;
  anio: number | null;
  modelo: string;
  paginas: number | null;
  metricas: Metrica[];
  correcciones: string[];
  proyectos: Omit<ProyectoPropio, 'id' | 'memoriaUrl'>[];
  financiadores: Omit<FinanciadorPropio, 'id' | 'memoriaUrl' | 'clave' | 'anio'>[];
}

const FORMAS = new Set(['sl', 'slu', 'sa', 'sau', 'sll', 'scoop', 'coop', 'fundacion', 'fundaciones', 'asociacion', 'de', 'del', 'la', 'el', 'los', 'las', 'y']);

/**
 * Clave para casar un financiador con una empresa o una fundación por nombre: la forma canónica de `claveEmpresa` sin forma societaria, sin «fundación»
 * ni artículos («Fundación Montemadrid» = «Montemadrid» = «Fundacion MONTEMADRID»). Vacía si no queda nada.
 */
export function claveFinanciador(nombre: string | null | undefined): string {
  return claveEmpresa(nombre).split(' ').filter((t) => t && !FORMAS.has(t)).join(' ');
}

/** Guarda (sustituyendo lo anterior de esa URL) una memoria con sus proyectos y financiadores. */
export function guardarMemoria(db: DatabaseSync, m: MemoriaExtraida, ahora: Date): void {
  transaccion(db, () => {
    db.prepare('DELETE FROM proyectos_propios WHERE memoria_url = ?').run(m.url);
    db.prepare('DELETE FROM financiadores_propios WHERE memoria_url = ?').run(m.url);
    db.prepare(`
      INSERT INTO memorias (url, hash, anio, modelo, paginas, metricas, correcciones, procesada_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (url) DO UPDATE SET hash = excluded.hash, anio = excluded.anio, modelo = excluded.modelo, paginas = excluded.paginas,
        metricas = excluded.metricas, correcciones = excluded.correcciones, procesada_en = excluded.procesada_en
    `).run(m.url, m.hash, m.anio, m.modelo, m.paginas, JSON.stringify(m.metricas), JSON.stringify(m.correcciones), ahora.toISOString());
    const pro = db.prepare(`INSERT INTO proyectos_propios (memoria_url, nombre, anio, lugar, municipio, provincia, linea, descripcion, socios, financiadores, datos, cita)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of m.proyectos) pro.run(m.url, p.nombre, p.anio, p.lugar, p.municipio, p.provincia, p.linea, p.descripcion, JSON.stringify(p.socios), JSON.stringify(p.financiadores), JSON.stringify(p.datos), p.cita);
    const fin = db.prepare('INSERT INTO financiadores_propios (memoria_url, nombre, clave, tipo, relacion, anio, cita) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of m.financiadores) fin.run(m.url, f.nombre, claveFinanciador(f.nombre), f.tipo, f.relacion, m.anio, f.cita);
  });
}

/** Hash con el que se extrajo la memoria de esa URL (null = nunca). */
export function hashMemoria(db: DatabaseSync, url: string): string | null {
  return (db.prepare('SELECT hash FROM memorias WHERE url = ?').get(url) as { hash: string } | undefined)?.hash ?? null;
}

export interface ResumenMemoria {
  url: string;
  anio: number | null;
  proyectos: number;
  financiadores: number;
  metricas: Metrica[];
  procesadaEn: string;
}

/** Una fila por memoria procesada (año, luego URL), con cuántos proyectos y financiadores salieron de ella. */
export function resumenMemorias(db: DatabaseSync): ResumenMemoria[] {
  const filas = db.prepare(`
    SELECT m.url, m.anio, m.metricas, m.procesada_en,
      (SELECT COUNT(*) FROM proyectos_propios p WHERE p.memoria_url = m.url) AS proyectos,
      (SELECT COUNT(*) FROM financiadores_propios f WHERE f.memoria_url = m.url) AS financiadores
    FROM memorias m ORDER BY m.anio DESC, m.url
  `).all() as Record<string, unknown>[];
  return filas.map((f) => ({
    url: String(f.url), anio: (f.anio as number | null) ?? null, proyectos: Number(f.proyectos), financiadores: Number(f.financiadores),
    metricas: JSON.parse(String(f.metricas)) as Metrica[], procesadaEn: String(f.procesada_en),
  }));
}

export const hayMemorias = (db: DatabaseSync): boolean => !!db.prepare('SELECT 1 FROM memorias LIMIT 1').get();

function aProyecto(f: Record<string, unknown>): ProyectoPropio {
  return {
    id: Number(f.id), memoriaUrl: String(f.memoria_url), nombre: String(f.nombre), anio: (f.anio as number | null) ?? null, lugar: String(f.lugar), municipio: String(f.municipio),
    provincia: String(f.provincia), linea: String(f.linea), descripcion: String(f.descripcion), socios: JSON.parse(String(f.socios)) as string[],
    financiadores: JSON.parse(String(f.financiadores)) as string[], datos: JSON.parse(String(f.datos)) as DatoProyecto[], cita: String(f.cita),
  };
}

/** Todos los proyectos guardados, del más reciente al más antiguo y, a igual año, por nombre (orden estable). */
export function proyectosPropios(db: DatabaseSync): ProyectoPropio[] {
  return (db.prepare('SELECT * FROM proyectos_propios ORDER BY anio DESC, nombre, id').all() as Record<string, unknown>[]).map(aProyecto);
}

export function financiadoresPropios(db: DatabaseSync): FinanciadorPropio[] {
  return (db.prepare('SELECT * FROM financiadores_propios ORDER BY anio, nombre, id').all() as Record<string, unknown>[]).map((f) => ({
    id: Number(f.id), memoriaUrl: String(f.memoria_url), nombre: String(f.nombre), clave: String(f.clave), tipo: f.tipo as TipoFinanciador,
    relacion: f.relacion as RelacionFinanciador, anio: (f.anio as number | null) ?? null, cita: String(f.cita),
  }));
}

/** Lo que consta de una entidad que ya figura como financiadora en alguna memoria. */
export interface YaFinanciador {
  /** Nombre tal y como lo escribe la memoria (el de la primera vez que aparece). */
  nombre: string;
  /** Años de las memorias donde figura, de menor a mayor. */
  anios: number[];
  /** `financiacion` si en alguna figura como financiadora; si no, la relación que consta (voluntariado corporativo u otra). */
  relacion: RelacionFinanciador;
}

export interface FinanciadoresConocidos {
  /** Para casar con empresas: financiadores que no son fundaciones ni administraciones. */
  empresas: Map<string, YaFinanciador>;
  /** Para casar con fundaciones vigiladas: financiadores de tipo fundación. */
  fundaciones: Map<string, YaFinanciador>;
}

/** Financiadores de las memorias agrupados por clave (nombre normalizado) y por tipo. Las administraciones no se casan con nada (no son empresas ni fundaciones). */
export function financiadoresConocidos(db: DatabaseSync): FinanciadoresConocidos {
  const r: FinanciadoresConocidos = { empresas: new Map(), fundaciones: new Map() };
  for (const f of financiadoresPropios(db)) {
    if (!f.clave || f.tipo === 'administracion') continue;
    const mapa = f.tipo === 'fundacion' ? r.fundaciones : r.empresas;
    const previo = mapa.get(f.clave);
    const anios = new Set([...(previo?.anios ?? []), ...(f.anio === null ? [] : [f.anio])]);
    mapa.set(f.clave, {
      nombre: previo?.nombre ?? f.nombre, anios: [...anios].sort((a, b) => a - b),
      relacion: previo?.relacion === 'financiacion' || f.relacion === 'financiacion' ? 'financiacion' : (previo?.relacion ?? f.relacion),
    });
  }
  return r;
}
