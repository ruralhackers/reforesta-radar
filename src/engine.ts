// Motor del radar. Todo lo que toca el exterior entra por `DependenciasMotor`: es el punto de prueba.
// Orden: fuentes (recoger + reglas) → criba LLM (Haiku) → análisis (Sonnet). Fases futuras (puntuación) van detrás;
// el envío del correo será otra operación de este módulo con su propio emisor inyectado.
import type { DatabaseSync } from 'node:sqlite';
import {
  type ContadoresFuente, empezarEjecucion, empezarFuente, guardarConvocatoria, guardarRegistroFase, leerPerfil,
  type RegistroFase, registroFaseVacio, terminarEjecucion, terminarFuente, transaccion,
} from './db/repo.ts';
import { analizarConLlm, FASE_ANALISIS } from './fases/analisis.ts';
import { cribarConLlm, FASE_CRIBA } from './fases/criba.ts';
import { diaLocal, sumarDias } from './dates.ts';
import { CONFIG_LLM_POR_DEFECTO, type ConfigLlm, type Llm } from './llm/llm.ts';
import { condicionAmbito, cribar } from './rules.ts';
import { FUENTES } from './sources/index.ts';
import type { Fuente } from './sources/source.ts';
import type { Perfil, Reloj } from './types.ts';

export { FUENTES };

export interface DependenciasMotor {
  db: DatabaseSync;
  fetch: typeof globalThis.fetch;
  reloj: Reloj;
  /** Fuentes a recorrer; por defecto todas las del radar. */
  fuentes?: Fuente[];
  /** LLM para la criba y el análisis. null/ausente = se saltan esas fases con un aviso en el registro (sin clave de API). */
  llm?: Llm | null;
  configLlm?: Partial<ConfigLlm>;
  log?: (mensaje: string) => void;
}

export interface ResumenFuente extends ContadoresFuente {
  fuente: string;
  errores: string[];
}

export interface ResumenEjecucion {
  ejecucionId: number;
  conErrores: boolean;
  fuentes: ResumenFuente[];
  /** Criba LLM y análisis: contadores, tokens, coste, avisos y errores. */
  fases: RegistroFase[];
}

export async function ejecutarRadar(deps: DependenciasMotor, opciones: { diasAtras?: number } = {}): Promise<ResumenEjecucion> {
  const { db, reloj } = deps;
  const log = deps.log ?? (() => {});
  const perfil = leerPerfil(db);
  if (!perfil) throw new Error('La BD no tiene perfil: carga la semilla antes (npm run seed)');

  const inicio = reloj.now();
  const ejecucionId = empezarEjecucion(db, inicio);
  const resumen: ResumenFuente[] = [];
  let fases: RegistroFase[] = [];
  let errorGeneral: string | null = null;

  try {
    for (const fuente of deps.fuentes ?? FUENTES) {
      resumen.push(await recorrerFuente(deps, ejecucionId, fuente, perfil, opciones.diasAtras ?? 7));
    }
    fases = await fasesLlm(deps, ejecucionId, perfil, inicio);
  } catch (e) {
    // Fallo fuera de una fuente (BD bloqueada, disco lleno, configuración…): se registra y se relanza.
    errorGeneral = (e as Error).message;
    throw e;
  } finally {
    const conErrores = errorGeneral !== null || resumen.some((f) => f.errores.length > 0) || fases.some((f) => f.errores.length > 0);
    try {
      terminarEjecucion(db, ejecucionId, reloj.now(), conErrores, errorGeneral);
    } catch (e) {
      log(`! No se pudo cerrar la ejecución ${ejecucionId}: ${(e as Error).message}`);
      if (errorGeneral === null) throw e; // si ya había un fallo, ese es el que se relanza
    }
  }

  const conErrores = resumen.some((f) => f.errores.length > 0) || fases.some((f) => f.errores.length > 0);
  return { ejecucionId, conErrores, fuentes: resumen, fases };
}

