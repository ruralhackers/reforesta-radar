// BD en memoria con la semilla del repo ya cargada.
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { abrirBd } from '../../src/db/schema.ts';
import { sembrarSiVacia } from '../../src/seed.ts';

export const RUTA_SEMILLA = join(import.meta.dirname, '..', '..', 'seed', 'perfil.json');

export const RUTA_FESTIVOS = join(import.meta.dirname, '..', '..', 'seed', 'festivos.json');

export const RUTA_PUNTUACION = join(import.meta.dirname, '..', '..', 'seed', 'puntuacion.json');

/** BD con la semilla cargada. Las fundaciones vigiladas de la semilla se desactivan (los tests no hacen red hacia ellas); los tests de fundaciones añaden las suyas. */
export function bdSembrada(): DatabaseSync {
  const db = abrirBd(':memory:');
  sembrarSiVacia(db, RUTA_SEMILLA, new Date('2026-01-01T00:00:00Z'));
  db.exec('UPDATE fundaciones SET activa = 0');
  return db;
}

/** Reloj fijo que se puede adelantar. */
export function relojFijo(inicio: Date) {
  let t = inicio.getTime();
  return { now: () => new Date(t), adelantar: (ms: number) => { t += ms; } };
}

/**
 * BD sembrada con Extremadura como territorio PARCIAL (solo Cáceres): su convocatoria 923229 no se descarta por regla y queda condicionada
 * a la criba LLM ("¿admite proyectos en Cáceres?"), como una Castilla y León sin provincias declaradas con el perfil real.
 */
export function bdSembradaConExtremaduraParcial(): DatabaseSync {
  const db = bdSembrada();
  const p = JSON.parse((db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string }).datos);
  p.ambito.territorios.push({ comunidad: 'Extremadura', provincias: ['Cáceres'] });
  db.prepare('UPDATE perfil SET datos = ? WHERE id = 1').run(JSON.stringify(p));
  return db;
}

/**
 * Da por pasada la criba LLM a toda candidata que aún no tiene veredicto (los tests sin LLM que miran el ranking: "Esta semana" y el correo solo
 * ponen las que ya pasaron la criba; ver CRIBADA en src/db/repo.ts).
 */
export function darPorCribadas(db: DatabaseSync, ahora: Date = new Date('2026-01-01T00:00:00Z')): void {
  db.prepare(`INSERT OR IGNORE INTO convocatoria_fases (convocatoria_id, fase, descarta, motivo, datos, actualizado_en)
    SELECT id, 'criba_llm', 0, 'test', '{}', ? FROM convocatorias WHERE descarte_regla IS NULL`).run(ahora.toISOString());
}
