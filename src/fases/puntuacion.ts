// Fase `puntuacion` (determinista, sin LLM): puntúa cada candidata en juego con su análisis y su plazo y guarda el
// desglose. Se recalcula entera en cada ejecución (barata) para que se reflejen los cambios de reloj y de plazo.
import type { DatabaseSync } from 'node:sqlite';
import { enJuegoTodas, guardarPuntuacion, leerFases, leerPlazo } from '../db/repo.ts';
import { diaLocal } from '../dates.ts';
import { type ConfigPuntuacion, type ProveedorProbabilidad, puntuar } from '../puntuacion.ts';
import type { Perfil, Reloj } from '../types.ts';
import type { Analisis } from './analisis-esquema.ts';
import { FASE_ANALISIS } from './analisis.ts';

export interface ResumenPuntuacion {
  total: number;
  /** Sin analizar (puntuadas con el encaje desconocido). */
  sinAnalizar: number;
  excluidas: number;
  errores: string[];
}

export function puntuarCandidatas(
  db: DatabaseSync, reloj: Reloj, perfil: Perfil, config: ConfigPuntuacion, probabilidad?: ProveedorProbabilidad,
): ResumenPuntuacion {
  const hoy = diaLocal(reloj.now());
  const r: ResumenPuntuacion = { total: 0, sinAnalizar: 0, excluidas: 0, errores: [] };
  for (const c of enJuegoTodas(db)) {
    try {
      const datos = leerFases(db, c.id).find((f) => f.fase === FASE_ANALISIS)?.datos as { analisis?: Analisis } | undefined;
      const plazo = leerPlazo(db, c.id, hoy);
      const p = puntuar({
        convocatoria: c, analisis: datos?.analisis ?? null, importeMinimo: perfil.importeMinimo,
        plazo: plazo && { fechaCierre: plazo.fechaCierre, tipo: plazo.tipo, diasHastaCierre: plazo.diasHastaCierre },
      }, config, probabilidad);
      guardarPuntuacion(db, c.id, p, reloj.now());
      r.total++;
      if (!p.analizada) r.sinAnalizar++;
      if (p.excluida) r.excluidas++;
    } catch (e) {
      r.errores.push(`Puntuación ${c.id}: ${(e as Error).message}`);
    }
  }
  return r;
}
