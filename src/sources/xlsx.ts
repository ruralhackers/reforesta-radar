// Lector mínimo de .xlsx sin dependencias: un .xlsx es un zip (se lee con node:zlib) con XML. Solo lo que hace falta para listados de
// datos abiertos: filas de una hoja como texto (cadenas compartidas resueltas, números tal cual, fechas como número de serie de Excel).
import { inflateRawSync } from 'node:zlib';

/** Tope de lo que se descomprime de una entrada (un zip malicioso no llena la memoria). */
const MAX_ENTRADA = 150 * 1024 * 1024;

interface EntradaZip { nombre: string; metodo: number; tamComprimido: number; tamReal: number; cabecera: number }

function entradasZip(b: Buffer): Map<string, EntradaZip> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('No es un .xlsx válido (zip incompleto o dañado)');
  const n = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const salida = new Map<string, EntradaZip>();
  for (let i = 0; i < n; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new Error('Zip dañado (directorio central)');
    const nl = b.readUInt16LE(p + 28);
    const el = b.readUInt16LE(p + 30);
    const cl = b.readUInt16LE(p + 32);
    salida.set(b.toString('utf8', p + 46, p + 46 + nl), { nombre: '', metodo: b.readUInt16LE(p + 10), tamComprimido: b.readUInt32LE(p + 20), tamReal: b.readUInt32LE(p + 24), cabecera: b.readUInt32LE(p + 42) });
    p += 46 + nl + el + cl;
  }
  return salida;
}

function leerEntrada(b: Buffer, e: EntradaZip): string {
  if (e.tamReal > MAX_ENTRADA) throw new Error('Entrada del .xlsx demasiado grande');
  const nl = b.readUInt16LE(e.cabecera + 26);
  const el = b.readUInt16LE(e.cabecera + 28);
  const ini = e.cabecera + 30 + nl + el;
  const datos = b.subarray(ini, ini + e.tamComprimido);
  if (e.metodo === 0) return datos.toString('utf8');
  if (e.metodo !== 8) throw new Error(`Método de compresión ${e.metodo} no soportado`);
  return inflateRawSync(datos, { maxOutputLength: MAX_ENTRADA }).toString('utf8');
}

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const desescapar = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  if (e[0] !== '#') return ENTIDADES[e.toLowerCase()];
  const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
});
const textoDe = (xml: string) => desescapar([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function columna(ref: string): number {
  let n = 0;
  for (const c of ref.replace(/\d+/g, '')) n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
}

export interface FilaXlsx {
  /** Número de fila de la hoja (1 = primera). */
  fila: number;
  celdas: string[];
}

/** Filas de la hoja `nombreHoja` (por el nombre que ve el usuario). Celdas vacías = ''. */
export function filasXlsx(contenido: Buffer, nombreHoja: string): FilaXlsx[] {
  const zip = entradasZip(contenido);
  const entrada = (n: string) => { const e = zip.get(n); if (!e) throw new Error(`Falta ${n} en el .xlsx`); return leerEntrada(contenido, e); };
  const libro = entrada('xl/workbook.xml');
  const hoja = [...libro.matchAll(/<sheet\s[^>]*>/g)].map((m) => m[0]).find((s) => desescapar(/name="([^"]*)"/.exec(s)?.[1] ?? '').trim() === nombreHoja);
  const rid = hoja && /r:id="([^"]+)"/.exec(hoja)?.[1];
  if (!rid) throw new Error(`El .xlsx no tiene la hoja «${nombreHoja}»`);
  const rels = entrada('xl/_rels/workbook.xml.rels');
  const destino = [...rels.matchAll(/<Relationship\s[^>]*>/g)].map((m) => m[0]).find((r) => new RegExp(`Id="${rid}"`).test(r));
  const target = destino && /Target="([^"]+)"/.exec(destino)?.[1];
  if (!target || !/^(\/xl\/)?worksheets\/[\w-]+\.xml$/.test(target)) throw new Error(`Ruta de hoja no válida para «${nombreHoja}»`);
  const compartidas: string[] = zip.has('xl/sharedStrings.xml') ? [...entrada('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoDe(m[1])) : [];
  const xml = entrada(`xl/${target.replace(/^\/xl\//, '')}`);
  const filas: FilaXlsx[] = [];
  for (const fm of xml.matchAll(/<row\s([^>]*)>([\s\S]*?)<\/row>/g)) {
    const num = Number(/\sr="(\d+)"/.exec(` ${fm[1]}`)?.[1] ?? filas.length + 1);
    const celdas: string[] = [];
    for (const cm of fm[2].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\sr="([A-Z]+\d+)"/.exec(` ${cm[1]}`)?.[1];
      if (!ref || !cm[2]) continue;
      const tipo = /\st="(\w+)"/.exec(` ${cm[1]}`)?.[1];
      let v = '';
      if (tipo === 'inlineStr') v = textoDe(cm[2]);
      else {
        const x = /<v>([\s\S]*?)<\/v>/.exec(cm[2])?.[1];
        if (x !== undefined) v = tipo === 's' ? (compartidas[Number(x)] ?? '') : desescapar(x);
      }
      celdas[columna(ref)] = v;
    }
    for (let i = 0; i < celdas.length; i++) celdas[i] ??= '';
    filas.push({ fila: num, celdas });
  }
  return filas;
}

/** Fecha de Excel (número de serie, base 1899-12-30) → AAAA-MM-DD, o null. */
export function fechaExcel(v: string): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 80_000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);
}
