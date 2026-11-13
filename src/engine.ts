// Motor del radar. Todo lo que toca el exterior entra por `DependenciasMotor`: es el punto de prueba.
// Fases futuras (criba LLM, análisis, puntuación) se enganchan después de `recoger`, sobre las candidatas;
// el envío del correo será otra operación de este módulo con su propio emisor inyectado.
import type { DatabaseSync } from 'node:sqlite';
import {
  type ContadoresFuente, empezarEjecucion, empezarFuente, guardarConvocatoria, leerPerfil, terminarEjecucion,
  terminarFuente, transaccion,
} from './db/repo.ts';
import { cribar } from './rules.ts';
import { bdns } from './sources/bdns.ts';
import type { Fuente } from './sources/source.ts';
import type { Reloj } from './types.ts';

export interface DependenciasMotor {
  db: DatabaseSync;
  fetch: typeof globalThis.fetch;
  reloj: Reloj;
  /** Fuentes a recorrer; por defecto todas las del radar. */
  fuentes?: Fuente[];
  log?: (mensaje: string) => void;
}

export const FUENTES: Fuente[] = [bdns];

export interface ResumenFuente extends ContadoresFuente {
  fuente: string;
  errores: string[];
}

export interface ResumenEjecucion {
  ejecucionId: number;
  conErrores: boolean;
  fuentes: ResumenFuente[];
}

export async function ejecutarRadar(deps: DependenciasMotor, opciones: { diasAtras?: number } = {}): Promise<ResumenEjecucion> {
  const { db, reloj } = deps;
  const log = deps.log ?? (() => {});
  const perfil = leerPerfil(db);
  if (!perfil) throw new Error('La BD no tiene perfil: carga la semilla antes (npm run seed)');

  const ejecucionId = empezarEjecucion(db, reloj.now());
  const resumen: ResumenFuente[] = [];

  for (const fuente of deps.fuentes ?? FUENTES) {
    empezarFuente(db, ejecucionId, fuente.nombre, reloj.now());
    const n: ContadoresFuente = { recibidas: 0, nuevas: 0, candidatas: 0, descartadas: 0 };
    let errores: string[] = [];
    try {
      const r = await fuente.recoger({
        fetch: deps.fetch,
        ahora: reloj.now(),
        perfil,
        diasAtras: opciones.diasAtras ?? 7,
        cribar: (c) => cribar(c, perfil),
      });
      errores = r.errores;
      transaccion(db, () => {
        for (const cribada of r.cribadas) {
          n.recibidas++;
          if (guardarConvocatoria(db, cribada, reloj.now())) n.nuevas++;
          if (cribada.descarte) n.descartadas++;
          else n.candidatas++;
        }
      });
    } catch (e) {
      errores = [...errores, `Fallo de la fuente: ${(e as Error).message}`];
    }
    terminarFuente(db, ejecucionId, fuente.nombre, reloj.now(), n, errores);
    resumen.push({ fuente: fuente.nombre, ...n, errores });
    log(`${fuente.nombre}: ${n.recibidas} recibidas, ${n.nuevas} nuevas, ${n.candidatas} candidatas, ${n.descartadas} descartadas, ${errores.length} errores`);
    for (const e of errores) log(`  ! ${e}`);
  }

  const conErrores = resumen.some((f) => f.errores.length > 0);
  terminarEjecucion(db, ejecucionId, reloj.now(), conErrores);
  return { ejecucionId, conErrores, fuentes: resumen };
}
