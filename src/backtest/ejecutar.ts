// Backtest "Cómo sabemos" (npm run backtest). Reclasifica convocatorias CONOCIDAS con las reglas, la criba (Haiku) y la puntuación de hoy,
// con el reloj puesto en el día en que cada una se publicó. Escribe SOLO en las tablas backtest_* de la BD principal y en una BD de trabajo
// aparte (criba, caché del LLM): no lee ni escribe convocatorias, decisiones ni ranking vivos. Reanudable: lo ya calculado no se repite.
//   (a) conjunto conocido: las CAM "proyectos ambientales", MITECO 923290 y la Orden 1689/2026 del reto.
//   (b) descubrimiento: ganadas por parecidas activas, filtradas con reglas objetivas, sin la fuente "parecidas" ni las concesiones.
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { leerParecidas } from '../db/ganadores.ts';
import { conDiasHastaCierre, guardarConvocatoria, guardarSemilla, leerFases, leerLlmCache, leerPerfil, pendientesDeFase } from '../db/repo.ts';
import { abrirBd } from '../db/schema.ts';
import { type Analisis } from '../fases/analisis-esquema.ts';
import { analizarConLlm } from '../fases/analisis.ts';
import { claveCache, type ContextoFase } from '../fases/comun.ts';
import { cribarConLlm, FASE_CRIBA, peticionCriba } from '../fases/criba.ts';
import { calendario, type TablaFestivos } from '../festivos.ts';
import { CONFIG_LLM_POR_DEFECTO, type Llm, type PeticionLlm, type RespuestaLlm } from '../llm/llm.ts';
import { coste } from '../llm/precios.ts';
import { calcularPlazo } from '../plazos.ts';
import { type ConfigPuntuacion, type Factor, puntuar } from '../puntuacion.ts';
import { condicionAmbito, cribar } from '../rules.ts';
import { bdns, convocatoriaDeNumero } from '../sources/bdns.ts';
import type { Convocatoria, Perfil } from '../types.ts';
import { construirConjuntoB, resolverConjuntoA } from './conjuntos.ts';
import {
  borrarConjunto, type Conjunto, type FilaConjunto, guardarConjunto, guardarEjecucion, guardarResultado, leerConjunto, leerResultados, type Modo, type ResultadoGuardado,
} from './db.ts';

export class TopeAlcanzado extends Error {
  constructor(max: number) {
    super(`Tope de ${max} llamadas al LLM del backtest alcanzado`);
  }
}

/** Cuenta las llamadas REALES (las de la caché no llegan aquí) y se niega a pasar del tope. */
export class LlmConTope implements Llm {
  usadas = 0;
  costeUsd = 0;
  readonly llm: Llm;
  readonly max: number;
  constructor(llm: Llm, max: number) {
    this.llm = llm;
    this.max = max;
  }
  get agotado(): boolean { return this.usadas >= this.max; }
  async generar(p: PeticionLlm): Promise<RespuestaLlm> {
    if (this.usadas >= this.max) throw new TopeAlcanzado(this.max);
    this.usadas++;
    const r = await this.llm.generar(p);
    this.costeUsd += coste(r.modelo, r.uso) ?? 0;
    return r;
  }
}

export interface OpcionesBacktest {
  /** BD principal: solo se escribe en backtest_*. */
  db: DatabaseSync;
  /** BD de trabajo (criba, caché del LLM): nunca la del radar. */
  dbTrabajo: DatabaseSync;
  fetch: typeof fetch;
  /** null solo es válido con dryRun. */
  llm: Llm | null;
  ahora: Date;
  puntuacion: ConfigPuntuacion;
  festivos: TablaFestivos;
  /** Además de la criba, analiza con Sonnet las que la superan (por defecto no). */
  conAnalisis: boolean;
  /** Tope de llamadas REALES al LLM por ejecución (criba + análisis). */
  maxLlamadas: number;
  /** Tope de convocatorias del conjunto (b) que se procesan por ejecución (reanudable). */
  maxB: number;
  /** Tope de convocatorias analizadas con Sonnet por ejecución (solo con análisis). */
  maxAnalisis: number;
  /** Tope de detalles de BDNS que se piden al construir el conjunto (b) en una pasada. */
  maxDetallesB: number;
  solo: Conjunto | null;
  dryRun: boolean;
  /** Vuelve a construir el conjunto (b) desde cero. */
  reconstruirB: boolean;
  /** Examina convocatorias nuevas del (b) sin tocar las ya examinadas (si quedaron sin examinar por el tope). */
  ampliarB: boolean;
  /** Borra lo calculado de esta ejecución (la caché del LLM se conserva: lo que no haya cambiado no se repaga). */
  rehacer: boolean;
  dormir: (ms: number) => Promise<void>;
  pausaMs: number;
  log: (m: string) => void;
}

