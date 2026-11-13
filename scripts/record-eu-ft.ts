// Graba respuestas reales de la búsqueda SEDIA de EU Funding & Tenders para los tests (test/fixtures/eu-ft), con el reloj fijo de
// AHORA_EU_FT (la consulta lleva la fecha de hoy). Cada resultado se guarda recortado: solo los campos que lee la fuente y los textos
// largos acortados, para que las grabaciones no pesen decenas de MB. Uso: npm run record:eu-ft
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leerSemilla } from '../src/seed.ts';
import { euFt } from '../src/sources/eu-ft.ts';
import { AHORA_EU_FT, claveSedia, DIR_EU_FT } from '../test/support/grabaciones.ts';

const CAMPOS = ['identifier', 'title', 'status', 'deadlineDate', 'startDate', 'deadlineModel', 'callIdentifier', 'callTitle', 'keywords', 'tags', 'typesOfAction', 'budgetOverview', 'type'];
const MAX_DESCRIPCION = 4000;
const MAX_CONDICIONES = 1500;

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
      if (m.descriptionByte?.[0]) metadata.descriptionByte = [m.descriptionByte[0].slice(0, MAX_DESCRIPCION)];
      if (m.topicConditions?.[0]) metadata.topicConditions = [m.topicConditions[0].slice(0, MAX_CONDICIONES)];
      return { reference: x.reference, summary: x.summary, metadata };
    }),
  };
  writeFileSync(join(DIR_EU_FT, await claveSedia(String(entrada), init)), JSON.stringify(recortada));
  n++;
  return new Response(JSON.stringify(r), { status: 200 });
};

const semilla = leerSemilla('seed/perfil.json');
const r = await euFt.recoger({ fetch: fetchQueGraba, ahora: AHORA_EU_FT, perfil: semilla.perfil, diasAtras: 7, cribar: () => null });
console.log(`${n} páginas grabadas; ${r.cribadas.length} topics vigentes; ${r.cribadas.filter((c) => !c.descarte).length} relevantes; errores: ${JSON.stringify(r.errores)}`);
