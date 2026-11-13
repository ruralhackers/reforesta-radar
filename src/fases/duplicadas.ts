// Fase `duplicada`: la misma convocatoria puede llegar por dos fuentes (p. ej. una convocatoria de la UE cofinanciada que también
// registra BDNS). Se compara el título normalizado (sin tildes, mayúsculas ni puntuación) entre fuentes distintas y se conserva la de
// BDNS, que trae plazo, extracto y bases; la otra se marca con un veredicto de fase `duplicada` (descarta = 1, con el id de la que
// se conserva), que sobrevive a las pasadas de la fuente y la saca de las candidatas, de la criba LLM y del ranking.
// Solo compara títulos de al menos 4 palabras, para no unir convocatorias distintas con un nombre genérico.
import type { DatabaseSync } from 'node:sqlite';
import { guardarFase } from '../db/repo.ts';
import { normalizar } from '../rules.ts';
import type { Reloj } from '../types.ts';

export const FASE_DUPLICADA = 'duplicada';
const FUENTE_PREFERIDA = 'bdns';
const MIN_PALABRAS = 4;

export function claveTitulo(titulo: string): string {
  return normalizar(titulo).replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface ResumenDuplicadas {
  marcadas: number;
}

/** Marca como duplicadas las candidatas de otras fuentes cuyo título coincide con una de BDNS. Idempotente. */
export function marcarDuplicadas(db: DatabaseSync, reloj: Reloj): ResumenDuplicadas {
  const filas = db.prepare('SELECT id, fuente, titulo FROM convocatorias WHERE descarte_regla IS NULL ORDER BY id').all() as { id: string; fuente: string; titulo: string }[];
  const preferidas = new Map<string, string>();
  for (const f of filas) {
    const k = claveTitulo(f.titulo);
    if (f.fuente === FUENTE_PREFERIDA && k.split(' ').length >= MIN_PALABRAS && !preferidas.has(k)) preferidas.set(k, f.id);
  }
  let marcadas = 0;
  for (const f of filas) {
    if (f.fuente === FUENTE_PREFERIDA) continue;
    const original = preferidas.get(claveTitulo(f.titulo));
    if (!original) continue;
    guardarFase(db, { convocatoriaId: f.id, fase: FASE_DUPLICADA, descarta: true, motivo: `Duplicada de ${original} (mismo título en ${FUENTE_PREFERIDA.toUpperCase()})`, datos: { duplicadaDe: original } }, reloj.now());
    marcadas++;
  }
  return { marcadas };
}