/**
 * Criba LLM y análisis sobre las candidatas publicadas en los últimos `diasPendientes` días (las haya devuelto o no
 * la fuente en esta ejecución). Cada fase salta las convocatorias que ya tienen su
 * veredicto (no se repiten llamadas). Sin LLM, ambas se registran como omitidas con un aviso.
 */
async function fasesLlm(deps: DependenciasMotor, ejecucionId: number, perfil: Perfil, inicio: Date): Promise<RegistroFase[]> {
  const log = deps.log ?? (() => {});
  const cfg = { ...CONFIG_LLM_POR_DEFECTO, ...deps.configLlm };
  let fases: RegistroFase[];
  if (!deps.llm) {
    const aviso = 'Sin LLM configurado (falta ANTHROPIC_API_KEY): criba y análisis omitidos en esta ejecución';
    fases = [registroFaseVacio(FASE_CRIBA, null), registroFaseVacio(FASE_ANALISIS, null)];
    for (const f of fases) f.avisos.push(aviso);
  } else {
    const ctx = { db: deps.db, llm: deps.llm, reloj: deps.reloj, fetch: deps.fetch };
    const publicadasDesde = sumarDias(diaLocal(inicio), -(cfg.diasPendientes - 1));
    const criba = await cribarConLlm(ctx, perfil, cfg.modeloCriba, publicadasDesde, deps.fuentes);
    guardarRegistroFase(deps.db, ejecucionId, criba);
    const analisis = await analizarConLlm(ctx, perfil, cfg.modeloAnalisis, cfg.maxAnalisis, publicadasDesde, deps.fuentes);
    fases = [criba, analisis];
  }
  for (const f of fases) {
    guardarRegistroFase(deps.db, ejecucionId, f);
    log(`${f.fase}: ${f.procesadas} procesadas, ${f.descartadas} descartadas, ${f.llamadas} llamadas (${f.desdeCache} de caché), `
      + `${f.omitidasPorTope} sin hacer por el tope, ${f.costeUsd.toFixed(4)} USD, ${f.errores.length} errores`);
    for (const a of f.avisos) log(`  · ${a}`);
    for (const e of f.errores) log(`  ! ${e}`);
  }
  return fases;
}

/** Recoge una fuente y guarda lo cribado. Los fallos de la fuente quedan en sus errores, no se lanzan. */
async function recorrerFuente(
  deps: DependenciasMotor, ejecucionId: number, fuente: Fuente, perfil: Perfil, diasAtras: number,
): Promise<ResumenFuente> {
  const { db, reloj } = deps;
  const log = deps.log ?? (() => {});
  empezarFuente(db, ejecucionId, fuente.nombre, reloj.now());
  const n: ContadoresFuente = { recibidas: 0, nuevas: 0, candidatas: 0, descartadas: 0 };
  let errores: string[] = [];
  try {
    const r = await fuente.recoger({ fetch: deps.fetch, ahora: reloj.now(), perfil, diasAtras, cribar: (c) => cribar(c, perfil) });
    errores = r.errores;
    transaccion(db, () => {
      for (const cribada of r.cribadas) {
        n.recibidas++;
        const condicion = cribada.descarte ? null : condicionAmbito(cribada.convocatoria, perfil);
        if (guardarConvocatoria(db, { ...cribada, condicion }, reloj.now())) n.nuevas++;
        if (cribada.descarte) n.descartadas++;
        else n.candidatas++;
      }
    });
  } catch (e) {
    errores = [...errores, `Fallo de la fuente: ${(e as Error).message}`];
  }
  terminarFuente(db, ejecucionId, fuente.nombre, reloj.now(), n, errores);
  log(`${fuente.nombre}: ${n.recibidas} recibidas, ${n.nuevas} nuevas, ${n.candidatas} candidatas, ${n.descartadas} descartadas, ${errores.length} errores`);
  for (const e of errores) log(`  ! ${e}`);
  return { fuente: fuente.nombre, ...n, errores };
}