export interface ResumenBacktest {
  conjuntoA: number;
  conjuntoB: { examinadas: number; admitidas: number };
  procesadas: number;
  pendientesB: number;
  llamadas: number;
  costeUsd: number;
  topeAlcanzado: boolean;
  /** Solo con dryRun. */
  estimacion: { convocatorias: number; pasanReglas: number; pendientesCriba: number; enCache: number; llamadasHaiku: number; costeUsd: number; superaTope: boolean } | null;
}

const modoDe = (o: Pick<OpcionesBacktest, 'conAnalisis'>): Modo => (o.conAnalisis ? 'con_analisis' : 'sin_analisis');
const DESDE_SIEMPRE = '1900-01-01';

/** BD de trabajo: el perfil de hoy y nada más (ni parecidas, ni fundaciones, ni decisiones: el backtest no aprende del equipo). */
/** La BD de trabajo guarda criba y caché del LLM de convocatorias ajenas al radar: jamás puede ser la BD principal. */
export function comprobarRutasBd(rutaPrincipal: string, rutaTrabajo: string): void {
  if (rutaPrincipal !== ':memory:' && resolve(rutaPrincipal) === resolve(rutaTrabajo)) {
    throw new Error(`BACKTEST_DB (${rutaTrabajo}) coincide con DB_PATH: el backtest no puede trabajar sobre la BD del radar. Usa otra ruta en BACKTEST_DB.`);
  }
}

export function abrirBdTrabajo(ruta: string, perfil: Perfil, ahora: Date): DatabaseSync {
  const db = abrirBd(ruta);
  if (!leerPerfil(db)) guardarSemilla(db, { perfil, organizacionesParecidas: [], fundaciones: [] }, ahora);
  return db;
}

function prepararConjuntos(o: OpcionesBacktest, perfil: Perfil): Promise<void> {
  return (async () => {
    if (o.solo !== 'b' && !leerConjunto(o.db, 'a').length) {
      o.log('Conjunto (a): identificando las convocatorias en BDNS…');
      guardarConjunto(o.db, await resolverConjuntoA(o.fetch, o.dormir), o.ahora);
    }
    if (o.solo === 'a') return;
    const hayB = leerConjunto(o.db, 'b').length > 0;
    if (hayB && !o.reconstruirB && !o.ampliarB) return;
    o.log('Conjunto (b): concesiones de las organizaciones parecidas activas…');
    if (o.reconstruirB) borrarConjunto(o.db, 'b');
    const parecidas = leerParecidas(o.db, true).map((p) => ({ nif: p.nif, nombre: p.nombre }));
    const excluir = new Set(leerConjunto(o.db, 'a').map((c) => c.numero));
    const yaExaminadas = new Set(leerConjunto(o.db, 'b').map((c) => c.numero));
    const r = await construirConjuntoB(o.fetch, perfil, parecidas, { excluir, yaExaminadas, dormir: o.dormir, pausaMs: o.pausaMs, maxDetalles: o.maxDetallesB, log: o.log });
    guardarConjunto(o.db, r.filas, o.ahora);
    o.log(`Conjunto (b): ${r.filas.length} examinadas ahora, ${r.filas.filter((f) => f.admitida).length} admitidas; ${r.ganadasPorReforesta.length} ganadas por Reforesta fuera; `
      + `${r.sinDetalle.length} sin detalle; ${r.omitidasPorTope} sin examinar por el tope (--ampliar-b para seguir)`);
  })();
}

/** Qué se procesa en esta ejecución: (a) entero y, del (b), las admitidas aún sin resultado completo, hasta `maxB`. */
export function objetivos(db: DatabaseSync, modo: Modo, o: Pick<OpcionesBacktest, 'maxB' | 'solo' | 'rehacer'>): FilaConjunto[] {
  const hechas = new Set(o.rehacer ? [] : leerResultados(db, modo).filter((r) => r.completa).map((r) => `${r.conjunto}:${r.numero}`));
  const pendiente = (c: FilaConjunto) => !hechas.has(`${c.conjunto}:${c.numero}`);
  const a = o.solo === 'b' ? [] : leerConjunto(db, 'a').filter(pendiente);
  const b = o.solo === 'a' ? [] : leerConjunto(db, 'b').filter((c) => c.admitida && pendiente(c)).sort((x, y) => x.orden.localeCompare(y.orden)).slice(0, o.maxB);
  return [...a, ...b];
}

