// Fase `memorias` (Sonnet): lee las memorias anuales que apunta el perfil (`perfil.memorias`) y guarda los proyectos propios, los financiadores propios y
// las cifras de cabecera, cada dato con su cita literal comprobada contra el texto. Documento sin cambios (mismo hash) = no se vuelve a extraer.
// Dos modos: el comando `npm run memorias` (revisa toda la lista) y el motor (solo las URL que aún no tienen memoria guardada: «cuando cambia la lista»).
import type { DatabaseSync } from 'node:sqlite';
import { guardarMemoria, hashMemoria } from '../db/memorias.ts';
import { guardarEstadoFuente, leerDocumento, leerEstadoFuente, leerTexto, type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { leerDocumentos } from '../documentos.ts';
import { anadirMemorias } from '../perfil.ts';
import { ErrorTamano, ErrorUrlBloqueada, fetchSeguro, type Resolver } from '../fetch-seguro.ts';
import { PRECIOS } from '../llm/precios.ts';
import { enlacesDeMemorias, MAX_TOKENS_MEMORIA, peticionMemoria, validarMemoria } from '../memorias.ts';
import type { Perfil } from '../types.ts';
import { aCache, claveCache, desdeCache, esPresupuestoAgotado, llamar, validarRespuesta, type ContextoFase } from './comun.ts';

export const FASE_MEMORIAS = 'memorias';
/** Fallos de descarga seguidos tras los que el motor deja de insistir con una memoria (el comando sí lo intenta siempre). */
const MAX_FALLOS_MOTOR = 3;
const DIAS_ENTRE_DESCUBRIMIENTOS = 7;

export interface ConfigMemorias {
  /** Caracteres de una memoria que entran en el prompt (el resto se recorta con una nota y las citas se comprueban contra lo enviado). */
  maxCaracteres: number;
  /** Bytes máximos de la página donde se descubren los enlaces. */
  maxBytesPagina: number;
  /** Proyección de coste (USD) por encima de la cual no se llama al LLM. */
  maxProyeccionUsd: number;
  /** Descargar de nuevo los documentos (olvida la caché por URL; sigue comparándose el hash: si no cambió, no se extrae). */
  refrescar: boolean;
  /** Motor: solo las memorias sin extracción guardada y sin mirar si cambiaron. */
  soloPendientes: boolean;
  /** Extracciones (llamadas a Sonnet) como mucho en esta ejecución; el resto queda pendiente. El motor las limita para no gastar su presupuesto diario en ponerse al día. */
  maxExtracciones: number;
  /** Buscar en `perfil.paginaMemorias` los enlaces que falten. */
  descubrir: boolean;
}

export const CONFIG_MEMORIAS_POR_DEFECTO: ConfigMemorias = {
  maxCaracteres: 150_000, maxBytesPagina: 3 * 1024 * 1024, maxProyeccionUsd: 5, refrescar: false, soloPendientes: false, descubrir: true, maxExtracciones: Number.POSITIVE_INFINITY,
};

export interface ResumenMemorias {
  fase: RegistroFase;
  /** Direcciones nuevas halladas en la página y añadidas a la lista del perfil. */
  descubiertas: string[];
  /** Memorias de la lista del perfil. */
  enLista: number;
  extraidas: number;
  sinCambios: number;
  /** Cuántos proyectos, financiadores y cifras salieron de las extraídas ahora. */
  proyectos: number;
  financiadores: number;
  /** Proyección (USD) del coste de lo que había que extraer, calculada antes de llamar. */
  proyeccionUsd: number;
  errores: string[];
}

type Contexto = Pick<ContextoFase, 'db' | 'llm' | 'reloj' | 'fetch' | 'resolver'>;

/** Estimación gruesa del coste de extraer un texto: ~3,2 caracteres por token de entrada y unos 7.000 tokens de salida. */
export function costeProyectado(modelo: string, caracteres: number): number {
  const p = PRECIOS[modelo] ?? PRECIOS['claude-sonnet-5-5'];
  return (Math.ceil(caracteres / 3.2) * p.entrada + Math.min(7000, MAX_TOKENS_MEMORIA) * p.salida) / 1e6;
}

/**
 * Busca en la página de memorias del perfil los PDF que faltan en su lista y los añade. Devuelve los nuevos. Un fallo no lanza: queda en `errores`.
 * El motor la llama como mucho una vez a la semana (`fuente_estado`).
 */
export async function descubrirMemorias(ctx: Contexto, perfil: Perfil, maxBytes: number, errores: string[]): Promise<{ nuevas: string[]; perfil: Perfil }> {
  const pagina = perfil.paginaMemorias;
  if (!pagina) return { nuevas: [], perfil };
  try {
    const r = await fetchSeguro(ctx.fetch, pagina, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)' }, timeoutMs: 60_000, maxBytes, resolver: ctx.resolver });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const enlaces = enlacesDeMemorias(new TextDecoder().decode(r.bytes), r.url);
    const nuevas = enlaces.filter((u) => !(perfil.memorias ?? []).includes(u));
    return nuevas.length ? { nuevas, perfil: anadirMemorias(ctx.db, nuevas, ctx.reloj.now()) } : { nuevas, perfil };
  } catch (e) {
    errores.push(`Página de memorias ${pagina}: ${(e as Error).message}${e instanceof ErrorUrlBloqueada || e instanceof ErrorTamano ? ' (descartada)' : ''}`);
    return { nuevas: [], perfil };
  }
}

/** Debe el motor volver a mirar la página de memorias (no lo hizo en la última semana)? Apunta el intento. */
export function tocaDescubrir(db: DatabaseSync, ahora: Date): boolean {
  const ultimo = leerEstadoFuente(db, 'memorias', 'descubierto');
  if (ultimo && ahora.getTime() - new Date(ultimo).getTime() < DIAS_ENTRE_DESCUBRIMIENTOS * 86_400_000) return false;
  guardarEstadoFuente(db, 'memorias', 'descubierto', ahora.toISOString(), ahora);
  return true;
}

export async function procesarMemorias(ctx: Contexto, perfilEntrada: Perfil, modelo: string, cfgParcial: Partial<ConfigMemorias> = {}): Promise<ResumenMemorias> {
  const cfg = { ...CONFIG_MEMORIAS_POR_DEFECTO, ...cfgParcial };
  const registro = registroFaseVacio(FASE_MEMORIAS, modelo);
  const errores: string[] = [];
  let perfil = perfilEntrada;
  const r: ResumenMemorias = { fase: registro, descubiertas: [], enLista: 0, extraidas: 0, sinCambios: 0, proyectos: 0, financiadores: 0, proyeccionUsd: 0, errores };
  const ahora = () => ctx.reloj.now();
  const registrarError = (url: string, mensaje: string, transitorio: boolean) => {
    errores.push(`Memoria ${url}: ${mensaje}`);
    registro.errores.push(`Memoria ${url}: ${mensaje}`);
    if (transitorio) guardarEstadoFuente(ctx.db, 'memorias', `fallo:${url}`, String(Number(leerEstadoFuente(ctx.db, 'memorias', `fallo:${url}`) ?? 0) + 1), ahora());
  };

  if (cfg.descubrir && perfil.paginaMemorias) {
    const d = await descubrirMemorias(ctx, perfil, cfg.maxBytesPagina, errores);
    perfil = d.perfil;
    r.descubiertas = d.nuevas;
    for (const e of errores) registro.errores.push(e);
    if (d.nuevas.length) registro.avisos.push(`${d.nuevas.length} memorias nuevas descubiertas en ${perfil.paginaMemorias}`);
  }
  const urls = perfil.memorias ?? [];
  r.enLista = urls.length;
  if (urls.length === 0) return r;

  // 1. Leer los documentos (descarga segura con tope de tamaño, PDF → texto, caché por hash) y decidir qué hay que extraer.
  const trabajos: { url: string; hash: string; paginas: number | null; texto: string; peticion: ReturnType<typeof peticionMemoria> }[] = [];
  for (const url of urls) {
    if (cfg.soloPendientes) {
      if (hashMemoria(ctx.db, url) !== null) { r.sinCambios++; continue; }
      if (Number(leerEstadoFuente(ctx.db, 'memorias', `fallo:${url}`) ?? 0) >= MAX_FALLOS_MOTOR) { registro.avisos.push(`Memoria ${url}: ${MAX_FALLOS_MOTOR} fallos seguidos, el motor no insiste (npm run memorias lo reintenta)`); continue; }
    }
    if (cfg.refrescar) ctx.db.prepare('DELETE FROM documentos WHERE url = ?').run(url);
    const lectura = await leerDocumentos(ctx.db, ctx.fetch, [{ titulo: `Memoria ${url}`, url }], ahora(), ctx.resolver);
    const fallo = [...lectura.erroresTransitorios.map((m) => [m, true] as const), ...lectura.errores.map((m) => [m, false] as const)][0];
    if (fallo) { registrarError(url, fallo[0], fallo[1]); continue; }
    const doc = leerDocumento(ctx.db, url);
    if (!doc?.hash || lectura.textos.length === 0) { registrarError(url, 'documento sin texto', false); continue; }
    guardarEstadoFuente(ctx.db, 'memorias', `fallo:${url}`, '0', ahora());
    if (hashMemoria(ctx.db, url) === doc.hash) { r.sinCambios++; continue; }
    let texto = lectura.textos[0].texto;
    if (texto.length > cfg.maxCaracteres) {
      registro.avisos.push(`Memoria ${url} recortada a ${cfg.maxCaracteres} caracteres (${texto.length - cfg.maxCaracteres} sin leer)`);
      texto = `${texto.slice(0, cfg.maxCaracteres)}\n[… documento recortado: ${texto.length} caracteres en total]`;
    }
    trabajos.push({ url, hash: doc.hash, paginas: leerTexto(ctx.db, doc.hash)?.paginas ?? null, texto, peticion: peticionMemoria(perfil, url, texto, modelo) });
  }

  if (trabajos.length > cfg.maxExtracciones) {
    registro.avisos.push(`${trabajos.length - cfg.maxExtracciones} memorias quedan pendientes por el tope de ${cfg.maxExtracciones} extracciones por ejecución (se retoman en la siguiente)`);
    trabajos.length = cfg.maxExtracciones;
  }

  // 2. Proyección de coste antes de llamar (lo que ya está en la caché de respuestas no cuesta).
  r.proyeccionUsd = trabajos.filter((t) => !desdeCache(ctx.db, claveCache(t.peticion))).reduce((s, t) => s + costeProyectado(modelo, t.texto.length), 0);
  if (r.proyeccionUsd > cfg.maxProyeccionUsd) {
    const m = `Proyección de coste de las memorias: ${r.proyeccionUsd.toFixed(2)} USD, por encima del tope de ${cfg.maxProyeccionUsd.toFixed(2)}: no se llama al LLM`;
    errores.push(m); registro.errores.push(m);
    return r;
  }

  // 3. Extraer (una a una: son pocas y así el presupuesto se agota limpio).
  for (const t of trabajos) {
    try {
      const { textoEnviado, ...peticion } = t.peticion;
      const clave = claveCache(peticion);
      const resp = desdeCache(ctx.db, clave) ?? (await llamar({ ...ctx, db: ctx.db } as ContextoFase, registro, peticion));
      if (resp.desdeCache) registro.desdeCache++;
      const m = validarRespuesta(() => validarMemoria(resp.datos, textoEnviado, perfil, t.url, t.hash, resp.modelo, t.paginas));
      aCache(ctx as ContextoFase, clave, resp);
      guardarMemoria(ctx.db, m, ahora());
      registro.procesadas++;
      r.extraidas++; r.proyectos += m.proyectos.length; r.financiadores += m.financiadores.length;
      for (const c of m.correcciones) registro.avisos.push(`Memoria ${m.anio ?? t.url}: ${c}`);
    } catch (e) {
      if (esPresupuestoAgotado(e)) { registro.omitidasPorTope++; continue; }
      errores.push(`Memoria ${t.url}: ${(e as Error).message}`);
      registro.errores.push(`Memoria ${t.url}: ${(e as Error).message}`);
    }
  }
  if (registro.omitidasPorTope) registro.avisos.push(`Presupuesto de LLM agotado: ${registro.omitidasPorTope} memorias quedan sin extraer (se retoman en la siguiente ejecución)`);
  return r;
}
