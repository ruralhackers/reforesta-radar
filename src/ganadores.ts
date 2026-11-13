// Lo que se sabe de quién ganó antes una convocatoria: sus propias concesiones (si ya se resolvió) y las de las ediciones
// anteriores de su serie (mismo órgano, mismo título salvo el año). Es lo que usan la ficha, la probabilidad y el análisis.
// BDNS solo publica a los ganadores: nunca sabemos a quién se denegó, así que "no figura entre los ganadores" no es "perdió".
import type { DatabaseSync } from 'node:sqlite';
import { anioEdicion, claveSerie } from './concesiones.ts';
import { concesionesDe, edicionesDeSerie, leerParecidas } from './db/ganadores.ts';
import { leerPerfil } from './db/repo.ts';
import type { ProveedorProbabilidad } from './puntuacion.ts';
import type { Convocatoria, Perfil } from './types.ts';

const FICHA = 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/';

export interface GanadorPrevio {
  nombre: string;
  nif: string | null;
  importe: number | null;
  fechaConcesion: string | null;
  esReforesta: boolean;
  esParecida: boolean;
}

export interface EdicionPrevia {
  numeroConvocatoria: string;
  anio: number | null;
  titulo: string;
  url: string;
  /** true = es esta misma convocatoria (ya resuelta). */
  propia: boolean;
  ganadores: GanadorPrevio[];
  importeTotal: number;
  /** gano = figura entre los ganadores; no_figura = hay ganadores y no está; sin_datos = BDNS aún no publica concesiones. */
  reforesta: 'gano' | 'no_figura' | 'sin_datos';
  importeReforesta: number | null;
}

export interface GanadoresPrevios {
  /** El título permite enlazarla con otras ediciones (no es demasiado genérico). */
  esSerie: boolean;
  /** Más recientes primero; la propia, si ya tiene concesiones, la primera. */
  ediciones: EdicionPrevia[];
}

export function ganadoresPrevios(db: DatabaseSync, c: Convocatoria, perfil: Perfil): GanadoresPrevios {
  const serie = claveSerie(c.titulo, c.organo);
  const anioPropio = anioEdicion(c.titulo, c.fechaPublicacion);
  const parecidas = new Set(leerParecidas(db, true).map((p) => p.nif));
  const construir = (numero: string, titulo: string, anio: number | null, propia: boolean): EdicionPrevia => {
    const ganadores: GanadorPrevio[] = concesionesDe(db, numero).map((g) => ({
      nombre: g.nombre, nif: g.nif, importe: g.importe, fechaConcesion: g.fechaConcesion,
      esReforesta: g.nif !== null && g.nif === perfil.nif, esParecida: g.nif !== null && parecidas.has(g.nif),
    }));
    const mia = ganadores.filter((g) => g.esReforesta);
    return {
      numeroConvocatoria: numero, anio, titulo, url: FICHA + numero, propia, ganadores,
      importeTotal: Math.round(ganadores.reduce((s, g) => s + (g.importe ?? 0), 0) * 100) / 100,
      reforesta: mia.length > 0 ? 'gano' : ganadores.length > 0 ? 'no_figura' : 'sin_datos',
      importeReforesta: mia.length > 0 ? Math.round(mia.reduce((s, g) => s + (g.importe ?? 0), 0) * 100) / 100 : null,
    };
  };

  const ediciones: EdicionPrevia[] = [];
  const propia = construir(c.fuenteId, c.titulo, anioPropio, true);
  if (propia.ganadores.length > 0) ediciones.push(propia);
  if (serie) {
    for (const e of edicionesDeSerie(db, serie)) {
      if (e.numeroConvocatoria === c.fuenteId) continue;
      if (anioPropio !== null && e.anio !== null && e.anio >= anioPropio) continue; // solo las anteriores
      ediciones.push(construir(e.numeroConvocatoria, e.titulo, e.anio, false));
    }
  }
  return { esSerie: serie !== null, ediciones };
}

const euros = (n: number) => `${new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} €`;