/** Trae el detalle de BDNS, aplica las reglas y deja la convocatoria en la BD de trabajo. null = BDNS no la devolvió. */
async function prepararConvocatoria(o: OpcionesBacktest, perfil: Perfil, numero: string): Promise<{ c: Convocatoria; descarte: ReturnType<typeof cribar> } | null> {
  let c: Convocatoria;
  try {
    c = await convocatoriaDeNumero(o.fetch, numero);
  } catch (e) {
    o.log(`  ${numero}: sin detalle en BDNS (${(e as Error).message})`);
    return null;
  }
  const descarte = cribar(c, perfil);
  guardarConvocatoria(o.dbTrabajo, { convocatoria: c, descarte, condicion: descarte ? null : condicionAmbito(c, perfil) }, o.ahora);
  return { c, descarte };
}

/**
 * Puntúa con el reloj en la fecha de publicación (los días hasta el cierre cuentan desde ese día) y SIN el factor "probabilidad" real:
 * no se miran ganadoras previas (serían futuro y la fuente "parecidas" queda fuera), así que vale su valor neutro.
 */
export function puntuarEnSuFecha(c: Convocatoria, analisis: Analisis | null, perfil: Perfil, cfg: ConfigPuntuacion, festivos: TablaFestivos) {
  const cal = calendario(festivos, perfil.ambito.regiones);
  let plazo: { fechaCierre: string | null; tipo: 'literal' | 'calculada' | 'desconocida'; diasHastaCierre: number | null } | null = null;
  try {
    const p = conDiasHastaCierre(calcularPlazo(bdns.datosPlazo!(c), analisis?.plazo?.valor ?? null, cal), c.fechaPublicacion);
    plazo = { fechaCierre: p.fechaCierre, tipo: p.tipo, diasHastaCierre: p.diasHastaCierre };
  } catch {
    plazo = null;
  }
  return puntuar({ convocatoria: c, analisis, plazo, importeMinimo: perfil.importeMinimo }, cfg);
}

function resultadoDe(o: OpcionesBacktest, perfil: Perfil, conjunto: Conjunto, numero: string, previa: Awaited<ReturnType<typeof prepararConvocatoria>>): ResultadoGuardado {
  const modo = modoDe(o);
  const base = { conjunto, numero, modo, pasoReglas: false, motivoReglas: null, pasoCriba: false, motivoCriba: null, puntuacion: null, factores: [] as unknown[], completa: true };
  if (!previa) return { ...base, etapa: 'sin_datos', motivoReglas: 'BDNS no devolvió esta convocatoria', completa: false };
  if (previa.descarte) return { ...base, etapa: 'reglas', motivoReglas: previa.descarte.motivo };
  const fases = leerFases(o.dbTrabajo, previa.c.id);
  const criba = fases.find((f) => f.fase === FASE_CRIBA);
  const conReglas = { ...base, pasoReglas: true };
  if (!criba) return { ...conReglas, etapa: 'pendiente', motivoCriba: 'Criba sin hacer (tope de llamadas): resultado provisional', completa: false };
  if (criba.descarta) return { ...conReglas, etapa: 'criba_llm', motivoCriba: criba.motivo };
  const conCriba = { ...conReglas, pasoCriba: true, motivoCriba: criba.motivo };
  let analisis: Analisis | null = null;
  if (o.conAnalisis) {
    const f = fases.find((x) => x.fase === 'analisis');
    if (!f) return { ...conCriba, etapa: 'pendiente', motivoCriba: `${criba.motivo ?? ''} (sin analizar por el tope: provisional)`.trim(), completa: false };
    if (f.descarta) return { ...conCriba, pasoCriba: false, etapa: 'analisis', motivoCriba: f.motivo };
    analisis = (f.datos as { analisis?: Analisis } | undefined)?.analisis ?? null;
  }
  const p = puntuarEnSuFecha(previa.c, analisis, perfil, o.puntuacion, o.festivos);
  const factores = p.factores as Factor[];
  if (p.excluida) return { ...conCriba, etapa: 'puntuacion', motivoCriba: p.excluida, puntuacion: 0, factores };
  return { ...conCriba, etapa: 'puntuada', puntuacion: p.total, factores };
}

