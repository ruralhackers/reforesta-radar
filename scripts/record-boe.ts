// Graba sumarios y resoluciones reales del BOE en test/fixtures/boe/ (los que usa test/empresas.test.ts).
// Uso: npm run record:boe. Sumario: JSON tal cual lo sirve la API de datos abiertos; resolución: el XML completo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'boe');
const DIAS = ['20261007', '20261012', '20261022'];
const RESOLUCIONES = ['BOE-A-2026-20900', 'BOE-A-2026-21224', 'BOE-A-2026-22067'];
const UA = 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)';

mkdirSync(DIR, { recursive: true });
for (const d of DIAS) {
  const res = await fetch(`https://www.boe.es/datosabiertos/api/boe/sumario/${d}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`sumario ${d}: HTTP ${res.status}`);
  writeFileSync(join(DIR, `sumario-${d}.json`), await res.text());
  console.log(`grabado sumario ${d}`);
  await new Promise((r) => setTimeout(r, 500));
}
for (const id of RESOLUCIONES) {
  const res = await fetch(`https://www.boe.es/diario_boe/xml.php?id=${id}`, { headers: { 'User-Agent': UA, Accept: 'application/xml' } });
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  writeFileSync(join(DIR, `${id}.xml`), await res.text());
  console.log(`grabada ${id}`);
  await new Promise((r) => setTimeout(r, 500));
}
