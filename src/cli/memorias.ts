// npm run memorias — lee las memorias anuales de la entidad (perfil.memorias, más las que descubra en perfil.paginaMemorias) y guarda sus proyectos y
// financiadores con cita. Trabajo puntual: presupuesto por defecto 3 USD (RADAR_PRESUPUESTO_USD) y se niega si la proyección pasa de 5 USD.
//   npm run memorias               lo que falta o ha cambiado (documento con otro hash)
//   npm run memorias -- --refrescar   vuelve a descargar todos los documentos (si no cambiaron, no se extraen otra vez)
import { config } from '../config.ts';
import { abrirBd } from '../db/schema.ts';
import { financiadoresConocidos, resumenMemorias } from '../db/memorias.ts';
import { guardarRegistroFase, empezarEjecucion, leerPerfil, terminarEjecucion } from '../db/repo.ts';
import { procesarMemorias } from '../fases/memorias.ts';
import { crearLlmAnthropic } from '../llm/anthropic.ts';
import { conPresupuesto, type Presupuesto } from '../llm/presupuesto.ts';
import { sembrarSiVacia } from '../seed.ts';

const db = abrirBd(config.rutaBd);
const reloj = { now: () => new Date() };
try {
  if (sembrarSiVacia(db, config.rutaSemilla, reloj.now())) console.log(`Semilla cargada desde ${config.rutaSemilla}`);
  if (!config.anthropicApiKey) throw new Error('Falta ANTHROPIC_API_KEY: sin ella no se pueden extraer las memorias');
  const perfil = leerPerfil(db)!;
  const presupuesto: Presupuesto = { limiteUsd: config.memorias.presupuestoUsd, gastadoUsd: 0 };
  const llm = conPresupuesto(crearLlmAnthropic({ apiKey: config.anthropicApiKey }), presupuesto);
  const ejecucionId = empezarEjecucion(db, reloj.now());
  const r = await procesarMemorias({ db, fetch: globalThis.fetch, reloj, llm }, perfil, config.llm.modeloAnalisis, {
    maxCaracteres: config.memorias.maxCaracteres, maxProyeccionUsd: config.memorias.maxProyeccionUsd, refrescar: process.argv.includes('--refrescar'),
  });
  guardarRegistroFase(db, ejecucionId, r.fase);
  terminarEjecucion(db, ejecucionId, reloj.now(), r.errores.length > 0, null);
  console.log(`Memorias: ${r.enLista} en la lista (${r.descubiertas.length} descubiertas ahora), ${r.extraidas} extraídas, ${r.sinCambios} sin cambios`);
  console.log(`Proyección previa: ${r.proyeccionUsd.toFixed(2)} USD; coste real: ${r.fase.costeUsd.toFixed(4)} USD de ${presupuesto.limiteUsd.toFixed(2)} de presupuesto (${r.fase.llamadas} llamadas, ${r.fase.desdeCache} de caché)`);
  for (const a of r.fase.avisos) console.log(`  · ${a}`);
  for (const e of r.errores) console.log(`  ! ${e}`);
  console.log('\nAño  proyectos  financiadores  memoria');
  for (const m of resumenMemorias(db)) console.log(`${m.anio ?? '----'}  ${String(m.proyectos).padStart(9)}  ${String(m.financiadores).padStart(13)}  ${m.url}`);
  const k = financiadoresConocidos(db);
  console.log(`\nFinanciadores distintos: ${k.empresas.size} empresas u otros, ${k.fundaciones.size} fundaciones`);
  if (r.errores.length) process.exitCode = 1;
} catch (e) {
  console.error(`Las memorias fallaron: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