export async function ejecutarBacktest(o: OpcionesBacktest): Promise<ResumenBacktest> {
  const perfil = leerPerfil(o.db);
  if (!perfil) throw new Error('La BD no tiene perfil: ejecuta antes npm run seed');
  const modo = modoDe(o);
  if (!o.dryRun && !o.llm) throw new Error('Hace falta ANTHROPIC_API_KEY para el backtest (solo --dry-run funciona sin ella)');
  if (!leerPerfil(o.dbTrabajo)) guardarSemilla(o.dbTrabajo, { perfil, organizacionesParecidas: [], fundaciones: [] }, o.ahora);
  if (o.rehacer) o.dbTrabajo.exec('DELETE FROM convocatoria_fases; DELETE FROM puntuaciones; DELETE FROM plazos');

  await prepararConjuntos(o, perfil);
  const todas = objetivos(o.db, modo, o);
  const b = leerConjunto(o.db, 'b');
  o.log(`${todas.length} convocatorias a procesar (${todas.filter((c) => c.conjunto === 'a').length} del (a), ${todas.filter((c) => c.conjunto === 'b').length} del (b), tope del (b) ${o.maxB})`);

  const previas = new Map<string, Awaited<ReturnType<typeof prepararConvocatoria>>>();
  for (const c of todas) {
    await o.dormir(o.pausaMs);
    previas.set(`${c.conjunto}:${c.numero}`, await prepararConvocatoria(o, perfil, c.numero));
  }
  const resumen: ResumenBacktest = {
    conjuntoA: leerConjunto(o.db, 'a').length, conjuntoB: { examinadas: b.length, admitidas: b.filter((c) => c.admitida).length },
    procesadas: 0, pendientesB: 0, llamadas: 0, costeUsd: 0, topeAlcanzado: false, estimacion: null,
  };
  const cfgLlm = CONFIG_LLM_POR_DEFECTO;

  if (o.dryRun) {
    let pend = 0; let cache = 0; let tokens = 0;
    const pasan = pendientesDeFase(o.dbTrabajo, FASE_CRIBA, DESDE_SIEMPRE).filter((p) => [...previas.values()].some((x) => x?.c.id === p.convocatoria.id));
    for (const p of pasan) {
      pend++;
      const peticion = peticionCriba(perfil, p.convocatoria, p.condicion, cfgLlm.modeloCriba, [], [bdns]);
      if (leerLlmCache(o.dbTrabajo, claveCache(peticion))) cache++;
      else tokens += Math.ceil((peticion.sistema.length + peticion.mensaje.length) / 3.2);
    }
    const llamadas = pend - cache;
    const costeUsd = coste(cfgLlm.modeloCriba, { entrada: tokens, salida: llamadas * 120, cacheLectura: 0, cacheEscritura: 0 }) ?? 0;
    resumen.estimacion = {
      convocatorias: todas.length, pasanReglas: [...previas.values()].filter((x) => x && !x.descarte).length, pendientesCriba: pend, enCache: cache,
      llamadasHaiku: llamadas, costeUsd: Math.round(costeUsd * 10000) / 10000, superaTope: llamadas > o.maxLlamadas,
    };
    return resumen;
  }

  const llm = new LlmConTope(o.llm!, o.maxLlamadas);
  const ctx: ContextoFase = { db: o.dbTrabajo, llm, reloj: { now: () => o.ahora }, fetch: o.fetch, ejemplos: [] };
  const criba = await cribarConLlm(ctx, perfil, cfgLlm.modeloCriba, DESDE_SIEMPRE, [bdns]);
  o.log(`Criba: ${criba.procesadas} resueltas (${criba.llamadas} llamadas, ${criba.desdeCache} de caché), ${criba.errores.length} sin resolver`);
  if (o.conAnalisis) {
    const an = await analizarConLlm(ctx, perfil, cfgLlm.modeloAnalisis, o.maxAnalisis, DESDE_SIEMPRE, [bdns]);
    o.log(`Análisis: ${an.procesadas} resueltos (${an.llamadas} llamadas), ${an.errores.length} sin resolver`);
  }

  for (const c of todas) {
    const r = resultadoDe(o, perfil, c.conjunto, c.numero, previas.get(`${c.conjunto}:${c.numero}`) ?? null);
    guardarResultado(o.db, r, o.ahora);
    if (r.completa) resumen.procesadas++;
  }
  resumen.pendientesB = objetivos(o.db, modo, { maxB: 1e9, solo: 'b', rehacer: false }).length;
  resumen.llamadas = llm.usadas;
  resumen.costeUsd = Math.round(llm.costeUsd * 10000) / 10000;
  resumen.topeAlcanzado = llm.agotado;
  guardarEjecucion(o.db, modo, o.ahora, resumen.llamadas, resumen.costeUsd);
  return resumen;
}
