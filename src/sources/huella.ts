// Registro de huella de carbono, compensación y proyectos de absorción de CO2 del MITECO (https://www.miteco.gob.es/es/cambio-climatico/temas/registro-huella.html).
// El MITECO publica tres listados en Excel (.xlsx) que actualiza de forma periódica; aquí se usan los dos que dicen QUIÉN es la organización:
//   - listadohuelladecarbono.xlsx  hoja «LISTADO»: una fila por huella inscrita (organización, NIF, sector, año, CCAA, tamaño, sello CALCULO / REDUZCO / COMPENSO, alcance, huella total…). ~22 MB, ~22 000 filas.
//   - listadodecompensacion.xlsx   hoja «Listado COMPENSACIONES»: organización, año de la huella compensada, proyecto de absorción, tCO2 retiradas… (sin NIF).
// (listadoproyectosdeabsorcion.xlsx lista los promotores de los proyectos, no a quienes compensan: no se usa.)
// Hosts y rutas fijos en www.miteco.gob.es. El servidor corta las descargas largas a los 16 MiB, así que se piden por trozos con Range.
import { createHash } from 'node:crypto';
import { fechaExcel, filasXlsx } from './xlsx.ts';

const BASE = 'https://www.miteco.gob.es/content/dam/miteco/es/cambio-climatico/temas/registro-huella/listados';
export const URL_HUELLA = `${BASE}/listadohuelladecarbono.xlsx`;
export const URL_COMPENSACION = `${BASE}/listadodecompensacion.xlsx`;
export const HOJA_HUELLA = 'LISTADO';
export const HOJA_COMPENSACION = 'Listado COMPENSACIONES';
const USER_AGENT = 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)';
const TROZO = 8 * 1024 * 1024;

export interface Descarga {
  datos: Buffer;
  /** Identifica la versión del fichero (ETag, última modificación y tamaño): igual = no ha cambiado. */
  firma: string;
}

/** Descarga por trozos (Range). Si el servidor ignora Range y devuelve el cuerpo entero, se acepta. `null` si `saltarSiFirma` coincide con la del fichero (no se baja el resto). */
export async function descargarFichero(f: typeof fetch, url: string, o: { timeoutMs: number; maxBytes: number; saltarSiFirma?: string | null }): Promise<Descarga | null> {
  if (!url.startsWith(`${BASE}/`)) throw new Error('URL fuera del registro del MITECO');
  const partes: Buffer[] = [];
  let pos = 0;
  let total = Infinity;
  let firma = '';
  while (pos < total) {
    const r = await f(url, { headers: { 'User-Agent': USER_AGENT, Range: `bytes=${pos}-${pos + TROZO - 1}` }, signal: AbortSignal.timeout(o.timeoutMs), redirect: 'manual' });
    if (r.status === 200 && pos === 0) {
      const largo = Number(r.headers.get('content-length') ?? 0);
      if (largo > o.maxBytes) throw new Error(`El fichero pesa ${largo} bytes (tope ${o.maxBytes})`);
      const datos = Buffer.from(await r.arrayBuffer());
      if (datos.length > o.maxBytes) throw new Error(`El fichero supera el tope de ${o.maxBytes} bytes`);
      firma = `${r.headers.get('etag') ?? ''}|${r.headers.get('last-modified') ?? ''}|${datos.length}`;
      return o.saltarSiFirma && o.saltarSiFirma === firma ? null : { datos, firma };
    }
    if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
    if (!m || Number(m[1]) !== pos) throw new Error('Respuesta de rango inesperada');
    total = Number(m[3]);
    if (total > o.maxBytes) throw new Error(`El fichero pesa ${total} bytes (tope ${o.maxBytes})`);
    if (pos === 0) {
      firma = `${r.headers.get('etag') ?? ''}|${r.headers.get('last-modified') ?? ''}|${total}`;
      if (o.saltarSiFirma && o.saltarSiFirma === firma) { await r.body?.cancel(); return null; }
    }
    const trozo = Buffer.from(await r.arrayBuffer());
    if (trozo.length === 0) throw new Error('Trozo vacío');
    partes.push(trozo);
    pos += trozo.length;
  }
  return { datos: Buffer.concat(partes), firma };
}

export interface FilaHuella {
  /** Fila de la hoja (para localizarla en el fichero). */
  fila: number;
  nombre: string;
  /** NIF/CIF tal cual ('' si consta «-»). */
  nif: string;
  sector: string;
  anio: number;
  ccaa: string;
  tamano: string;
  sello: string;
  alcance: string;
  verifica: string;
  huellaTotal: string;
  /** AAAA-MM-DD o ''. */
  inscrita: string;
}

