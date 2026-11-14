// npm run backtest — "Cómo sabemos": reclasifica convocatorias conocidas con las reglas, la criba (Haiku) y la puntuación de HOY, con el reloj
// en su fecha de publicación. Guarda el resultado en las tablas backtest_* y en seed/backtest.json (público). No toca el ranking vivo.
// Opciones: --dry-run (cuenta y estima las llamadas a Haiku, no llama al LLM) · --con-analisis (además analiza con Sonnet) · --solo a|b
//   --max-llamadas N (600) · --max-b N (BACKTEST_MAX_B, 150) · --max-analisis N (40) · --reconstruir-b · --ampliar-b · --rehacer · --sin-exportar
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { abrirBdTrabajo, comprobarRutasBd, ejecutarBacktest } from '../backtest/ejecutar.ts';
import { construirInforme } from '../backtest/informe.ts';
import { leerPerfil } from '../db/repo.ts';
import { config } from '../config.ts';
import { abrirBd } from '../db/schema.ts';
import { crearLlmAnthropic } from '../llm/anthropic.ts';
import { leerFestivos } from '../festivos.ts';
import { leerConfigPuntuacion } from '../puntuacion.ts';

const { values: v } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false }, 'con-analisis': { type: 'boolean', default: false }, solo: { type: 'string' },
    'max-llamadas': { type: 'string', default: '600' }, 'max-b': { type: 'string', default: String(config.backtest.maxB) }, 'max-analisis': { type: 'string', default: '40' },
    'reconstruir-b': { type: 'boolean', default: false }, 'ampliar-b': { type: 'boolean', default: false }, rehacer: { type: 'boolean', default: false },
    'sin-exportar': { type: 'boolean', default: false },
  },
});
if (v.solo && v.solo !== 'a' && v.solo !== 'b') throw new Error('--solo admite a o b');

comprobarRutasBd(config.rutaBd, config.backtest.rutaBdTrabajo);
const db = abrirBd(config.rutaBd);
const ahora = new Date();
try {
  if (!leerPerfil(db)) throw new Error('La BD del radar no tiene perfil: ejecuta antes npm run seed (el backtest no siembra la BD principal)');
  mkdirSync(dirname(config.backtest.rutaBdTrabajo), { recursive: true });
  const dbTrabajo = abrirBdTrabajo(config.backtest.rutaBdTrabajo, leerPerfil(db)!, ahora);
  const llm = config.anthropicApiKey ? crearLlmAnthropic({ apiKey: config.anthropicApiKey }) : null;
  const r = await ejecutarBacktest({
    db, dbTrabajo, fetch: globalThis.fetch, llm, ahora, puntuacion: leerConfigPuntuacion(config.rutaPuntuacion), festivos: leerFestivos(config.rutaFestivos),
    conAnalisis: v['con-analisis']!, maxLlamadas: Number(v['max-llamadas']), maxB: Number(v['max-b']), maxAnalisis: Number(v['max-analisis']),
    maxDetallesB: config.backtest.maxDetallesB, solo: (v.solo as 'a' | 'b' | undefined) ?? null, dryRun: v['dry-run']!, reconstruirB: v['reconstruir-b']!,
    ampliarB: v['ampliar-b']!, rehacer: v.rehacer!, pausaMs: Number(process.env.RADAR_PAUSA_BDNS_MS ?? 250),
    dormir: (ms) => new Promise((res) => setTimeout(res, ms)), log: console.log,
  });
  if (r.estimacion) {
    const e = r.estimacion;
    console.log(`\nESTIMACIÓN (no se ha llamado al LLM): ${e.convocatorias} convocatorias, ${e.pasanReglas} pasan las reglas, ${e.pendientesCriba} por cribar, ${e.enCache} ya en caché → `
      + `${e.llamadasHaiku} llamadas a Haiku, ~${e.costeUsd} USD${e.superaTope ? ` (SUPERA el tope de ${v['max-llamadas']}: se hará en varias ejecuciones)` : ''}`);
    if (v['con-analisis']) console.log(`Con --con-analisis, además hasta ${v['max-analisis']} análisis de Sonnet (su coste depende de los PDF y no se estima).`);
  } else {
    console.log(`\nLlamadas reales al LLM: ${r.llamadas} · coste ${r.costeUsd} USD · procesadas ${r.procesadas} · (b) pendientes ${r.pendientesB}${r.topeAlcanzado ? ' · TOPE ALCANZADO: vuelve a ejecutar para continuar' : ''}`);
    if (!v['sin-exportar']) {
      const informe = construirInforme(db, ahora);
      writeFileSync(config.rutaBacktest, `${JSON.stringify(informe, null, 2)}\n`);
      for (const m of Object.values(informe.modos)) console.log(`\n[${m!.modo}] ${m!.titular}${m!.titularB ? `\n${m!.titularB}` : ''}`);
      console.log(`\nInforme público guardado en ${config.rutaBacktest}`);
    }
  }
} catch (e) {
  console.error(`El backtest falló: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
} finally {
  db.close();
}
