// Zona geográfica de la organización: comparación de comunidades autónomas y provincias entre las grafías del perfil, del registro de huella
// del MITECO ("Madrid, Comunidad de") y del BOE. Sin nada propio de una entidad: todo sale del perfil.
import type { Perfil } from './types.ts';

export const sinAcentos = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const PALABRAS_VACIAS = new Set(['comunidad', 'comunitat', 'de', 'del', 'la', 'el', 'y', 'i', 'region', 'principado', 'foral', 'autonoma', 'illes', 'islas', 'ciutat']);
/** Grafías distintas de la misma comunidad entre el registro y el perfil ("Balears, Illes" / "ILLES BALEARS", "Euskadi" / "País Vasco"). */
const ALIAS_ZONA: [RegExp, string][] = [[/\bbalears\b/, 'baleares'], [/\beuskadi\b/, 'pais vasco'], [/\bvalenciana\b/, 'valencia'], [/\bcatalunya\b/, 'cataluna'], [/\bgaliza\b/, 'galicia'], [/\bnafarroa\b/, 'navarra'], [/\bcanarias\b/, 'canarias']];
export const palabrasZona = (s: string) => ALIAS_ZONA.reduce((t, [re, por]) => t.replace(re, por), sinAcentos(s)).split(' ').filter((p) => p && !PALABRAS_VACIAS.has(p)).sort().join(' ');

/** Comunidades autónomas de la zona de la organización, tal como las escribe el registro del MITECO ("Madrid, Comunidad de") y el perfil ("COMUNIDAD DE MADRID"): se comparan sin acentos ni palabras vacías. */
export type Zona = string[];
export const zonaDePerfil = (perfil: Perfil): Zona => perfil.ambito.comunidades.map(palabrasZona).filter(Boolean);
export const enZona = (ccaa: string, zona: Zona) => zona.includes(palabrasZona(ccaa));

/**
 * Posición de un lugar (comunidad o provincia, como lo escriba la fuente) entre los territorios del perfil, en el orden del perfil
 * (el primero es el de casa, los siguientes los limítrofes): 0, 1, 2… ; null si está fuera de todos.
 */
export function rangoTerritorio(lugar: string | null | undefined, perfil: Perfil): number | null {
  if (!lugar?.trim()) return null;
  const p = palabrasZona(lugar);
  const i = (perfil.ambito.territorios ?? []).findIndex((t) => palabrasZona(t.comunidad) === p || t.provincias.some((x) => palabrasZona(x) === p));
  return i < 0 ? null : i;
}

/**
 * Como `rangoTerritorio` para un sitio dado por provincia y comunidad (un proyecto del registro): cuenta si la provincia es de un territorio del perfil, o si la comunidad es
 * un territorio entero (sin provincias: Madrid). Una comunidad con solo algunas provincias (Castilla y León con Segovia y Ávila) no vale por la comunidad.
 */
export function rangoLugar(provincia: string | null | undefined, ccaa: string | null | undefined, perfil: Perfil): number | null {
  const porProvincia = rangoTerritorio(provincia, perfil);
  if (porProvincia !== null) return porProvincia;
  const p = palabrasZona(ccaa ?? '');
  if (!p) return null;
  const i = (perfil.ambito.territorios ?? []).findIndex((t) => t.provincias.length === 0 && palabrasZona(t.comunidad) === p);
  return i < 0 ? null : i;
}
