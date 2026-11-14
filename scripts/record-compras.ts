// Graba un extracto REAL de los listados del MITECO para la fase de compra de absorciones en test/fixtures/compras/extracto.json (el que usa test/compras.test.ts).
// Uso: npm run record:compras. Baja las compensaciones y los proyectos de absorción, elige compradores representativos (en territorio, antiguos y fuera, recientes,
// que compran y promueven, administración, sin forma jurídica, con proyecto sin localizar…), y guarda sus filas y las de sus proyectos tal cual vienen de la hoja.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codigoProyectoDe, descargarFichero, HOJA_BAJAS, HOJA_COMPENSACION, HOJA_PROYECTOS, leerListadoCompensacion, leerListadoProyectos, URL_COMPENSACION, URL_PROYECTOS } from '../src/sources/huella.ts';
import { filasXlsx } from '../src/sources/xlsx.ts';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'compras');
const op = { timeoutMs: 120_000, maxBytes: 80 * 1024 * 1024 };
const bajar = async (url: string) => (await descargarFichero(fetch, url, op))!;
const [c, p] = [await bajar(URL_COMPENSACION), await bajar(URL_PROYECTOS)];
const compensaciones = leerListadoCompensacion(c.datos);
const proyectos = leerListadoProyectos(p.datos);

// Compradores del extracto de huella (para poder unirlos en el test) más los que cubren cada caso.
const previo = JSON.parse(readFileSync(join(DIR, '..', 'huella', 'extracto.json'), 'utf8')) as { compensacion: { filas: string[][] } };
const orgs = new Set<string>([
  ...previo.compensacion.filas.map((f) => f[2]),
  'ENAGÁS, S.A.', // proyecto en Madrid
  'ALSA GRUPO, S.L.U.', // proyecto en Ávila, compra antigua: entra por el territorio
  'FAL CALZADOS DE SEGURIDAD, S.A.', // fuera de territorio y sin compra reciente: baja confianza
  'CALZADOS FAL, S.A.',
  'EULEN, S.A.', // promueve sus propios proyectos
  'MANCOMUNIDAD DE LA COMARCA DE PAMPLONA (MCP/SCPSA)', // administración
  'KAURA COPRODUCTS, S.L.',
]);
const MAX_POR_ORG = 12;
const elegidas = [...orgs].flatMap((o) => compensaciones.filter((x) => x.organizacion === o).slice(-MAX_POR_ORG));
const filasC = new Set(elegidas.map((x) => x.fila));
const codigos = new Set(elegidas.map(codigoProyectoDe));
const filasP = new Set(proyectos.filter((x) => codigos.has(x.codigo) && !x.baja).map((x) => x.fila));
const filasB = new Set(proyectos.filter((x) => codigos.has(x.codigo) && x.baja).map((x) => x.fila));

const hoja = (buf: Buffer, nombre: string, texto: RegExp, filas: Set<number>) => {
  const todas = filasXlsx(buf, nombre);
  const cab = todas.find((f) => f.celdas.some((x) => texto.test(x ?? '')))!;
  return { hoja: nombre, filaCabecera: cab.fila, cabecera: cab.celdas, filas: todas.filter((f) => filas.has(f.fila)).map((f) => f.celdas) };
};
const salida = {
  descargado: new Date().toISOString().slice(0, 10),
  fuentes: { compensacion: URL_COMPENSACION, proyectos: URL_PROYECTOS },
  compensacion: hoja(c.datos, HOJA_COMPENSACION, /^ORGANIZACI/, filasC),
  proyectos: hoja(p.datos, HOJA_PROYECTOS, /^Nombre del proyecto/, filasP),
  bajas: hoja(p.datos, HOJA_BAJAS, /^Nombre del proyecto/, filasB),
};
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'extracto.json'), `${JSON.stringify(salida, null, 1)}\n`);
console.log(`grabadas ${salida.compensacion.filas.length} compensaciones, ${salida.proyectos.filas.length} proyectos y ${salida.bajas.filas.length} bajas`);
