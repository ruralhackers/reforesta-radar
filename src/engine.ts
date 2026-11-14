// Motor del radar. Todo lo que toca el exterior entra por `DependenciasMotor`: es el punto de prueba.
// Orden: fuentes (recoger + reglas) → criba LLM (Haiku) → análisis (Sonnet). Fases futuras (puntuación) van detrás;
// el envío del correo será otra operación de este módulo con su propio emisor inyectado.
import type { DatabaseSync } from 'node:sqlite';
import {
  type ContadoresFuente, empezarEjecucion, empezarFuente, guardarConvocatoria, guardarRegistroFase, leerPerfil, reaplicarReglas,
  type RegistroFase, registroFaseVacio, terminarEjecucion, terminarFuente, transaccion, abortarEjecucionesColgadas,
} from './db/repo.ts';
import { analizarConLlm, FASE_ANALISIS } from './fases/analisis.ts';
import { cribarConLlm, FASE_CRIBA } from './fases/criba.ts';
import { rellenarTitulosCortos } from './fases/titulos.ts';
import { CONFIG_HUELLA_POR_DEFECTO, type ConfigHuella, recogerEmpresasHuella, type ResumenHuella } from './fases/huella.ts';
import { CONFIG_EMPRESAS_POR_DEFECTO, type ConfigEmpresas, recogerEmpresasDia, type ResumenEmpresas } from './fases/empresas.ts';
import { ocultarSinFormaJuridica } from './db/empresas.ts';
import { CONFIG_GANADORES_POR_DEFECTO, type ConfigGanadores, recogerGanadores, type ResumenGanadores } from './fases/ganadores.ts';
import { recogerHistorialSeries, type ResumenSeries } from './fases/series.ts';
import { CONFIG_PARECIDAS_POR_DEFECTO, type ConfigParecidas, descubrirParecidas, type ResumenParecidas } from './fases/parecidas.ts';
import { ejemplosDecisiones } from './db/decisiones.ts';
import { quitarMarcaDescubierta } from './db/ganadores.ts';
import { crearProbabilidad } from './ganadores.ts';
import { marcarDuplicadas, type ResumenDuplicadas } from './fases/duplicadas.ts';
import { calcularPlazos, type ResumenPlazos } from './fases/plazo.ts';
import { puntuarCandidatas, type ResumenPuntuacion } from './fases/puntuacion.ts';
import { type ConfigPuntuacion, leerConfigPuntuacion, type ProveedorProbabilidad } from './puntuacion.ts';
import { leerFestivos, type TablaFestivos } from './festivos.ts';
import { config } from './config.ts';
import { diaLocal, sumarDias } from './dates.ts';
import { CONFIG_LLM_POR_DEFECTO, type ConfigLlm, type Llm } from './llm/llm.ts';
import { conPresupuesto, type Presupuesto } from './llm/presupuesto.ts';
import { condicionAmbito, cribar } from './rules.ts';
import { FUENTES } from './sources/index.ts';
import type { Fuente } from './sources/source.ts';
import { reconsiderarVeredictos } from './perfil.ts';
import type { Perfil, Reloj } from './types.ts';

export { FUENTES };

