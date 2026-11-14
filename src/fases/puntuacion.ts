// Fase `puntuacion` (determinista, sin LLM): puntúa cada candidata en juego con su análisis y su plazo y guarda el
// desglose. Se recalcula entera en cada ejecución (barata) para que se reflejen los cambios de reloj y de plazo.
import type { DatabaseSync } from 'node:sqlite';
import { borrarPuntuacionesFueraDeJuego, enJuegoTodas, guardarPuntuacion, leerFases, leerPerfil, leerPlazo, type PlazoGuardado } from '../db/repo.ts';
import { ingresosAnuales, presupuestoMaximoLicitacion } from '../perfil.ts';
import { diaLocal, diasEntre } from '../dates.ts';
import { type ConfigPuntuacion, type ProveedorProbabilidad, type Puntuacion, puntuar } from '../puntuacion.ts';
import type { Convocatoria, Perfil, Reloj } from '../types.ts';
import type { Analisis } from './analisis-esquema.ts';
import type { AnalisisLicitacion } from './analisis-licitacion-esquema.ts';
import { FASE_ANALISIS } from './analisis.ts';

export interface ResumenPuntuacion {
  total: number;
  /** Sin analizar (puntuadas con el encaje desconocido). */
  sinAnalizar: number;
  excluidas: number;
  errores: string[];
}

/** Puntúa una convocatoria en juego con su análisis guardado y el plazo ya leído (con los días desde el reloj de quien llama). */
export function puntuarConvocatoria(
  db: DatabaseSync, c: Convocatoria, plazo: PlazoGuardado | null, importeMinimo: number | null, config: ConfigPuntuacion, probabilidad?: ProveedorProbabilidad,
  hoy?: string,
): Puntuacion {
  const datos = leerFases(db, c.id).find((f) => f.fase === FASE_ANALISIS)?.datos as { analisis?: Analisis | AnalisisLicitacion } | undefined;
  const perfil = c.fuente === 'placsp' ? leerPerfil(db) : null;
  const primera = hoy ? (db.prepare('SELECT primera_vez FROM convocatorias WHERE id = ?').get(c.id) as { primera_vez: string } | undefined)?.primera_vez : undefined;
  return puntuar({
    convocatoria: c, analisis: datos?.analisis ?? null, importeMinimo,
    ...(perfil ? { escalaLicitaciones: { presupuestoMaximo: presupuestoMaximoLicitacion(perfil), ingresosAnuales: ingresosAnuales(perfil) } } : {}),
    diasDesdePrimeraVez: hoy && primera ? diasEntre(diaLocal(new Date(primera)), hoy) : null,
    plazo: plazo && { fechaCierre: plazo.fechaCierre, tipo: plazo.tipo, diasHastaCierre: plazo.diasHastaCierre },
  }, config, probabilidad);
}

export function puntuarCandidatas(
  db: DatabaseSync, reloj: Reloj, perfil: Perfil, config: ConfigPuntuacion, probabilidad?: ProveedorProbabilidad,
): ResumenPuntuacion {
  const hoy = diaLocal(reloj.now());
  const r: ResumenPuntuacion = { total: 0, sinAnalizar: 0, excluidas: 0, errores: [] };
  for (const c of enJuegoTodas(db)) {
    try {
      const p = puntuarConvocatoria(db, c, leerPlazo(db, c.id, hoy), perfil.importeMinimo, config, probabilidad, hoy);
      guardarPuntuacion(db, c.id, p, reloj.now());
      r.total++;
      if (!p.analizada) r.sinAnalizar++;
      if (p.excluida) r.excluidas++;
    } catch (e) {
      r.errores.push(`Puntuación ${c.id}: ${(e as Error).message}`);
    }
  }
  borrarPuntuacionesFueraDeJuego(db);
  return r;
}
