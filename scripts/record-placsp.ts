// Graba las entradas reales de licitaciones (PLACSP) de test/fixtures/placsp: dos páginas del feed ATOM con entradas elegidas de PÁGINAS ARCHIVADAS (sus nombres no
// cambian: …_20261113_202142.atom, …_2.atom, etc.; la primera página, la viva, sí cambia y no sirve). Cada página real pesa ~14 MB y tiene ~500 entradas: se bajan 5
// con pausa y se guardan solo las elegidas, completas y sin tocar, bajo la cabecera real del feed. Uso: npm run record:placsp
//   pagina_1.atom  (la «nueva», servida en la URL del feed; su `next` apunta a la 2)
//     20906084 gestión de plagas y poda en Badajoz-ES523 (pasa el tema, fuera del territorio) · 20906046 transporte escolar en San Fernando de Henares (Madrid, sin relación con el tema)
//     20787920 jardinería en Andalucía en estado EV (ya no se puede ofertar) · 20906429 repuestos de maquinaria forestal (suministro) · 20906461 jardinería de edificios (Madrid, 4,1 M€)
//   pagina_2.atom  (la «antigua»; sin `next`)
//     20806710 poda del arbolado en Guadalajara (80 k€) · 20867623 bike park en Paracuellos de Jarama (Madrid, 195 k€, CPV de paisajismo)
//     20797834 mantenimiento de la jardinería de la Base Coronel Maté (Madrid, 24,8 k€): la licitación pequeña, de Madrid y del tema que debe pasar
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3';
const FEED = `${BASE}.atom`;
const SEGUNDA = `${BASE}_20261113_202142.atom`;
const SALIDA = join(import.meta.dirname, '..', 'test', 'fixtures', 'placsp');
const UA = 'reforesta-radar/0.1 (+https://github.com/ruralhackers/reforesta-radar)';

const SELECCION: { pagina: string; ids: string[]; pagina_destino: 1 | 2 }[] = [
  { pagina: `${BASE}_20261113_202142.atom`, ids: ['20906084', '20906046', '20787920'], pagina_destino: 1 },
  { pagina: `${BASE}_20261113_202142_2.atom`, ids: ['20906429', '20906461'], pagina_destino: 1 },
  { pagina: `${BASE}_20261113_202142_3.atom`, ids: ['20806710'], pagina_destino: 2 },
  { pagina: `${BASE}_20261112_201831_3.atom`, ids: ['20867623'], pagina_destino: 2 },
  { pagina: `${BASE}_20261111_201807.atom`, ids: ['20797834'], pagina_destino: 2 },
];

const entradas: Record<1 | 2, { actualizada: number; xml: string }[]> = { 1: [], 2: [] };
let cabecera = '';
for (const [i, s] of SELECCION.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, 3000));
  const res = await fetch(s.pagina, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${s.pagina}: HTTP ${res.status}`);
  const xml = await res.text();
  console.log(`${s.pagina.split('/').pop()}: ${(xml.length / 1e6).toFixed(1)} MB`);
  if (!cabecera) cabecera = xml.slice(0, xml.indexOf('<entry>')).replace(/\s*<at:deleted-entry[\s\S]*?<\/at:deleted-entry>/g, '');
  for (const e of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const id = /licitacionesPerfilContratante\/(\d+)/.exec(e)?.[1];
    if (id && s.ids.includes(id)) entradas[s.pagina_destino].push({ actualizada: Date.parse(/<updated>([^<]+)<\/updated>/.exec(e)![1]), xml: e });
  }
}
const esperadas = SELECCION.reduce((t, s) => t + s.ids.length, 0);
if (entradas[1].length + entradas[2].length !== esperadas) throw new Error(`Faltan entradas: ${entradas[1].length + entradas[2].length} de ${esperadas}`);

const sinLinks = cabecera.replace(/\s*<link [^>]*\/>/g, '');
const enlaces = (siguiente: string | null) => [`    <link href="${FEED}" rel="self"/>`, `    <link href="${FEED}" rel="first"/>`, ...(siguiente ? [`    <link href="${siguiente}" rel="next"/>`] : [])].join('\n');
mkdirSync(SALIDA, { recursive: true });
for (const n of [1, 2] as const) {
  const orden = entradas[n].sort((a, b) => b.actualizada - a.actualizada);
  const cab = sinLinks.replace(/(<id>[^<]*<\/id>)/, `$1\n${enlaces(n === 1 ? SEGUNDA : null)}`);
  writeFileSync(join(SALIDA, `pagina_${n}.atom`), `${cab}\n    ${orden.map((o) => o.xml).join('\n    ')}\n</feed>\n`);
  console.log(`pagina_${n}.atom: ${orden.length} entradas`);
}
