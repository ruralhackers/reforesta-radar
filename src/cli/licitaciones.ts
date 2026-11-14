// npm run licitaciones -- [--paginas N] — relleno PUNTUAL de licitaciones (PLACSP): lee hasta N páginas del feed hacia atrás sin pararse en lo ya leído (por defecto 40,
// ~una semana laborable; tope 150) y guarda las que pasan el pre-filtro de seed/licitaciones.json (tema, plazo vigente, territorio). Cada página pesa ~14 MB y se pide con
// pausa (RADAR_PAUSA_PLACSP_MS): no es para ejecutarlo a diario; el radar diario ya lee lo nuevo con su cobertura. No usa el LLM: la criba y el análisis de lo guardado
// las hace luego `npm run radar` (RADAR_MAX_ANALISIS y RADAR_PRESUPUESTO_USD). Los ZIP mensuales de la Plataforma (cientos de MB) no se bajan nunca.
import { config } from '../config.ts';
import { abrirBd } from '../db/schema.ts';
import { ejecutarRadar } from '../engine.ts';
import { sembrarSiVacia } from '../seed.ts';
import { crearFuentePlacsp } from '../sources/placsp.ts';

const TOPE_PAGINAS = 150;
const arg = process.argv.slice(2);
const i = arg.indexOf('--paginas');
const paginas = i >= 0 ? Number(arg[i + 1]) : 40;
if (!Number.isInteger(paginas) || paginas < 1 || paginas > TOPE_PAGINAS || arg.some((a) => a.startsWith('--') && a !== '--paginas')) {
  console.error(`Uso: npm run licitaciones -- [--paginas N]  (N entre 1 y ${TOPE_PAGINAS}; por defecto 40)`);
  process.exit(1);
}

const db = abrirBd(config.rutaBd);
const reloj = { now: () => new Date() };
try {
  if (sembrarSiVacia(db, config.rutaSemilla, reloj.now())) console.log(`Semilla cargada desde ${config.rutaSemilla}`);
  console.log(`Relleno de licitaciones: hasta ${paginas} páginas (~${paginas * 14} MB) con una pausa de ${config.placsp.pausaMs} ms entre ellas.`);
  const fuente = crearFuentePlacsp(() => ({ ...config.placsp, maxPaginas: paginas, maxBytesTotal: paginas * config.placsp.maxBytesPagina, ignorarCursor: true }));
  const r = await ejecutarRadar(
    { db, fetch: globalThis.fetch, reloj, llm: null, configLlm: config.llm, fuentes: [fuente], ganadores: false, parecidas: false, log: console.log },
    { diasAtras: 3650 },
  );
  const f = r.fuentes[0];
  console.log(`${f.recibidas} licitaciones guardadas (${f.nuevas} nuevas). Ahora, \`npm run radar\` las criba y analiza.`);
  console.log(`Ejecución ${r.ejecucionId}: ${r.conErrores ? 'con errores' : 'ok'}`);
} catch (e) {
  console.error(`El relleno falló: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
} finally {
  db.close();
}
