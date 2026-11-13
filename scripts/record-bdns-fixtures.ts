// Graba respuestas reales de BDNS para los tests: ejecuta la fuente BDNS de verdad en cada escenario
// con un fetch que guarda cada respuesta en test/fixtures/bdns. Uso: npm run record:bdns
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cribar } from '../src/rules.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdns } from '../src/sources/bdns.ts';
import { claveGrabacion, DIR_GRABACIONES, ESCENARIOS } from '../test/support/grabaciones.ts';

const perfil = leerSemilla('seed/perfil.json').perfil;
mkdirSync(DIR_GRABACIONES, { recursive: true });

const fetchQueGraba: typeof fetch = async (entrada, init) => {
  const res = await fetch(entrada, init);
  const cuerpo = await res.text();
  if (res.ok) writeFileSync(join(DIR_GRABACIONES, claveGrabacion(String(entrada))), cuerpo);
  return new Response(cuerpo, { status: res.status, headers: res.headers });
};

for (const [nombre, e] of Object.entries(ESCENARIOS)) {
  const r = await bdns.recoger({ fetch: fetchQueGraba, ahora: e.ahora, perfil, diasAtras: e.diasAtras, cribar: (c) => cribar(c, perfil) });
  const candidatas = r.cribadas.filter((c) => !c.descarte).length;
  console.log(`${nombre}: ${r.cribadas.length} cribadas, ${candidatas} candidatas, ${r.errores.length} errores`);
}
