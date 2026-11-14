// Graba respuestas reales de BDNS para la fase de ganadores: las concesiones de Reforesta (por NIF), la búsqueda de las
// ediciones de la serie "proyectos ambientales" de la CAM y los ganadores de cada edición (2022-2025; la 2026, 904719, aún no tiene).
// Se guardan en test/fixtures/bdns-concesiones. Uso: npm run record:concesiones [-- --todo]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { abrirBd } from '../src/db/schema.ts';
import { guardarConvocatoria, guardarSemilla } from '../src/db/repo.ts';
import { recogerGanadores } from '../src/fases/ganadores.ts';
import { leerSemilla } from '../src/seed.ts';
import { claveGrabacion, DIR_CONCESIONES, DIR_GRABACIONES } from '../test/support/grabaciones.ts';

const todo = process.argv.includes('--todo');
mkdirSync(DIR_CONCESIONES, { recursive: true });
const ahora = new Date('2026-11-13T09:00:00Z');
const semilla = leerSemilla('seed/perfil.json');
const db = abrirBd(':memory:');
guardarSemilla(db, semilla, ahora);

// La convocatoria de este año, tal y como la devuelve BDNS (título y órgano reales).
guardarConvocatoria(db, {
  descarte: null,
  convocatoria: {
    id: 'bdns:904719', fuente: 'bdns', fuenteId: '904719', titulo: 'SUBVENCIÓN ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES 2026',
    organo: { nivel1: 'AUTONOMICA', nivel2: 'COMUNIDAD DE MADRID', nivel3: 'CONSEJERÍA DE MEDIO AMBIENTE, AGRICULTURA E INTERIOR' },
    fechaPublicacion: '2026-05-11', url: 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/904719', tipo: null, finalidad: null,
    regiones: ['ES30'], abierto: false, datos: {},
  },
}, ahora);

let pedidas = 0;
const fetchQueGraba: typeof fetch = async (entrada, init) => {
  const fichero = join(DIR_CONCESIONES, claveGrabacion(String(entrada)));
  if (!todo && existsSync(fichero)) return new Response(readFileSync(fichero), { status: 200 });
  pedidas++;
  const res = await fetch(entrada, init);
  const cuerpo = await res.text();
  if (res.ok) writeFileSync(fichero, cuerpo);
  return new Response(cuerpo, { status: res.status });
};

const r = await recogerGanadores({ db, fetch: fetchQueGraba, reloj: { now: () => ahora } }, semilla.perfil);
console.log(JSON.stringify(r), `${pedidas} respuestas nuevas`);

// Detalle de las ediciones pasadas de la serie (fechas de solicitud, presupuesto): lo que pide la fase `series` para predecir la apertura.
// Van a test/fixtures/bdns (como el detalle de cualquier convocatoria).
for (const numero of ['626301', '703977', '782630', '825309']) {
  const fichero = join(DIR_GRABACIONES, claveGrabacion(`https://www.infosubvenciones.es/bdnstrans/api/convocatorias?numConv=${numero}`));
  if (!todo && existsSync(fichero)) continue;
  const res = await fetch(`https://www.infosubvenciones.es/bdnstrans/api/convocatorias?numConv=${numero}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)' } });
  if (!res.ok) throw new Error(`Detalle ${numero}: HTTP ${res.status}`);
  writeFileSync(fichero, await res.text());
  console.log(`detalle ${numero} grabado`);
  await new Promise((r) => setTimeout(r, 500));
}
