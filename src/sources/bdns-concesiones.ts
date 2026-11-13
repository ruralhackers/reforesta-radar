// Concesiones (ganadores) de BDNS. Ojo: en /concesiones/busqueda el filtro por convocatoria es `numeroConvocatoria`;
// `numConv` se ignora en silencio y devuelve los 31,8 millones de concesiones. Solo hay concesiones desde 2022-01-01.
import { aFechaBdns } from '../dates.ts';
import { getJson } from './bdns.ts';

export const CONCESIONES_DESDE = '2022-01-01';
const PAGINA = 200;
const MAX_PAGINAS = 10;

export interface ConcesionBdns {
  id: number;
  fechaConcesion: string | null;
  beneficiario: string;
  importe: number | null;
  urlBR: string | null;
  numeroConvocatoria: string;
  idConvocatoria: number | null;
  convocatoria: string;
  nivel1: string | null;
  nivel2: string | null;
  nivel3: string | null;
  idPersona: number | null;
}

export interface EdicionBdns {
  numeroConvocatoria: string;
  descripcion: string;
  fechaRecepcion: string;
  nivel1: string | null;
  nivel2: string | null;
  nivel3: string | null;
}

interface Pagina<T> { content: T[]; last: boolean }

async function todasLasPaginas<T>(f: typeof fetch, ruta: string, filtros: Record<string, string | number>): Promise<T[]> {
  const filas: T[] = [];
  for (let page = 0; page < MAX_PAGINAS; page++) {
    const p = await getJson<Pagina<T>>(f, ruta, { page, pageSize: PAGINA, ...filtros });
    filas.push(...p.content);
    if (p.last || p.content.length === 0) break;
  }
  return filas;
}

/** Todos los ganadores de una convocatoria. */
export function concesionesDeConvocatoria(f: typeof fetch, numeroConvocatoria: string): Promise<ConcesionBdns[]> {
  return todasLasPaginas<ConcesionBdns>(f, '/concesiones/busqueda', { numeroConvocatoria });
}

/** Las concesiones de una entidad por NIF/CIF. */
export function concesionesDeNif(f: typeof fetch, nif: string): Promise<ConcesionBdns[]> {
  return todasLasPaginas<ConcesionBdns>(f, '/concesiones/busqueda', { nifCif: nif });
}

/** Convocatorias cuyo título contiene `texto` (sin años), desde 2022 hasta `hoy` (YYYY-MM-DD). Hay que filtrar después: la búsqueda es por texto. */
export async function buscarConvocatoriasPorTitulo(f: typeof fetch, texto: string, hoy: string): Promise<EdicionBdns[]> {
  return todasLasPaginas<EdicionBdns>(f, '/convocatorias/busqueda', {
    descripcion: texto, fechaDesde: aFechaBdns(CONCESIONES_DESDE), fechaHasta: aFechaBdns(hoy),
  });
}