function lista(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

export interface ResumenHistorial {
  /** Ediciones con ganadores conocidos. */
  conDatos: EdicionPrevia[];
  ganadasPorReforesta: EdicionPrevia[];
  /** Organizaciones parecidas que figuran entre los ganadores previos, con los años. */
  parecidas: { nif: string; nombre: string; anios: number[] }[];
}

export function resumirHistorial(db: DatabaseSync, g: GanadoresPrevios): ResumenHistorial {
  const conDatos = g.ediciones.filter((e) => e.ganadores.length > 0);
  const nombres = new Map(leerParecidas(db, true).map((p) => [p.nif, p.nombre]));
  const porNif = new Map<string, number[]>();
  for (const e of conDatos) {
    for (const w of e.ganadores) {
      if (!w.esParecida || !w.nif) continue;
      const anios = porNif.get(w.nif) ?? [];
      if (e.anio !== null && !anios.includes(e.anio)) anios.push(e.anio);
      porNif.set(w.nif, anios);
    }
  }
  return {
    conDatos,
    ganadasPorReforesta: conDatos.filter((e) => e.reforesta === 'gano'),
    parecidas: [...porNif].map(([nif, anios]) => ({ nif, nombre: nombres.get(nif) ?? nif, anios: anios.sort((a, b) => b - a) })),
  };
}

function frasesReforesta(h: ResumenHistorial): string {
  const g = h.ganadasPorReforesta;
  if (g.length === 0) return 'Reforesta no figura entre los ganadores de las ediciones conocidas (BDNS solo publica a los ganadores).';
  const e = (x: EdicionPrevia) => `${x.anio ?? x.numeroConvocatoria}${x.importeReforesta !== null ? ` (${euros(x.importeReforesta)})` : ''}`;
  if (g.length === 1) return `Reforesta ganó la edición ${g[0].anio ?? g[0].numeroConvocatoria}${g[0].importeReforesta !== null ? ` con ${euros(g[0].importeReforesta)}` : ''}.`;
  return `Reforesta ganó las ediciones ${lista(g.map(e))}.`;
}

function frasesParecidas(h: ResumenHistorial): string {
  if (h.parecidas.length === 0) return 'Ninguna organización parecida figura entre los ganadores previos.';
  const orden = [...h.parecidas].sort((a, b) => (b.anios[0] ?? 0) - (a.anios[0] ?? 0) || b.anios.length - a.anios.length);
  const anio = orden[0].anios[0];
  const reciente = orden.filter((p) => p.anios[0] === anio);
  const nombres = reciente.slice(0, 3).map((p) => p.nombre);
  const resto = h.parecidas.length - nombres.length;
  return `La ganaron ${lista(nombres)}${resto > 0 ? ` y ${resto} parecida${resto === 1 ? '' : 's'} más` : ''}${anio !== undefined ? ` (la más reciente, en ${anio})` : ''}.`;
}

/**
 * Probabilidad (0-1) a partir del historial: base 0,4 si hay ganadores previos; +0,06 por cada parecida entre ellos (hasta +0,3);
 * +0,25 si Reforesta ganó alguna edición (+0,05 por cada edición más, hasta +0,1). Máximo 0,95. Sin ganadores conocidos → null.
 */
export function probabilidadDesdeHistorial(h: ResumenHistorial): { valor: number | null; explicacion: string } {
  if (h.conDatos.length === 0) {
    return { valor: null, explicacion: 'desconocida: sin ganadores previos conocidos (BDNS solo recoge concesiones desde 2022 y no hay ediciones anteriores resueltas de esta convocatoria)' };
  }
  const valor = Math.min(0.95, 0.4 + Math.min(0.3, 0.06 * h.parecidas.length)
    + (h.ganadasPorReforesta.length > 0 ? 0.25 + 0.05 * Math.min(2, h.ganadasPorReforesta.length - 1) : 0));
  return { valor: Math.round(valor * 100) / 100, explicacion: `${frasesReforesta(h)} ${frasesParecidas(h)}` };
}

/** Factor "probabilidad" de la puntuación a partir de las concesiones guardadas (Task 5). */
export function crearProbabilidad(db: DatabaseSync): ProveedorProbabilidad {
  return (entrada) => {
    const perfil = leerPerfil(db);
    if (!perfil) return { valor: null, explicacion: 'Sin perfil: no se puede comparar con los ganadores previos' };
    return probabilidadDesdeHistorial(resumirHistorial(db, ganadoresPrevios(db, entrada.convocatoria, perfil)));
  };
}

/**
 * Texto con los ganadores previos para el contexto del análisis; null si no hay ninguno (el prompt queda igual que antes).
 * Solo entidades con nombre (las personas anonimizadas no aportan), hasta 3 ediciones y 12 ganadores por edición.
 */
export function textoGanadoresParaPrompt(db: DatabaseSync, c: Convocatoria, perfil: Perfil): string | null {
  const h = resumirHistorial(db, ganadoresPrevios(db, c, perfil));
  if (h.conDatos.length === 0) return null;
  const lineas = h.conDatos.slice(0, 3).map((e) => {
    const ganadores = e.ganadores.filter((g) => g.nif).slice(0, 12).map((g) => `${g.nombre}${g.importe !== null ? ` (${euros(g.importe)})` : ''}`);
    return `- ${e.anio ?? 'año desconocido'} (convocatoria BDNS ${e.numeroConvocatoria}, ${e.ganadores.length} concesiones): ${ganadores.join('; ')}`;
  });
  return [...lineas, frasesReforesta(h)].join('\n');
}