export interface FilaCompensacion {
  fila: number;
  organizacion: string;
  anioHuella: number;
  proyecto: string;
  tco2: string;
  codigo: string;
  fecha: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function indices(cabecera: string[], nombres: Record<string, string>): Record<string, number> {
  const salida: Record<string, number> = {};
  const h = cabecera.map(norm);
  for (const [clave, prefijo] of Object.entries(nombres)) {
    const i = h.findIndex((c) => c.startsWith(prefijo));
    if (i < 0) throw new Error(`Falta la columna «${prefijo}» en el listado del registro (¿ha cambiado el formato?)`);
    salida[clave] = i;
  }
  return salida;
}

const limpiarNif = (v: string) => (/^[-–\s]*$/.test(v) ? '' : v.replace(/[\s.-]/g, '').toUpperCase());

export function leerListadoHuella(xlsx: Buffer): FilaHuella[] {
  const filas = filasXlsx(xlsx, HOJA_HUELLA);
  const cab = filas.find((f) => f.celdas.some((c) => norm(c ?? '').startsWith('nombre organizacion')));
  if (!cab) throw new Error('No se encuentra la cabecera del listado de huellas');
  const ix = indices(cab.celdas, { nombre: 'nombre organizacion', nif: 'nif', sector: 'sector', anio: 'ano', ccaa: 'ccaa', tamano: 'tamano', sello: 'sello', alcance: 'alcance', verifica: 'verifica', total: 'huella total', inscrita: 'fecha inscripcion' });
  const salida: FilaHuella[] = [];
  for (const f of filas) {
    if (f.fila <= cab.fila) continue;
    const c = (k: string) => (f.celdas[ix[k]] ?? '').trim();
    const anio = Number(c('anio'));
    if (!c('nombre') || !Number.isInteger(anio)) continue;
    salida.push({
      fila: f.fila, nombre: c('nombre'), nif: limpiarNif(c('nif')), sector: c('sector'), anio, ccaa: c('ccaa'), tamano: c('tamano'), sello: c('sello'),
      alcance: c('alcance'), verifica: c('verifica'), huellaTotal: c('total'), inscrita: fechaExcel(c('inscrita')) ?? '',
    });
  }
  return salida;
}

export function leerListadoCompensacion(xlsx: Buffer): FilaCompensacion[] {
  const filas = filasXlsx(xlsx, HOJA_COMPENSACION);
  const cab = filas.find((f) => f.celdas.some((c) => norm(c ?? '') === 'organizacion'));
  if (!cab) throw new Error('No se encuentra la cabecera del listado de compensaciones');
  const ix = indices(cab.celdas, { org: 'organizacion', anio: 'ano de la huella', proyecto: 'proyecto de absorcion', tco2: 'absorciones retiradas', codigo: 'codigo compensacion', fecha: 'fecha de la compensacion' });
  const salida: FilaCompensacion[] = [];
  for (const f of filas) {
    if (f.fila <= cab.fila) continue;
    const c = (k: string) => (f.celdas[ix[k]] ?? '').trim();
    if (!c('org')) continue;
    salida.push({ fila: f.fila, organizacion: c('org'), anioHuella: Number(c('anio')) || 0, proyecto: c('proyecto'), tco2: c('tco2'), codigo: c('codigo'), fecha: fechaExcel(c('fecha')) ?? '' });
  }
  return salida;
}

/** El texto literal de una fila del registro (lo que se cita), con las etiquetas de sus columnas. */
export function textoFila(f: FilaHuella): string {
  return `ORGANIZACIÓN: ${f.nombre} | NIF: ${f.nif || '-'} | SECTOR: ${f.sector} | AÑO: ${f.anio} | CCAA: ${f.ccaa} | TAMAÑO: ${f.tamano} | SELLO: ${f.sello} | ALCANCE: ${f.alcance} | VERIFICA: ${f.verifica} | HUELLA TOTAL (tCO2e): ${f.huellaTotal}`;
}

export function textoCompensacion(c: FilaCompensacion): string {
  return `COMPENSACIÓN: ${c.organizacion} | AÑO DE LA HUELLA COMPENSADA: ${c.anioHuella || '-'} | PROYECTO DE ABSORCIÓN: ${c.proyecto} | ABSORCIONES RETIRADAS (tCO2): ${c.tco2} | CÓDIGO: ${c.codigo}`;
}

export const hash = (t: string) => createHash('sha256').update(t).digest('hex');
