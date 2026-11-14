// Carga la semilla (perfil + organizaciones parecidas + fundaciones) en una BD vacía.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { guardarSemilla, leerPerfil } from './db/repo.ts';
import { migrarAmbito, migrarDomicilio } from './perfil.ts';
import type { Semilla } from './types.ts';

export function leerSemilla(ruta: string): Semilla {
  const s = JSON.parse(readFileSync(ruta, 'utf8')) as Semilla;
  if (!s?.perfil?.nombre || !s.perfil.ambito || !Array.isArray(s.organizacionesParecidas) || !Array.isArray(s.fundaciones)) {
    throw new Error(`Semilla incompleta en ${ruta}: hacen falta perfil (con nombre y ámbito), organizacionesParecidas y fundaciones`);
  }
  return s;
}

/**
 * Si la BD no tiene perfil, carga la semilla. Devuelve true si la cargó. Nunca pisa un perfil existente, salvo para añadirle campos nuevos
 * que le falten con los valores de la semilla (el ámbito de actuación y el domicilio social: ver `migrarAmbito` y `migrarDomicilio`).
 */
export function sembrarSiVacia(db: DatabaseSync, rutaSemilla: string, ahora: Date): boolean {
  if (leerPerfil(db)) {
    const semilla = leerSemilla(rutaSemilla).perfil;
    migrarAmbito(db, semilla, ahora);
    migrarDomicilio(db, semilla, ahora);
    return false;
  }
  guardarSemilla(db, leerSemilla(rutaSemilla), ahora);
  return true;
}