export interface DependenciasMotor {
  db: DatabaseSync;
  fetch: typeof globalThis.fetch;
  /** DNS para la descarga segura de URLs que salen de datos (solo tests; por defecto, el del sistema con el fetch real). */
  resolver?: ((host: string) => Promise<string[]>) | null;
  reloj: Reloj;
  /** Fuentes a recorrer; por defecto todas las del radar. */
  fuentes?: Fuente[];
  /** LLM para la criba y el análisis. null/ausente = se saltan esas fases con un aviso en el registro (sin clave de API). */
  llm?: Llm | null;
  configLlm?: Partial<ConfigLlm>;
  /** Cuántas de las últimas decisiones del equipo se pasan como ejemplos a los prompts (por defecto RADAR_EJEMPLOS_DECISIONES, 20). */
  maxEjemplosDecisiones?: number;
  /** Calendario de festivos para los plazos en días hábiles; por defecto, seed/festivos.json (o FESTIVOS_FILE). */
  festivos?: TablaFestivos;
  /** Pesos y umbrales de la puntuación; por defecto, seed/puntuacion.json (o PUNTUACION_FILE). */
  puntuacion?: ConfigPuntuacion;
  /** Factor "probabilidad" enchufable; por defecto, el que sale de los ganadores previos y las organizaciones parecidas. */
  probabilidad?: ProveedorProbabilidad;
  /** Concesiones de BDNS: false = se salta la fase (sin red); objeto = caché y tope de consultas. Por defecto, activa. */
  ganadores?: boolean | Partial<ConfigGanadores>;
  /** Descubrimiento por organizaciones parecidas: false = se salta (sin red); objeto = caché, tope y ventanas. Por defecto, activo. */
  parecidas?: boolean | Partial<ConfigParecidas>;
  /**
   * Empresas con obligación de restaurar, a partir de las DIA del BOE (fase `empresas_dia_boe`, Haiku). Solo se ejecuta si se pide: `true` (valores por
   * defecto) u objeto con la configuración (el CLI pasa la de las variables de entorno); ausente/false = se salta (sin red hacia el BOE).
   */
  empresas?: boolean | Partial<ConfigEmpresas>;
  /**
   * Empresas del registro de huella de carbono del MITECO (fase `empresas_huella_carbono`, Haiku, tras la de las DIA). Solo se ejecuta si se pide: `true`
   * (valores por defecto) o un objeto con la configuración. Ausente = no se baja el registro (tests sin red).
   */
  huella?: boolean | Partial<ConfigHuella>;
  /** Espera entre peticiones a BDNS (por defecto setTimeout); los tests la inyectan. */
  dormir?: (ms: number) => Promise<void>;
  log?: (mensaje: string) => void;
}

export interface ResumenFuente extends ContadoresFuente {
  fuente: string;
  errores: string[];
  /** Avisos que no son fallos (p. ej. una fuente que necesita LLM y no lo hay). */
  avisos: string[];
}

export interface ResumenEjecucion {
  ejecucionId: number;
  conErrores: boolean;
  fuentes: ResumenFuente[];
  /** Criba LLM y análisis: contadores, tokens, coste, avisos y errores. */
  fases: RegistroFase[];
  /** Plazos de cierre (literal / calculada / desconocida) recalculados sobre las candidatas en juego. */
  plazos: ResumenPlazos | null;
  /** Puntuación explicable de las candidatas en juego (se guarda el desglose). */
  puntuacion: ResumenPuntuacion | null;
  /** Concesiones de BDNS y organizaciones parecidas; null si se saltó la fase. */
  ganadores: ResumenGanadores | null;
  /** Historial de las series relevantes (detalle de sus ediciones pasadas, para predecir la apertura); null si se saltó la fase. */
  series: ResumenSeries | null;
  /** Descubrimiento por organizaciones parecidas; null si se saltó la fase. */
  parecidas: ResumenParecidas | null;
  /** Empresas de las DIA del BOE; null si no se pidió la fase. */
  empresas: ResumenEmpresas | null;
  huella: ResumenHuella | null;
  /** Convocatorias de otras fuentes marcadas como duplicadas de una de BDNS (mismo título). */
  duplicadas: ResumenDuplicadas;
  /** Presupuesto de LLM de la ejecución (común a todas las fases) y lo gastado, fallos cobrados incluidos. */
  presupuesto: Presupuesto;
}

export interface OpcionesEjecucion {
  diasAtras?: number;
  /**
   * Convocatorias (ids) que pasan por criba, análisis y ganadores aunque estén fuera de la ventana de pendientes o ya no estén en juego
   * (`npm run cargar`). El análisis sigue sujeto al tope y al presupuesto.
   */
  incluirIds?: string[];
  /** Criba y análisis solo de `incluirIds` (sin lo pendiente de la ventana). */
  soloIncluidas?: boolean;
}

