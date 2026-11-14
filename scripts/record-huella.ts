// Graba un extracto REAL del registro de huella de carbono del MITECO en test/fixtures/huella/extracto.json (el que usa test/huella.test.ts).
// Uso: npm run record:huella. Baja los dos listados (por trozos, como la fase), elige filas representativas (con compensaciones, sin ellas, antiguas,
// de administraciones, microempresas, sin NIF…) y guarda sus celdas tal cual vienen de la hoja, con sus cabeceras.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { descargarFichero, HOJA_COMPENSACION, HOJA_HUELLA, leerListadoCompensacion, leerListadoHuella, URL_COMPENSACION, URL_HUELLA } from '../src/sources/huella.ts';
import { filasXlsx } from '../src/sources/xlsx.ts';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'huella');
const op = { timeoutMs: 120_000, maxBytes: 80 * 1024 * 1024 };
const bajar = async (url: string) => (await descargarFichero(fetch, url, op))!;

const [h, c] = [await bajar(URL_HUELLA), await bajar(URL_COMPENSACION)];
const huella = leerListadoHuella(h.datos);
const compensaciones = leerListadoCompensacion(c.datos);
const anioMax = Math.max(...huella.map((f) => f.anio));

// Organizaciones por NIF (todas sus filas) + algunas por criterio.
const nifs = new Set(['A28854727', 'A83052407', 'A48010573', 'A79524054', 'A15075062', 'A85309219']);
const fila = (p: (f: (typeof huella)[number]) => boolean) => huella.find(p);
const sueltas = [
  fila((f) => f.anio === anioMax - 1 && f.tamano === 'Gran empresa' && f.ccaa.startsWith('Madrid') && f.sector.startsWith('D.') && f.sello === 'CALCULO'), // zona + energía, sin compensar
  fila((f) => f.anio === anioMax - 1 && f.tamano === 'Gran empresa' && f.ccaa.startsWith('Madrid') && f.sector.startsWith('C.') && f.sello === 'CALCULO'), // zona pero industria: no pasa
  fila((f) => f.anio === anioMax - 1 && f.tamano === 'Gran empresa' && f.ccaa === 'Galicia' && f.sector.startsWith('H.') && f.sello === 'CALCULO'), // fuera de zona, sin compensar
  fila((f) => f.tamano === 'Administración' && f.anio >= anioMax - 1),
  fila((f) => f.tamano === 'Pequeña' && /COMPENSO/.test(f.sello) && f.anio >= anioMax - 1),
  fila((f) => f.tamano === 'Gran empresa' && /COMPENSO/.test(f.sello) && f.anio < anioMax - 6),
  fila((f) => f.nombre.startsWith('CLÍNICA DENTAL DR. KNOBEL')),
  fila((f) => f.tamano === 'Mediana' && f.nif === '' && f.anio >= anioMax - 1),
].filter((f): f is NonNullable<typeof f> => !!f);
for (const f of sueltas) if (f.nif) nifs.add(f.nif);
const filasElegidas = new Set([...huella.filter((f) => f.nif && nifs.has(f.nif)).map((f) => f.fila), ...sueltas.filter((f) => !f.nif).map((f) => f.fila)]);
const nombres = new Set(huella.filter((f) => filasElegidas.has(f.fila)).map((f) => f.nombre));
const compElegidas = new Set(compensaciones.filter((x) => nombres.has(x.organizacion)).map((x) => x.fila));

const hoja = (buf: Buffer, nombre: string) => filasXlsx(buf, nombre);
const hh = hoja(h.datos, HOJA_HUELLA);
const hc = hoja(c.datos, HOJA_COMPENSACION);
const cab = (fs: typeof hh, texto: RegExp) => fs.find((f) => f.celdas.some((x) => texto.test(x ?? '')))!;
const salida = {
  descargado: new Date().toISOString().slice(0, 10),
  fuentes: { huella: URL_HUELLA, compensacion: URL_COMPENSACION },
  huella: { hoja: HOJA_HUELLA, cabecera: cab(hh, /^NOMBRE ORGANIZACI/).celdas, filas: hh.filter((f) => filasElegidas.has(f.fila)).map((f) => f.celdas) },
  compensacion: { hoja: HOJA_COMPENSACION, cabecera: cab(hc, /^ORGANIZACI/).celdas, filas: hc.filter((f) => compElegidas.has(f.fila)).map((f) => f.celdas) },
};
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'extracto.json'), `${JSON.stringify(salida, null, 1)}\n`);
console.log(`grabadas ${salida.huella.filas.length} filas de huellas y ${salida.compensacion.filas.length} compensaciones`);
