// Graba respuestas reales de la búsqueda SEDIA (type 8, convocatorias en cascada) para los tests (test/fixtures/eu-ft), con el reloj fijo de
// AHORA_EU_FT. Cada resultado se guarda recortado: solo los campos que lee la fuente y los textos largos acortados. Uso: npm run record:eu-cascada
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leerSemilla } from '../src/seed.ts';
import { euCascada } from '../src/sources/eu-cascada.ts';
import { AHORA_EU_FT, claveSedia, DIR_EU_FT } from '../test/support/grabaciones.ts';

const CAMPOS = ['callccm2Id', 'ccm2Id', 'callTitle', 'title', 'projectName', 'projectAcronym', 'status', 'deadlineDate', 'startDate', 'identifier', 'budget', 'duration', 'url', 'type', 'language'];
const LARGOS = ['description', 'beneficiaryAdministration', 'furtherInformation'];
const MAX_TEXTO = 3500;

mkdirSync(DIR_EU_FT, { recursive: true });
let n = 0;
const fetchQueGraba: typeof fetch = async (entrada, init) => {
  const res = await fetch(entrada, init);
  if (!res.ok) return res;
  const r = (await res.json()) as { results?: { reference?: string; summary?: string; metadata?: Record<string, string[]> }[] };
  const recortada = {
    ...r,
    results: (r.results ?? []).map((x) => {
      const m = x.metadata ?? {};
      const metadata: Record<string, string[]> = Object.fromEntries(CAMPOS.filter((k) => m[k]).map((k) => [k, m[k]]));
      for (const k of LARGOS) if (m[k]?.[0]) metadata[k] = [m[k][0].slice(0, MAX_TEXTO)];
      return { reference: x.reference, summary: x.summary, metadata };
    }),
  };
  writeFileSync(join(DIR_EU_FT, await claveSedia(String(entrada), init)), JSON.stringify(recortada));
  n++;
  return new Response(JSON.stringify(r), { status: 200 });
};

const semilla = leerSemilla('seed/perfil.json');
const r = await euCascada.recoger({ fetch: fetchQueGraba, ahora: AHORA_EU_FT, perfil: semilla.perfil, diasAtras: 7, cribar: () => null, dormir: async () => {} });
const ok = r.cribadas.filter((c) => !c.descarte);
console.log(`${n} páginas grabadas; ${r.cribadas.length} cascadas vigentes; ${ok.length} relevantes y elegibles; errores: ${JSON.stringify(r.errores)}`);
for (const c of r.cribadas) console.log(`${c.descarte ? c.descarte.regla.padEnd(5) : 'OK   '} ${c.convocatoria.id} ${c.convocatoria.titulo.slice(0, 70)}${c.descarte?.regla === 'pais' ? ' :: ' + c.descarte.motivo : ''}`);