export async function ejecutarRadar(depsEntrada: DependenciasMotor, opciones: OpcionesEjecucion = {}): Promise<ResumenEjecucion> {
  // Un solo presupuesto de LLM para toda la ejecución: el LLM se envuelve una vez y todas las fases (también las fuentes) usan el envuelto.
  const cfgLlm = { ...CONFIG_LLM_POR_DEFECTO, ...depsEntrada.configLlm };
  const presupuesto: Presupuesto = { limiteUsd: cfgLlm.presupuestoUsd, gastadoUsd: 0 };
  const deps: DependenciasMotor = { ...depsEntrada, llm: depsEntrada.llm ? conPresupuesto(depsEntrada.llm, presupuesto) : null };
  const { db, reloj } = deps;
  const log = deps.log ?? (() => {});
  const perfil = leerPerfil(db);
  if (!perfil) throw new Error('La BD no tiene perfil: carga la semilla antes (npm run seed)');

  // Veredictos de LLM hechos con otro perfil (ámbito, líneas) se marcan obsoletos: se rehacen los de la ventana de pendientes.
  const reconsideradas = reconsiderarVeredictos(db, perfil);
  if (reconsideradas.cribas || reconsideradas.analisis) log(`Perfil cambiado: ${reconsideradas.cribas} cribas y ${reconsideradas.analisis} análisis quedan obsoletos (se rehacen los de los últimos ${cfgLlm.diasPendientes} días)`);
  // Las reglas (ámbito, finalidad…) vuelven a aplicarse a todo lo guardado: un cambio de perfil alcanza también a lo que las fuentes ya no devuelven.
  const reglasCambiadas = reaplicarReglas(db, perfil, cribar, condicionAmbito);
  if (reglasCambiadas) log(`Reglas reaplicadas: ${reglasCambiadas} convocatorias cambian de descarte o de condición de ámbito`);
  const inicio = reloj.now();
  // Una ejecución anterior que quedó "en_curso" (proceso matado) ya no va a terminar.
  const abortadas = abortarEjecucionesColgadas(db, inicio);
  if (abortadas) log(`${abortadas} ejecuciones anteriores quedaron a medias: se marcan como abortadas`);
  const ejecucionId = empezarEjecucion(db, inicio);
  const resumen: ResumenFuente[] = [];
  let fases: RegistroFase[] = [];
  const fasesDeFuentes: RegistroFase[] = []; // llamadas LLM propias de las fuentes (extracción de fundaciones)
  let plazos: ResumenPlazos | null = null;
  let puntuacion: ResumenPuntuacion | null = null;
  let ganadores = null as ResumenGanadores | null;
  let series = null as ResumenSeries | null;
  let parecidas = null as ResumenParecidas | null;
  let duplicadas: ResumenDuplicadas = { marcadas: 0 };
  let empresas: ResumenEmpresas | null = null;
  let huella: ResumenHuella | null = null;
  let errorGeneral: string | null = null;
  let conErrores = false;

  try {
    for (const fuente of deps.fuentes ?? FUENTES) {
      resumen.push(await recorrerFuente(deps, ejecucionId, fuente, perfil, opciones.diasAtras ?? 7, fasesDeFuentes));
    }
    // La misma convocatoria por dos fuentes (mismo título): se conserva la de BDNS. Antes de la criba, para no pagarla dos veces.
    duplicadas = marcarDuplicadas(db, reloj);
    if (duplicadas.marcadas) log(`duplicadas: ${duplicadas.marcadas} convocatorias de otras fuentes ya están en BDNS (mismo título)`);
    // Descubrimiento por parecidas: antes de la criba, para que lo descubierto pase por ella. Usa las parecidas ya guardadas
    // (semilla, manuales y las calculadas en la ejecución anterior) y comparte con los ganadores el tope de peticiones a BDNS.
    const hayBdns = (deps.fuentes ?? FUENTES).some((f) => f.nombre === 'bdns');
    const cfgGan = { ...CONFIG_GANADORES_POR_DEFECTO, ...(typeof deps.ganadores === 'object' ? deps.ganadores : config.ganadores) };
    if (deps.parecidas !== false && hayBdns) {
      const cfgP: ConfigParecidas = { ...CONFIG_PARECIDAS_POR_DEFECTO, diasCache: cfgGan.diasCache, pausaMs: cfgGan.pausaMs, ...(typeof deps.parecidas === 'object' ? deps.parecidas : config.parecidas) };
      cfgP.maxPeticiones = Math.min(cfgP.maxPeticiones, cfgGan.maxPeticiones);
      parecidas = await descubrirParecidas({ db, fetch: deps.fetch, reloj, dormir: deps.dormir }, perfil, cfgP);
      log(`parecidas: ${parecidas.organizaciones} organizaciones, ${parecidas.series} series, ${parecidas.consultas} consultas, ${parecidas.peticiones} peticiones a BDNS (${parecidas.desdeCache} en caché, ${parecidas.omitidasPorTope} sin hacer por el tope), ${parecidas.etiquetadas} candidatas con origen (${parecidas.nuevas} nuevas, ${parecidas.yaConocidas} ya conocidas), ${parecidas.errores.length} errores`);
      for (const e of parecidas.errores) log(`  ! ${e}`);
    }
    // Los ganadores se piden tras la criba (solo de lo que sigue en juego) y antes del análisis (que los usa como contexto).
    const pedirGanadores = async () => {
      if (deps.ganadores === false || !(deps.fuentes ?? FUENTES).some((f) => f.nombre === 'bdns')) return;
      const restantes = Math.max(0, cfgGan.maxPeticiones - (parecidas?.peticiones ?? 0));
      // Una parte pequeña del tope queda reservada para el historial de series: los ganadores no pueden agotarlo.
      const reservaSeries = Math.min(10, Math.floor(restantes / 5));
      const cfgG = { ...cfgGan, maxPeticiones: restantes - reservaSeries };
      ganadores = await recogerGanadores({ db, fetch: deps.fetch, reloj, dormir: deps.dormir }, perfil, cfgG, opciones.incluirIds ?? []);
      log(`ganadores: ${ganadores.consultas} consultas, ${ganadores.peticiones} peticiones a BDNS (${ganadores.desdeCache} consultas en caché, ${ganadores.omitidasPorTope} sin hacer por el tope), ${ganadores.concesiones} concesiones, ${ganadores.parecidas} organizaciones parecidas, ${ganadores.errores.length} errores`);
      for (const e of ganadores.errores) log(`  ! ${e}`);
      // Historial de las series relevantes (ediciones pasadas): comparte con lo anterior el tope de peticiones a BDNS de la ejecución.
      series = await recogerHistorialSeries(
        { db, fetch: deps.fetch, reloj, dormir: deps.dormir }, perfil, deps.festivos ?? leerFestivos(config.rutaFestivos),
        { maxPeticiones: Math.max(0, restantes - ganadores.peticiones), pausaMs: cfgG.pausaMs }, opciones.incluirIds ?? [],
      );
      log(`series: ${series.series} series relevantes, ${series.detalles} ediciones pasadas traídas, ${series.peticiones} peticiones a BDNS, ${series.omitidasPorTope} sin hacer por el tope, ${series.enEspera} en espera por fallos repetidos, ${series.errores.length} errores`);
      for (const e of series.errores) log(`  ! ${e}`);
      for (const a of series.avisos) log(`  · ${a}`);
    };
    fases = [...fasesDeFuentes, ...(await fasesLlm(deps, ejecucionId, perfil, inicio, pedirGanadores, opciones.incluirIds, opciones.soloIncluidas))];
    if (deps.empresas || deps.huella) {
      // Filas guardadas antes del filtro de persona jurídica: se ocultan (con motivo), no se borran.
      const ocultadas = ocultarSinFormaJuridica(db);
      if (ocultadas.length) log(`empresas: ${ocultadas.length} ocultadas por no tener forma jurídica (${ocultadas.slice(0, 5).join(', ')}${ocultadas.length > 5 ? '…' : ''})`);
    }
    if (deps.empresas) {
      const modelo = { ...CONFIG_LLM_POR_DEFECTO, ...deps.configLlm }.modeloCriba;
      const cfgE: ConfigEmpresas = { ...CONFIG_EMPRESAS_POR_DEFECTO, ...(typeof deps.empresas === 'object' ? deps.empresas : {}) };
      empresas = await recogerEmpresasDia({ db, fetch: deps.fetch, reloj, llm: deps.llm ?? null, modelo, dormir: deps.dormir }, cfgE);
      guardarRegistroFase(db, ejecucionId, empresas.fase);
      fases = [...fases, empresas.fase];
      const e = empresas;
      log(`empresas (DIA del BOE): ${e.diasRevisados} días revisados, ${e.resolucionesNuevas} resoluciones nuevas, ${e.leidas} leídas, ${e.conMedidas} con medidas (${e.empresasNuevas} empresas nuevas), ${e.sinMedidas} sin medidas, ${e.desfavorables} desfavorables, ${e.sinPromotor} sin promotor empresa, ${e.omitidasPorTope} sin hacer por el tope, ${e.fase.costeUsd.toFixed(4)} USD, ${e.errores.length} errores`);
      for (const a of e.fase.avisos) log(`  · ${a}`);
      for (const x of e.errores) log(`  ! ${x}`);
    }
    if (deps.huella) {
      const modelo = { ...CONFIG_LLM_POR_DEFECTO, ...deps.configLlm }.modeloCriba;
      const cfgH: ConfigHuella = { ...CONFIG_HUELLA_POR_DEFECTO, ...(typeof deps.huella === 'object' ? deps.huella : {}) };
      huella = await recogerEmpresasHuella({ db, fetch: deps.fetch, reloj, llm: deps.llm ?? null, modelo, perfil }, cfgH);
      guardarRegistroFase(db, ejecucionId, huella.fase);
      fases = [...fases, huella.fase];
      const h = huella;
      log(h.sinCambios
        ? 'empresas (huella de carbono): el registro no ha cambiado desde que se recorrió entero'
        : `empresas (huella de carbono): ${h.filasLeidas} filas leídas, ${h.organizaciones} organizaciones, ${h.preFiltradas} pasan el pre-filtro (${h.bajaConfianza} de baja confianza sin LLM; ${h.yaCribadas} ya cribadas), ${h.cribadas} cribadas con LLM, ${h.financiadoras} financiadoras (${h.empresasNuevas.length} empresas nuevas, ${h.empresasUnidas.length} unidas a una existente), ${h.descartadas} descartadas, ${h.omitidasPorTope} sin hacer por el tope, ${h.fase.costeUsd.toFixed(4)} USD, ${h.errores.length} errores`);
      for (const a of h.fase.avisos) log(`  · ${a}`);
      for (const x of h.errores) log(`  ! ${x}`);
    }
    plazos = calcularPlazos(db, reloj, perfil, deps.festivos ?? leerFestivos(config.rutaFestivos), deps.fuentes);
    log(`plazos: ${plazos.total} candidatas, ${plazos.literales} literales, ${plazos.calculadas} calculadas, ${plazos.desconocidas} desconocidas, ${plazos.errores.length} errores`);
    for (const e of plazos.errores) log(`  ! ${e}`);
    puntuacion = puntuarCandidatas(db, reloj, perfil, deps.puntuacion ?? leerConfigPuntuacion(config.rutaPuntuacion), deps.probabilidad ?? crearProbabilidad(db));
    log(`puntuación: ${puntuacion.total} candidatas, ${puntuacion.sinAnalizar} sin analizar, ${puntuacion.excluidas} excluidas, ${puntuacion.errores.length} errores`);
    for (const e of puntuacion.errores) log(`  ! ${e}`);
  } catch (e) {
    // Fallo fuera de una fuente (BD bloqueada, disco lleno, configuración…): se registra y se relanza.
    errorGeneral = (e as Error).message;
    throw e;
  } finally {
    const listas = [...resumen.map((f) => f.errores), ...fases.map((f) => f.errores), plazos?.errores, puntuacion?.errores, ganadores?.errores, series?.errores,
      parecidas?.errores, empresas?.errores, huella?.errores];
    conErrores = errorGeneral !== null || listas.some((e) => (e?.length ?? 0) > 0);
    try {
      terminarEjecucion(db, ejecucionId, reloj.now(), conErrores, errorGeneral);
    } catch (e) {
      log(`! No se pudo cerrar la ejecución ${ejecucionId}: ${(e as Error).message}`);
      if (errorGeneral === null) throw e; // si ya había un fallo, ese es el que se relanza
    }
  }
  if (deps.llm && presupuesto.gastadoUsd >= presupuesto.limiteUsd) log(`Presupuesto de LLM agotado: ${presupuesto.gastadoUsd.toFixed(4)} de ${presupuesto.limiteUsd.toFixed(2)} USD`);

  return { ejecucionId, conErrores, fuentes: resumen, fases, plazos, puntuacion, ganadores, series, parecidas, empresas, huella, duplicadas, presupuesto };
}

