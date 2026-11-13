// Precios por millón de tokens (USD), para registrar el coste de cada ejecución.
// Fuente: tabla de precios de Anthropic (noviembre de 2026). Si cambian, se cambian aquí.
import type { UsoLlm } from './llm.ts';

export interface Precio {
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
}

export const PRECIOS: Record<string, Precio> = {
  'claude-haiku-5-5': { entrada: 0.1, salida: 0.5, cacheLectura: 0.01, cacheEscritura: 0.125 },
  'claude-sonnet-5-5': { entrada: 2, salida: 10, cacheLectura: 0.1, cacheEscritura: 2.5 },
  'claude-sonnet-5': { entrada: 2, salida: 10, cacheLectura: 0.2, cacheEscritura: 2.5 },
  'claude-opus-5-5': { entrada: 4, salida: 20, cacheLectura: 0.2, cacheEscritura: 5 },
};

/** Coste en USD de un uso; null si el modelo no está en la tabla (se avisa en el registro). */
export function coste(modelo: string, uso: UsoLlm, precios: Record<string, Precio> = PRECIOS): number | null {
  const p = precios[modelo];
  if (!p) return null;
  return (uso.entrada * p.entrada + uso.salida * p.salida + uso.cacheLectura * p.cacheLectura + uso.cacheEscritura * p.cacheEscritura) / 1e6;
}
