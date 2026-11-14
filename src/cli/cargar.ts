// npm run cargar -- <numeroConvocatoria> [...] — mete convocatorias concretas de BDNS por el camino normal (reglas → criba → ganadores →
// análisis → plazos → puntuación), aunque sean antiguas o estén cerradas, para que tengan ficha. Solo procesa esas: lo pendiente de otras
// fuentes se queda para el radar diario. El análisis respeta RADAR_MAX_ANALISIS y RADAR_PRESUPUESTO_USD (RADAR_MAX_ANALISIS=0 = sin Sonnet).
// Sale con 1 si no hay números válidos o si falla el motor.
import { config } from '../config.ts';
import { leerConvocatoria } from '../db/repo.ts';
import { abrirBd } from '../db/schema.ts';
import { ejecutarRadar } from '../engine.ts';
import { crearLlmAnthropic } from '../llm/anthropic.ts';
import { sembrarSiVacia } from '../seed.ts';
import { crearFuenteBdnsNumeros } from '../sources/bdns.ts';

const numeros = [...new Set(process.argv.slice(2).filter((a) => !a.startsWith('--')))];
const malos = numeros.filter((n) => !/^\d{3,9}$/.test(n));
if (numeros.length === 0 || malos.length) {
  console.error(malos.length ? `Números de convocatoria no válidos: ${malos.join(', ')}` : 'Uso: npm run cargar -- <numeroConvocatoria> [...] (p. ej. npm run cargar -- 904719)');
  process.exit(1);
}

const db = abrirBd(config.rutaBd);
const reloj = { now: () => new Date() };
try {
  if (sembrarSiVacia(db, config.rutaSemilla, reloj.now())) console.log(`Semilla cargada desde ${config.rutaSemilla}`);
  const llm = config.anthropicApiKey ? crearLlmAnthropic({ apiKey: config.anthropicApiKey }) : null;
  if (!llm) console.warn('Aviso: sin ANTHROPIC_API_KEY; se cargan y criban por reglas, sin criba LLM ni análisis.');
  const ids = numeros.map((n) => `bdns:${n}`);
  const r = await ejecutarRadar(
    { db, fetch: globalThis.fetch, reloj, llm, configLlm: config.llm, fuentes: [crearFuenteBdnsNumeros(numeros)], parecidas: false, log: console.log },
    { incluirIds: ids, soloIncluidas: true },
  );
  for (const id of ids) {
    const g = leerConvocatoria(db, id);
    if (!g) { console.log(`${id}: no se pudo cargar`); continue; }
    const fases = g.fases.map((f) => `${f.fase}${f.descarta ? ' (descarta)' : ''}`).join(', ') || 'sin veredictos de LLM';
    console.log(`${id}: ${g.convocatoria.titulo.slice(0, 90)} · ${g.descarte ? `descartada por regla (${g.descarte.regla})` : fases} · ficha: /convocatoria/${encodeURIComponent(id)}`);
  }
  console.log(`Ejecución ${r.ejecucionId}: ${r.conErrores ? 'con errores' : 'ok'} · ${r.presupuesto.gastadoUsd.toFixed(4)} USD de LLM`);
} catch (e) {
  console.error(`La carga falló: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
} finally {
  db.close();
}
