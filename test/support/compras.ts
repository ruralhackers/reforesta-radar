// Apoyo a los tests de la compra de absorciones: un extracto REAL (test/fixtures/compras/extracto.json, ver scripts/record-compras.ts) de las compensaciones y los
// proyectos de absorción del MITECO convertido en .xlsx de verdad (el de proyectos con sus hojas «PROYECTOS DE ABSORCIÓN» y «BAJAS»).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOJA_BAJAS, HOJA_PROYECTOS } from '../../src/sources/huella.ts';
import { construirXlsx, zip } from './huella.ts';

interface Hoja { hoja: string; filaCabecera: number; cabecera: string[]; filas: string[][] }
export interface ExtractoCompras { descargado: string; compensacion: Hoja; proyectos: Hoja; bajas: Hoja }

export const extractoCompras: ExtractoCompras = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'compras', 'extracto.json'), 'utf8'));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const letra = (i: number) => String.fromCharCode(65 + i);

export const xlsxCompensacionCompras = (filas = extractoCompras.compensacion.filas) => construirXlsx(extractoCompras.compensacion.hoja, extractoCompras.compensacion.cabecera, filas, extractoCompras.compensacion.filaCabecera);

/** .xlsx de proyectos con las dos hojas, cada una con su cabecera en su fila, como el del MITECO. */
export function xlsxProyectos(proyectos = extractoCompras.proyectos.filas, bajas = extractoCompras.bajas.filas): Buffer {
  const compartidas: string[] = [];
  const idx = (s: string) => { let i = compartidas.indexOf(s); if (i < 0) { i = compartidas.length; compartidas.push(s); } return i; };
  const hoja = (h: Hoja, filas: string[][]) => {
    const fila = (n: number, celdas: string[]) => `<row r="${n}">${celdas.map((c, i) => (c === '' ? '' : `<c r="${letra(i)}${n}" t="s"><v>${idx(c)}</v></c>`)).join('')}</row>`;
    return `<worksheet><sheetData>${[fila(h.filaCabecera, h.cabecera), ...filas.map((f, i) => fila(h.filaCabecera + 1 + i, f))].join('')}</sheetData></worksheet>`;
  };
  return zip({
    'xl/workbook.xml': `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(HOJA_PROYECTOS)}" sheetId="1" r:id="rId1"/><sheet name="${esc(HOJA_BAJAS)}" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': hoja(extractoCompras.proyectos, proyectos),
    'xl/worksheets/sheet2.xml': hoja(extractoCompras.bajas, bajas),
    'xl/sharedStrings.xml': `<sst>${compartidas.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
  });
}
