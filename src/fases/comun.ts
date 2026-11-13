// Piezas comunes de las fases LLM: llamada con caché por hash de la petición y contabilidad de tokens y coste.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { guardarLlmCache, leerLlmCache, type RegistroFase } from '../db/repo.ts';
import type { EjemploDecision } from '../db/decisiones.ts';
import type { Llm, PeticionLlm } from '../llm/llm.ts';
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

/**
 * Llama al LLM (sin mirar la caché: eso lo decide quien llama) y apunta uso y coste. No guarda en caché:
 * quien llama lo hace con `aCache` cuando la respuesta es válida (una respuesta mala no debe quedarse para siempre).
 */
export async function llamar(ctx: ContextoFase, registro: RegistroFase, p: PeticionLlm): Promise<Respuesta> {
  registro.llamadas++;
  const r = await ctx.llm.generar(p);
  registro.tokensEntrada += r.uso.entrada;
  registro.tokensSalida += r.uso.salida;
  registro.tokensCacheLectura += r.uso.cacheLectura;
  registro.tokensCacheEscritura += r.uso.cacheEscritura;
  const c = coste(r.modelo, r.uso);
  if (c === null) {
    const aviso = `Sin precio para el modelo ${r.modelo}: su coste no se cuenta`;
    if (!registro.avisos.includes(aviso)) registro.avisos.push(aviso);
  } else {
    registro.costeUsd += c;
  }
  return { datos: r.datos, modelo: r.modelo, desdeCache: false };
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
