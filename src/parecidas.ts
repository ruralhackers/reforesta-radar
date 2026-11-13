// "Las ganan organizaciones como vosotros": qué parecidas activas están detrás de una convocatoria. Dos pistas, que se unen por NIF:
//   · origen: la descubrió el radar porque una parecida ganó una edición anterior (etiqueta de origen "parecidas");
//   · ganadores previos: entre los ganadores de sus ediciones anteriores (o de ella misma, si ya se resolvió) figura una parecida activa.
// Devuelve null si ninguna parecida activa tiene que ver con ella.
import type { DatabaseSync } from 'node:sqlite';
import { origenesDe } from './db/ganadores.ts';
import { ganadoresPrevios, resumirHistorial } from './ganadores.ts';
import type { Convocatoria, Perfil } from './types.ts';

export interface InfoParecidas {
  /** La descubrió el radar por una parecida (origen "parecidas"). */
  descubierta: boolean;
  /** Parecidas activas relacionadas, la edición más reciente primero. */
  organizaciones: { nif: string; nombre: string; anios: number[] }[];
}

export function infoParecidas(db: DatabaseSync, c: Convocatoria, perfil: Perfil | null): InfoParecidas | null {
  const origenes = origenesDe(db, c.id);
  const porNif = new Map<string, { nif: string; nombre: string; anios: number[] }>();
  const sumar = (nif: string, nombre: string, anios: (number | null)[]) => {
    const o = porNif.get(nif) ?? { nif, nombre, anios: [] };
    for (const a of anios) if (a !== null && !o.anios.includes(a)) o.anios.push(a);
    porNif.set(nif, o);
  };
  for (const o of origenes) sumar(o.nif, o.nombre, [o.anioPrevio]);
  if (perfil) for (const p of resumirHistorial(db, ganadoresPrevios(db, c, perfil)).parecidas) sumar(p.nif, p.nombre, p.anios);
  if (porNif.size === 0) return null;
  const organizaciones = [...porNif.values()].map((o) => ({ ...o, anios: o.anios.sort((a, b) => b - a) }))
    .sort((a, b) => (b.anios[0] ?? 0) - (a.anios[0] ?? 0) || a.nombre.localeCompare(b.nombre));
  return { descubierta: origenes.length > 0, organizaciones };
}
