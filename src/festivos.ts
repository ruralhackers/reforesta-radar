// Calendario de días hábiles. Los festivos viven en un fichero de datos (seed/festivos.json), no en el código:
// "nacional" (las fiestas de todas las comunidades) y, por código de región NUTS, las propias de cada una.
// Se aplican las nacionales y las de las regiones del perfil (`perfil.ambito.regiones`).
import { readFileSync } from 'node:fs';
import { diaDeLaSemana } from './dates.ts';

export interface Festivo {
  dia: string;
  nombre: string;
}

export interface TablaFestivos {
  nacional: Record<string, Festivo[]>;
  regiones: Record<string, { nombre?: string } & Record<string, Festivo[] | string | undefined>>;
}

export class SinFestivosDelAnio extends Error {
  anio: string;
  constructor(anio: string) {
    super(`No hay calendario de festivos de ${anio} en el fichero de festivos`);
    this.anio = anio;
  }
}

export function leerFestivos(ruta: string): TablaFestivos {
  const t = JSON.parse(readFileSync(ruta, 'utf8')) as TablaFestivos;
  if (!t?.nacional || typeof t.nacional !== 'object') throw new Error(`Fichero de festivos sin "nacional": ${ruta}`);
  return { nacional: t.nacional, regiones: t.regiones ?? {} };
}

/** Años cubiertos por el calendario nacional. */
export function aniosCubiertos(t: TablaFestivos): string[] {
  return Object.keys(t.nacional).sort();
}

/**
 * Conjunto de festivos aplicable: los nacionales más los de las regiones que están en `regiones` (códigos NUTS del
 * perfil, p. ej. ["ES3", "ES30", "ES300"]; una tabla regional se aplica si su código está en la lista).
 */
export function calendario(t: TablaFestivos, regiones: string[]): { festivo(dia: string): string | null } {
  const porDia = new Map<string, string>();
  const anios = new Set(aniosCubiertos(t));
  for (const lista of Object.values(t.nacional)) for (const f of lista) porDia.set(f.dia, f.nombre);
  for (const [codigo, tabla] of Object.entries(t.regiones)) {
    if (!regiones.includes(codigo)) continue;
    for (const lista of Object.values(tabla)) {
      if (Array.isArray(lista)) for (const f of lista) if (!porDia.has(f.dia)) porDia.set(f.dia, f.nombre);
    }
  }
  return {
    /** Nombre del festivo, o null si no lo es. Lanza `SinFestivosDelAnio` si el año no está en el calendario. */
    festivo(dia: string): string | null {
      const anio = dia.slice(0, 4);
      if (!anios.has(anio)) throw new SinFestivosDelAnio(anio);
      return porDia.get(dia) ?? null;
    },
  };
}

/** Día hábil: ni sábado, ni domingo, ni festivo (art. 30.2 de la Ley 39/2015). */
export function esHabil(cal: ReturnType<typeof calendario>, dia: string): boolean {
  const dow = diaDeLaSemana(dia);
  return dow !== 0 && dow !== 6 && cal.festivo(dia) === null;
}
