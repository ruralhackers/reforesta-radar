// Piezas comunes de las fases LLM: llamada con caché por hash de la petición y contabilidad de tokens y coste.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { apuntarFalloLlm, guardarLlmCache, leerLlmCache, type RegistroFase } from '../db/repo.ts';
import type { EjemploDecision } from '../db/decisiones.ts';
import { ErrorLlm, type Llm, type PeticionLlm, type UsoLlm } from '../llm/llm.ts';
import { PresupuestoAgotado } from '../llm/presupuesto.ts';
import { coste } from '../llm/precios.ts';
import type { Reloj } from '../types.ts';

export interface ContextoFase {
  db: DatabaseSync;
  llm: Llm;
  reloj: Reloj;
  fetch: typeof globalThis.fetch;
  resolver?: ((host: string) => Promise<string[]>) | null;
  /** Decisiones del equipo como ejemplos para los prompts; se leen una vez por ejecución para que todas las llamadas vean los mismos. */
  ejemplos?: EjemploDecision[];
  /** Intentos fallidos por error del LLM (entre ejecuciones) tras los que una convocatoria deja de reintentarse; ausente = sin límite. */
  maxIntentos?: number;
  /** Convocatorias que se procesan aunque estén fuera de la ventana de pendientes (`npm run cargar`). */
  incluirIds?: string[];
}

/** Apunta el fallo de una convocatoria en una fase y avisa si llega al tope de intentos. */
export function fallo(ctx: ContextoFase, registro: RegistroFase, fase: string, id: string, e: unknown, etiqueta: string): void {
  const mensaje = (e as Error).message;
  registro.errores.push(`${etiqueta} ${id}: ${mensaje}`);
  if (!(e instanceof ErrorLlm)) return; // red, documentos…: no gasta intentos
  const intentos = apuntarFalloLlm(ctx.db, id, fase, mensaje, ctx.reloj.now());
  if (ctx.maxIntentos !== undefined && intentos >= ctx.maxIntentos) {
    registro.avisos.push(`${etiqueta} ${id}: ${intentos} intentos fallidos del LLM, no se reintenta más (último error: ${mensaje.slice(0, 200)})`);
  }
}

export function claveCache(p: PeticionLlm): string {
  const { modelo, sistema, mensaje, esquema, maxTokens } = p;
  return createHash('sha256').update(JSON.stringify({ modelo, sistema, mensaje, esquema, maxTokens })).digest('hex');
}

export interface Respuesta {
  datos: unknown;
  modelo: string;
  desdeCache: boolean;
}

export function desdeCache(db: DatabaseSync, clave: string): Respuesta | null {
  const c = leerLlmCache(db, clave) as { datos: unknown; modelo: string } | undefined;
  return c ? { datos: c.datos, modelo: c.modelo, desdeCache: true } : null;
}

function sumarUso(registro: RegistroFase, modelo: string, uso: UsoLlm): void {
  registro.tokensEntrada += uso.entrada;
  registro.tokensSalida += uso.salida;
  registro.tokensCacheLectura += uso.cacheLectura;
  registro.tokensCacheEscritura += uso.cacheEscritura;
  const c = coste(modelo, uso);
  if (c === null) {
    const aviso = `Sin precio para el modelo ${modelo}: su coste no se cuenta`;
    if (!registro.avisos.includes(aviso)) registro.avisos.push(aviso);
  } else {
    registro.costeUsd += c;
  }
}

/**
 * Llama al LLM (sin mirar la caché: eso lo decide quien llama) y apunta uso y coste, también de las llamadas que fallan tras cobrarse
 * (ErrorLlm con uso). No guarda en caché: quien llama lo hace con `aCache` cuando la respuesta es válida (una respuesta mala no debe
 * quedarse para siempre). Si el presupuesto de la ejecución está agotado lanza PresupuestoAgotado sin llamar (y lo avisa una vez en el
 * registro): quien llama lo cuenta como "sin hacer por el tope" con `esPresupuestoAgotado`, no como error.
 */
export async function llamar(ctx: ContextoFase, registro: RegistroFase, p: PeticionLlm): Promise<Respuesta> {
  try {
    const r = await ctx.llm.generar(p);
    registro.llamadas++;
    sumarUso(registro, r.modelo, r.uso);
    return { datos: r.datos, modelo: r.modelo, desdeCache: false };
  } catch (e) {
    if (e instanceof PresupuestoAgotado) {
      const aviso = `${e.message}: lo que falta queda pendiente para la próxima ejecución`;
      if (!registro.avisos.includes(aviso)) registro.avisos.push(aviso);
    } else {
      registro.llamadas++;
      if (e instanceof ErrorLlm && e.uso) sumarUso(registro, e.modelo ?? p.modelo, e.uso);
    }
    throw e;
  }
}

export const esPresupuestoAgotado = (e: unknown): e is PresupuestoAgotado => e instanceof PresupuestoAgotado;

/** Valida la respuesta; si no vale, el fallo es del LLM (cuenta como intento fallido de la convocatoria). */
export function validarRespuesta<T>(validar: () => T): T {
  try {
    return validar();
  } catch (e) {
    throw new ErrorLlm(`Respuesta no válida: ${(e as Error).message}`);
  }
}

export function aCache(ctx: ContextoFase, clave: string, r: Respuesta): void {
  if (!r.desdeCache) guardarLlmCache(ctx.db, clave, r.modelo, { datos: r.datos, modelo: r.modelo }, ctx.reloj.now());
}

export async function enParalelo<T>(items: T[], n: number, tarea: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const trabajador = async () => {
    while (i < items.length) await tarea(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, trabajador));
}
