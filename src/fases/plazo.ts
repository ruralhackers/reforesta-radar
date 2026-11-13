// Fase `plazo` (determinista, sin LLM): fecha de cierre de cada candidata en juego. Se recalcula entera en cada
// ejecución (es barata y el análisis puede llegar después con el texto del plazo); el resultado vive en la tabla `plazos`.
import type { DatabaseSync } from 'node:sqlite';
import { enJuegoTodas, guardarPlazo, leerFases } from '../db/repo.ts';
import { calendario, type TablaFestivos } from '../festivos.ts';
import { calcularPlazo } from '../plazos.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import type { Perfil, Reloj } from '../types.ts';
import type { Analisis } from './analisis-esquema.ts';

export interface ResumenPlazos {
  total: number;
  literales: number;
  calculadas: number;
  desconocidas: number;
  errores: string[];
}

export function calcularPlazos(
  db: DatabaseSync, reloj: Reloj, perfil: Perfil, festivos: TablaFestivos, fuentes?: Fuente[],
): ResumenPlazos {
  const cal = calendario(festivos, perfil.ambito.regiones);
  const r: ResumenPlazos = { total: 0, literales: 0, calculadas: 0, desconocidas: 0, errores: [] };
  for (const c of enJuegoTodas(db)) {
    const fuente = fuentePorNombre(c.fuente, fuentes);
    if (!fuente?.datosPlazo) continue;
    try {
      const analisis = leerFases(db, c.id).find((f) => f.fase === 'analisis')?.datos as { analisis?: Analisis } | undefined;
      const textoAnalisis = analisis?.analisis?.plazo?.valor ?? null;
      const plazo = calcularPlazo(fuente.datosPlazo(c), textoAnalisis, cal);
      guardarPlazo(db, c.id, plazo, reloj.now());
      r.total++;
      if (plazo.tipo === 'literal') r.literales++;
      else if (plazo.tipo === 'calculada') r.calculadas++;
      else r.desconocidas++;
    } catch (e) {
      r.errores.push(`Plazo ${c.id}: ${(e as Error).message}`);
    }
  }
  return r;
}
