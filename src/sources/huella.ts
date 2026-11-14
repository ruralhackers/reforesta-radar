// Registro de huella de carbono, compensación y proyectos de absorción de CO2 del MITECO (https://www.miteco.gob.es/es/cambio-climatico/temas/registro-huella.html).
// El MITECO publica tres listados en Excel (.xlsx) que actualiza de forma periódica; aquí se usan los dos que dicen QUIÉN es la organización:
//   - listadohuelladecarbono.xlsx  hoja «LISTADO»: una fila por huella inscrita (organización, NIF, sector, año, CCAA, tamaño, sello CALCULO / REDUZCO / COMPENSO, alcance, huella total…). ~22 MB, ~22 000 filas.
//   - listadodecompensacion.xlsx   hoja «Listado COMPENSACIONES»: organización, año de la huella compensada, proyecto de absorción, tCO2 retiradas… (sin NIF).
//   - listadoproyectosdeabsorcion.xlsx hojas «PROYECTOS DE ABSORCIÓN» y «BAJAS»: nombre, provincia, CCAA, promotor, tCO2 previstas y retiradas, código del proyecto (~1 MB). No dice quién compensa,
//     pero con el código del proyecto (prefijo de «CÓDIGO TONELADAS RETIRADAS» en las compensaciones) se sabe dónde está el proyecto con el que compensó cada organización.
// Hosts y rutas fijos en www.miteco.gob.es. El servidor corta las descargas largas a los 16 MiB, así que se piden por trozos con Range.
import { createHash } from 'node:crypto';
import { fechaExcel, filasXlsx } from './xlsx.ts';

const BASE = 'https://www.miteco.gob.es/content/dam/miteco/es/cambio-climatico/temas/registro-huella/listados';
export const URL_HUELLA = `${BASE}/listadohuelladecarbono.xlsx`;
export const URL_COMPENSACION = `${BASE}/listadodecompensacion.xlsx`;
export const URL_PROYECTOS = `${BASE}/listadoproyectosdeabsorcion.xlsx`;
export const HOJA_PROYECTOS = 'PROYECTOS DE ABSORCIÓN';
export const HOJA_BAJAS = 'BAJAS';
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
  let etagVisto = '';
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
    const fin = Number(m[2]);
    const totalTrozo = Number(m[3]);
    const version = `${r.headers.get('etag') ?? ''}|${r.headers.get('last-modified') ?? ''}`;
    const etag = r.headers.get('etag') ?? '';
    if (fin < pos || fin >= totalTrozo || fin - pos + 1 > TROZO) throw new Error('Respuesta de rango inesperada');
    if (totalTrozo > o.maxBytes) throw new Error(`El fichero pesa ${totalTrozo} bytes (tope ${o.maxBytes})`);
    if (pos === 0) {
      total = totalTrozo;
      firma = `${version}|${total}`;
      if (o.saltarSiFirma && o.saltarSiFirma === firma) { await r.body?.cancel(); return null; }
    } else if (totalTrozo !== total) {
      throw new Error('El fichero cambió durante la descarga'); // el tamaño total anunciado debe ser el mismo en todos los trozos
    }
    // El ETag, cuando viene, debe ser el mismo en todos los trozos. Solo ETag: la CDN del MITECO sirve los primeros 16 MiB (la parte que corta) sin ETag y con otra
    // Last-Modified que el resto, y la comparación estricta de cabeceras haría imposible bajar el listado real.
    if (etag) {
      if (etagVisto && etag !== etagVisto) throw new Error('El fichero cambió durante la descarga');
      etagVisto = etag;
    }
    const trozo = Buffer.from(await r.arrayBuffer());
    if (trozo.length === 0) throw new Error('Trozo vacío');
    // Lo recibido tiene que ser justo lo anunciado: ni más de lo pedido ni más del tope en total.
    if (trozo.length !== fin - pos + 1) throw new Error('Trozo de tamaño distinto al anunciado');
    if (pos + trozo.length > o.maxBytes || pos + trozo.length > total) throw new Error(`La descarga supera el tope de ${o.maxBytes} bytes`);
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
  /** «CÓDIGO TONELADAS RETIRADAS»: «<código del proyecto>/<tramo>». */
  toneladas: string;
  fecha: string;
}