/**
 * Criba LLM y análisis sobre las candidatas publicadas en los últimos `diasPendientes` días (las haya devuelto o no
 * la fuente en esta ejecución). Cada fase salta las convocatorias que ya tienen su
 * veredicto (no se repiten llamadas). Sin LLM, ambas se registran como omitidas con un aviso.
 */
async function fasesLlm(
  deps: DependenciasMotor, ejecucionId: number, perfil: Perfil, inicio: Date, entreCribaYAnalisis: () => Promise<void>, incluirIds?: string[], soloIncluidas?: boolean,
): Promise<RegistroFase[]> {
  const log = deps.log ?? (() => {});
  const cfg = { ...CONFIG_LLM_POR_DEFECTO, ...deps.configLlm };
  let fases: RegistroFase[];
  if (!deps.llm) {
    const aviso = 'Sin LLM configurado (falta ANTHROPIC_API_KEY): criba y análisis omitidos en esta ejecución';
    fases = [registroFaseVacio(FASE_CRIBA, null), registroFaseVacio(FASE_ANALISIS, null)];
    for (const f of fases) f.avisos.push(aviso);
    await entreCribaYAnalisis();
  } else {
    const ctx = {
      db: deps.db, llm: deps.llm, reloj: deps.reloj, fetch: deps.fetch, resolver: deps.resolver, maxIntentos: cfg.maxIntentos, incluirIds, soloIncluidas,
      ejemplos: ejemplosDecisiones(deps.db, deps.maxEjemplosDecisiones ?? config.decisiones.maxEjemplos),
    };
    const publicadasDesde = sumarDias(diaLocal(inicio), -(cfg.diasPendientes - 1));
    const criba = await cribarConLlm(ctx, perfil, cfg.modeloCriba, publicadasDesde, deps.fuentes);
    guardarRegistroFase(deps.db, ejecucionId, criba);
    await entreCribaYAnalisis();
    const analisis = await analizarConLlm(ctx, perfil, cfg.modeloAnalisis, cfg.maxAnalisis, publicadasDesde, deps.fuentes, cfg.maxCaracteresAnalisis);
    // Títulos cortos de lo ya analizado que no los tiene (analizado antes de que el análisis los pidiera): Haiku con solo el título oficial.
    const titulos = await rellenarTitulosCortos(ctx, cfg.modeloCriba);
    // Solo consta en el registro si hizo algo (casi siempre no hay nada que rellenar).
    const hizoAlgo = titulos.procesadas + titulos.llamadas + titulos.omitidasPorTope + titulos.errores.length > 0;
    fases = hizoAlgo ? [criba, analisis, titulos] : [criba, analisis];
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
  deps: DependenciasMotor, ejecucionId: number, fuente: Fuente, perfil: Perfil, diasAtras: number, fasesDeFuentes: RegistroFase[],
): Promise<ResumenFuente> {
  const { db, reloj } = deps;
  const log = deps.log ?? (() => {});
  empezarFuente(db, ejecucionId, fuente.nombre, reloj.now());
  const n: ContadoresFuente = { recibidas: 0, nuevas: 0, candidatas: 0, descartadas: 0 };
  let errores: string[] = [];
  let avisos: string[] = [];
  try {
    const modeloLlm = { ...CONFIG_LLM_POR_DEFECTO, ...deps.configLlm }.modeloCriba;
    const r = await fuente.recoger({ fetch: deps.fetch, ahora: reloj.now(), perfil, diasAtras, dormir: deps.dormir, cribar: (c) => cribar(c, perfil), db, llm: deps.llm, modeloLlm, resolver: deps.resolver });
    errores = r.errores;
    avisos = r.avisos ?? [];
    if (r.fase) {
      guardarRegistroFase(db, ejecucionId, r.fase);
      fasesDeFuentes.push(r.fase);
      log(`${r.fase.fase}: ${r.fase.procesadas} páginas leídas, ${r.fase.llamadas} llamadas (${r.fase.desdeCache} de caché), ${r.fase.costeUsd.toFixed(4)} USD, ${r.fase.errores.length} errores`);
    }
    transaccion(db, () => {
      for (const cribada of r.cribadas) {
        n.recibidas++;
        try { // un registro malformado no tumba la fuente: queda como error de ese registro y se sigue
          const condicion = cribada.descarte ? null : condicionAmbito(cribada.convocatoria, perfil);
          if (guardarConvocatoria(db, { ...cribada, condicion }, reloj.now())) n.nuevas++;
          quitarMarcaDescubierta(db, cribada.convocatoria.id); // si antes solo la había descubierto "parecidas", ahora viene directa
          if (cribada.descarte) n.descartadas++;
          else n.candidatas++;
        } catch (e) {
          errores = [...errores, `Registro ${cribada.convocatoria.id}: ${(e as Error).message}`];
        }
      }
    });
  } catch (e) {
    errores = [...errores, `Fallo de la fuente: ${(e as Error).message}`];
  }
  terminarFuente(db, ejecucionId, fuente.nombre, reloj.now(), n, errores);
  log(`${fuente.nombre}: ${n.recibidas} recibidas, ${n.nuevas} nuevas, ${n.candidatas} candidatas, ${n.descartadas} descartadas, ${errores.length} errores`);
  for (const e of errores) log(`  ! ${e}`);
  for (const a of avisos) log(`  · ${a}`);
  return { fuente: fuente.nombre, ...n, errores, avisos };
}

// Correo del lunes: otra operación del motor, con su propio emisor inyectado.
export { enviarResumen, prepararResumen } from './resumen.ts';
