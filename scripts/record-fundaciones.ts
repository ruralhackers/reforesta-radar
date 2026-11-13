// Graba las páginas reales de algunas fundaciones vigiladas en test/fixtures/fundaciones/ (HTML tal cual lo sirve cada web).
// Uso: npm run record:fundaciones. Los tests simulan el "después" insertando una convocatoria nueva en la página grabada.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_AGENT } from '../src/sources/fundaciones.ts';
import { claveFundacion } from '../test/support/fundaciones.ts';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'fundaciones');
const PAGINAS = [
  'https://www.fundacionmontemadrid.es/convocatorias/',
  'https://www.fundacionmapfre.org/premios-ayudas/convocatorias/',
  'https://www.fbbva.es/convocatorias/',
];

mkdirSync(DIR, { recursive: true });
for (const url of PAGINAS) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(join(DIR, claveFundacion(url)), await res.text());
  console.log(`grabada ${url}`);
  await new Promise((r) => setTimeout(r, 1500));
}
