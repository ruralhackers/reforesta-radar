// npm run radar — recoge, criba y guarda. Sale con 0 aunque una fuente falle (queda en el registro de ejecución);
// sale con 1 si falla el propio motor (la ejecución queda cerrada como con_errores, con el error).
import { config } from '../config.ts';
import { abrirBd } from '../db/schema.ts';
import { ejecutarRadar } from '../engine.ts';
import { crearLlmAnthropic } from '../llm/anthropic.ts';
import { sembrarSiVacia } from '../seed.ts';

const db = abrirBd(config.rutaBd);
const reloj = { now: () => new Date() };
try {
  if (sembrarSiVacia(db, config.rutaSemilla, reloj.now())) console.log(`Semilla cargada desde ${config.rutaSemilla}`);
  const llm = config.anthropicApiKey ? crearLlmAnthropic({ apiKey: config.anthropicApiKey }) : null;
  if (!llm) console.warn('Aviso: sin ANTHROPIC_API_KEY; se recogen y criban convocatorias por reglas, sin criba LLM ni análisis.');
  const r = await ejecutarRadar(
    { db, fetch: globalThis.fetch, reloj, llm, configLlm: config.llm, empresas: config.empresas, huella: config.huella, log: console.log },
    { diasAtras: config.diasAtras },
  );
  console.log(`Ejecución ${r.ejecucionId}: ${r.conErrores ? 'con errores' : 'ok'}`);
} catch (e) {
  console.error(`El radar falló: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
} finally {
  db.close();
}
