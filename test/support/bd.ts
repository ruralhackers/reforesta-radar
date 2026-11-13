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
