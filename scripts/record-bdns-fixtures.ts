// Graba respuestas reales de BDNS para los tests: ejecuta la fuente BDNS de verdad en cada escenario
// con un fetch que guarda cada respuesta en test/fixtures/bdns. Uso: npm run record:bdns
// Las grabaciones que ya existen se reutilizan (los listados no cambian bajo los tests); solo se piden las que faltan.
// Con --todo se vuelve a pedir todo. Además graba los documentos (PDF, bases) de CON_DOCUMENTOS en test/fixtures/documentos.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cribar } from '../src/rules.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdns } from '../src/sources/bdns.ts';
import {
  CON_DOCUMENTOS, claveDocumento, claveGrabacion, DIR_DOCUMENTOS, DIR_GRABACIONES, ESCENARIOS,
} from '../test/support/grabaciones.ts';

const perfil = leerSemilla('seed/perfil.json').perfil;
const todo = process.argv.includes('--todo');
mkdirSync(DIR_GRABACIONES, { recursive: true });
mkdirSync(DIR_DOCUMENTOS, { recursive: true });
let pedidas = 0;

const fetchQueGraba: typeof fetch = async (entrada, init) => {
  const fichero = join(DIR_GRABACIONES, claveGrabacion(String(entrada)));
  if (!todo && existsSync(fichero)) return new Response(readFileSync(fichero), { status: 200 });
  pedidas++;
  const res = await fetch(entrada, init);
  const cuerpo = await res.text();
  if (res.ok) writeFileSync(fichero, cuerpo);
  return new Response(cuerpo, { status: res.status, headers: res.headers });
};

for (const [nombre, e] of Object.entries(ESCENARIOS)) {
  const r = await bdns.recoger({ fetch: fetchQueGraba, ahora: e.ahora, perfil, diasAtras: e.diasAtras, cribar: (c) => cribar(c, perfil) });
  const candidatas = r.cribadas.filter((c) => !c.descarte).length;
  console.log(`${nombre}: ${r.cribadas.length} cribadas, ${candidatas} candidatas, ${r.errores.length} errores`);
  for (const { convocatoria } of r.cribadas.filter((c) => CON_DOCUMENTOS.includes(c.convocatoria.fuenteId))) {
    for (const d of bdns.documentos!(convocatoria)) {
      if (d.texto !== undefined || !d.url) continue;
      const fichero = join(DIR_DOCUMENTOS, claveDocumento(d.url));
      if (!todo && existsSync(fichero)) continue;
      const res = await fetch(d.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)' } });
      if (!res.ok) throw new Error(`${d.url}: HTTP ${res.status}`);
      writeFileSync(fichero, new Uint8Array(await res.arrayBuffer()));
      console.log(`  documento ${convocatoria.fuenteId}: ${d.titulo} → ${fichero}`);
    }
  }
}
console.log(`${pedidas} respuestas nuevas de BDNS`);