export interface FilaProyecto {
  fila: number;
  /** Código del proyecto (p. ej. «2017-b013»): el de las compensaciones es «<código>/<tramo>». */
  codigo: string;
  nombre: string;
  localizacion: string;
  provincia: string;
  ccaa: string;
  hectareas: string;
  prevista: string;
  retirada: string;
  promotor: string;
  /** AAAA-MM-DD o ''. */
  inscrito: string;
  /** Viene de la hoja «BAJAS»: el proyecto ya no está en el registro. */
  baja: boolean;
}

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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
  const ix = indices(cab.celdas, { org: 'organizacion', anio: 'ano de la huella', proyecto: 'proyecto de absorcion', tco2: 'absorciones retiradas', codigo: 'codigo compensacion', toneladas: 'codigo toneladas', fecha: 'fecha de la compensacion' });
  const salida: FilaCompensacion[] = [];
  for (const f of filas) {
    if (f.fila <= cab.fila) continue;
    const c = (k: string) => (f.celdas[ix[k]] ?? '').trim();
    if (!c('org')) continue;
    salida.push({ fila: f.fila, organizacion: c('org'), anioHuella: Number(c('anio')) || 0, proyecto: c('proyecto'), tco2: c('tco2'), codigo: c('codigo'), toneladas: c('toneladas'), fecha: fechaExcel(c('fecha')) ?? '' });
  }
  return salida;
}

const prefijoCodigo = (v: string) => v.trim().split('/')[0].trim();

/** Proyectos de absorción inscritos (hoja principal) y dados de baja (hoja «BAJAS», donde el promotor se llama «Desarrollador»). Se localizan por el nombre de las columnas. */
export function leerListadoProyectos(xlsx: Buffer): FilaProyecto[] {
  const salida: FilaProyecto[] = [];
  for (const baja of [false, true]) {
    const filas = filasXlsx(xlsx, baja ? HOJA_BAJAS : HOJA_PROYECTOS);
    const cab = filas.find((f) => f.celdas.some((c) => norm(c ?? '') === 'nombre del proyecto'));
    if (!cab) throw new Error(`No se encuentra la cabecera de la hoja «${baja ? HOJA_BAJAS : HOJA_PROYECTOS}» de proyectos de absorción`);
    const ix = indices(cab.celdas, {
      nombre: 'nombre del proyecto', localizacion: 'localizacion', provincia: 'provincia', ccaa: 'ccaa', ha: 'superficie', prevista: 'absorcion prevista', retirada: 'absorciones retiradas',
      promotor: baja ? 'desarrollador' : 'promotor del proyecto', inscrito: 'fecha de inscripcion', cod: 'cod t disponibles',
    });
    for (const f of filas) {
      if (f.fila <= cab.fila) continue;
      const c = (k: string) => (f.celdas[ix[k]] ?? '').trim();
      if (!c('nombre')) continue;
      const codigo = prefijoCodigo(c('cod'));
      if (!codigo) continue;
      salida.push({
        fila: f.fila, codigo, nombre: c('nombre'), localizacion: c('localizacion'), provincia: c('provincia'), ccaa: c('ccaa'), hectareas: c('ha'), prevista: c('prevista'), retirada: c('retirada'),
        promotor: c('promotor'), inscrito: fechaExcel(c('inscrito')) ?? '', baja,
      });
    }
  }
  return salida;
}

/** Código del proyecto con el que se compensó (el prefijo de «CÓDIGO TONELADAS RETIRADAS»), o ''. */
export const codigoProyectoDe = (c: FilaCompensacion) => prefijoCodigo(c.toneladas);

export function textoProyecto(p: FilaProyecto): string {
  return `PROYECTO DE ABSORCIÓN: ${p.nombre} | LOCALIZACIÓN: ${p.localizacion} | PROVINCIA: ${p.provincia} | CCAA: ${p.ccaa} | PROMOTOR: ${p.promotor} | ABSORCIÓN PREVISTA (tCO2): ${p.prevista} | CÓDIGO: ${p.codigo}`;
}

/** La fila de una compensación con su fecha (la que se cita en la señal de compra de absorción). */
export const textoCompra = (c: FilaCompensacion) => `${textoCompensacion(c)}${c.fecha ? ` | FECHA DE LA COMPENSACIÓN: ${c.fecha}` : ''}`;

/** El texto literal de una fila del registro (lo que se cita), con las etiquetas de sus columnas. */
export function textoFila(f: FilaHuella): string {
  return `ORGANIZACIÓN: ${f.nombre} | NIF: ${f.nif || '-'} | SECTOR: ${f.sector} | AÑO: ${f.anio} | CCAA: ${f.ccaa} | TAMAÑO: ${f.tamano} | SELLO: ${f.sello} | ALCANCE: ${f.alcance} | VERIFICA: ${f.verifica} | HUELLA TOTAL (tCO2e): ${f.huellaTotal}`;
}

export function textoCompensacion(c: FilaCompensacion): string {
  return `COMPENSACIÓN: ${c.organizacion} | AÑO DE LA HUELLA COMPENSADA: ${c.anioHuella || '-'} | PROYECTO DE ABSORCIÓN: ${c.proyecto} | ABSORCIONES RETIRADAS (tCO2): ${c.tco2} | CÓDIGO: ${c.codigo}`;
}

/** Para casar nombres de proyecto entre listados (mayúsculas, acentos y puntuación no cuentan). */
export const sinAcentosNombre = norm;

export const hash = (t: string) => createHash('sha256').update(t).digest('hex');
