// Apoyo a los tests del registro de huella de carbono: un extracto REAL (test/fixtures/huella/extracto.json, ver scripts/record-huella.ts) convertido
// en .xlsx de verdad (un zip con XML, como los del MITECO) y un fetch que lo sirve con soporte de Range (el servidor real corta a los 16 MiB).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { URL_COMPENSACION, URL_HUELLA, URL_PROYECTOS } from '../../src/sources/huella.ts';

export interface Extracto {
  descargado: string;
  huella: { hoja: string; cabecera: string[]; filas: string[][] };
  compensacion: { hoja: string; cabecera: string[]; filas: string[][] };
}

export const extracto: Extracto = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'huella', 'extracto.json'), 'utf8'));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const letra = (i: number) => String.fromCharCode(65 + i);

/** Zip mínimo (deflate) con las entradas dadas. */
export function zip(entradas: Record<string, string>): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let pos = 0;
  for (const [nombre, texto] of Object.entries(entradas)) {
    const datos = Buffer.from(texto, 'utf8');
    const comp = deflateRawSync(datos);
    const n = Buffer.from(nombre);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc32(datos), 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(datos.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(datos), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(datos.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(pos, 42);
    locales.push(l, n, comp);
    centrales.push(c, n);
    pos += 30 + n.length + comp.length;
  }
  const dc = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(Object.keys(entradas).length, 8); fin.writeUInt16LE(Object.keys(entradas).length, 10); fin.writeUInt32LE(dc.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...locales, dc, fin]);
}

/** .xlsx de una hoja visible (y otra oculta con basura) con la cabecera en `filaCabecera`, como los listados del MITECO (cadenas compartidas, números sueltos). */
export function construirXlsx(hoja: string, cabecera: string[], filas: string[][], filaCabecera: number): Buffer {
  const compartidas: string[] = [];
  const idx = (s: string) => { let i = compartidas.indexOf(s); if (i < 0) { i = compartidas.length; compartidas.push(s); } return i; };
  const fila = (n: number, celdas: string[]) => `<row r="${n}">${celdas.map((c, i) => (c === '' ? '' : /^\d+(\.\d+)?$/.test(c) && c.length < 9 ? `<c r="${letra(i)}${n}"><v>${c}</v></c>` : `<c r="${letra(i)}${n}" t="s"><v>${idx(c)}</v></c>`)).join('')}</row>`;
  const todas = [fila(2, ['', 'Portada, no es un dato']), fila(filaCabecera, cabecera), ...filas.map((f, i) => fila(filaCabecera + 1 + i, f))].join('');
  return zip({
    'xl/workbook.xml': `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(hoja)}" sheetId="1" r:id="rId1"/><sheet name="DATOS" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${todas}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>basura</t></is></c></row></sheetData></worksheet>',
    'xl/sharedStrings.xml': `<sst>${compartidas.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
  });
}

export const xlsxHuella = (filas = extracto.huella.filas) => construirXlsx(extracto.huella.hoja, extracto.huella.cabecera, filas, 8);
export const xlsxCompensacion = (filas = extracto.compensacion.filas) => construirXlsx(extracto.compensacion.hoja, extracto.compensacion.cabecera, filas, 9);

export interface OpcionesFetchHuella {
  huella?: Buffer;
  compensacion?: Buffer;
  /** Listado de proyectos de absorción (sin él, 404). */
  proyectos?: Buffer;
  /** Estado HTTP que sustituye al fichero (p. ej. 503). */
  fallo?: { huella?: number; compensacion?: number };
  /** El servidor ignora Range y devuelve el cuerpo entero. */
  sinRango?: boolean;
  /** Cambia la versión (ETag) del fichero de huellas. */
  version?: string;
  peticiones?: { url: string; rango: string | null }[];
}

/** Fetch falso del MITECO: sirve los dos listados con Range (206 + Content-Range), ETag y tamaño; el resto, 404. */
export function fetchHuella(o: OpcionesFetchHuella = {}): typeof fetch {
  const ficheros = new Map<string, { datos: Buffer; fallo?: number; etag: string }>([
    [URL_HUELLA, { datos: o.huella ?? xlsxHuella(), fallo: o.fallo?.huella, etag: `"huella-${o.version ?? 'v1'}"` }],
    [URL_COMPENSACION, { datos: o.compensacion ?? xlsxCompensacion(), fallo: o.fallo?.compensacion, etag: '"comp-v1"' }],
    ...(o.proyectos ? [[URL_PROYECTOS, { datos: o.proyectos, etag: '"proy-v1"' }] as [string, { datos: Buffer; fallo?: number; etag: string }]] : []),
  ]);
  return (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    const rango = new Headers(init?.headers).get('range');
    o.peticiones?.push({ url, rango });
    const f = ficheros.get(url);
    if (!f) return new Response('no encontrado', { status: 404 });
    if (f.fallo) return new Response('error', { status: f.fallo });
    const cab = { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ETag: f.etag, 'Last-Modified': 'Fri, 13 Nov 2026 10:00:00 GMT' };
    const m = /^bytes=(\d+)-(\d+)$/.exec(rango ?? '');
    if (!m || o.sinRango) return new Response(new Uint8Array(f.datos), { status: 200, headers: { ...cab, 'Content-Length': String(f.datos.length) } });
    const ini = Number(m[1]);
    const fin = Math.min(Number(m[2]), f.datos.length - 1, ini + 4095); // trozos pequeños: obliga a pedir varios
    return new Response(new Uint8Array(f.datos.subarray(ini, fin + 1)), { status: 206, headers: { ...cab, 'Content-Range': `bytes ${ini}-${fin}/${f.datos.length}` } });
  }) as typeof fetch;
}
