// Graba respuestas reales de BDNS para el descubrimiento por organizaciones parecidas (GREFA y Grupo Brinzal): sus concesiones por NIF,
// la búsqueda de las ediciones de cada serie que ganaron y el detalle de las ediciones nuevas candidatas. Se ejecuta con el reloj fijo
// de los tests (20/08/2026: la búsqueda lleva `fechaHasta`, así que las grabaciones valen para esa fecha).
// Las consultas de ganadores/búsquedas van a test/fixtures/bdns-concesiones y los detalles a test/fixtures/bdns. Uso: npm run record:parecidas [-- --todo]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { abrirBd } from '../src/db/schema.ts';
import { guardarSemilla } from '../src/db/repo.ts';
import { descubrirParecidas } from '../src/fases/parecidas.ts';
import { leerSemilla } from '../src/seed.ts';
import { claveGrabacion, DIR_CONCESIONES, DIR_GRABACIONES, esConsultaDeGanadores } from '../test/support/grabaciones.ts';
import { AHORA_PARECIDAS, NIF_ACTIVAS_PARECIDAS } from '../test/support/parecidas.ts';

const todo = process.argv.includes('--todo');
mkdirSync(DIR_CONCESIONES, { recursive: true });
const semilla = leerSemilla('seed/perfil.json');
const db = abrirBd(':memory:');
guardarSemilla(db, semilla, AHORA_PARECIDAS);
db.prepare(`UPDATE organizaciones_parecidas SET activa = 0 WHERE nif NOT IN (${NIF_ACTIVAS_PARECIDAS.map((n) => `'${n}'`).join(',')})`).run();

let pedidas = 0;
const fetchQueGraba: typeof fetch = async (entrada, init) => {
  const url = String(entrada);
  const fichero = join(esConsultaDeGanadores(url) ? DIR_CONCESIONES : DIR_GRABACIONES, claveGrabacion(url));
  if (!todo && existsSync(fichero)) return new Response(readFileSync(fichero), { status: 200 });
  pedidas++;
  const res = await fetch(entrada, init);
  const cuerpo = await res.text();
  if (res.ok) writeFileSync(fichero, cuerpo);
  return new Response(cuerpo, { status: res.status });
};

const r = await descubrirParecidas({ db, fetch: fetchQueGraba, reloj: { now: () => AHORA_PARECIDAS } }, semilla.perfil, { diasCache: 7, maxPeticiones: 1000, pausaMs: 400, aniosVentana: 2, diasEdicion: 400 });
console.log(JSON.stringify(r), `${pedidas} respuestas nuevas`);
console.log(db.prepare('SELECT convocatoria_id, nif, nombre, numero_previo, anio_previo FROM origenes_convocatoria').all());
