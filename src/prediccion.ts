// Predicción de apertura de la próxima edición de una serie (sin LLM, función pura sobre fechas ya guardadas).
// Con menos de dos ediciones pasadas con fecha de apertura NO se predice nada. El resultado es una ventana ("suele abrir entre mediados de
// mayo y principios de junio"), nunca una fecha: son solo hábitos pasados.
import { diasEntre, sumarDias } from './dates.ts';

/** Una edición pasada de la que se sabe cuándo abrió. */
export interface AperturaPasada {
  numero: string;
  anio: number;
  /** YYYY-MM-DD: inicio de solicitudes si BDNS lo da; si no, la publicación (registro en BDNS). */
  apertura: string;
  /** YYYY-MM-DD o null: cierre de solicitudes (literal o calculado). */
  cierre: string | null;
}

export interface PrediccionApertura {
  /** Ediciones en las que se basa, por año. */
  basadaEn: { numero: string; anio: number; apertura: string }[];
  /** Día del año (1-365, calendario sin bisiesto) en que empieza la ventana. */
  desdeDia: number;
  /** Día del año en que termina; menor que `desdeDia` si la ventana cruza el fin de año. */
  hastaDia: number;
  /** Duración típica del plazo de solicitud (mediana de las ediciones con cierre conocido), en días; null si ninguna lo tiene. */
  duracionDias: number | null;
  /** "suele abrir entre mediados de mayo y principios de junio". */
  texto: string;
}

const ACUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const DIAS_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Día del año en un calendario de 365 días (el 29 de febrero cuenta como el 28). */
export function diaDelAnio(dia: string): number {
  const m = Number(dia.slice(5, 7));
  const d = Math.min(Number(dia.slice(8, 10)), DIAS_MES[m - 1]);
  return ACUM[m - 1] + d;
}

function mesYDia(doy: number): { mes: number; dia: number } {
  let m = 11;
  while (ACUM[m] >= doy) m--;
  return { mes: m, dia: doy - ACUM[m] };
}

/** YYYY-MM-DD de un día del año en `anio` (calendario de 365 días). */
export function fechaDeDia(anio: number, doy: number): string {
  const { mes, dia } = mesYDia(doy);
  return `${anio}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function tercio(doy: number): string {
  const { mes, dia } = mesYDia(doy);
  return `${dia <= 10 ? 'principios' : dia <= 20 ? 'mediados' : 'finales'} de ${MESES[mes]}`;
}

/** "suele abrir entre mediados de mayo y principios de junio" / "suele abrir a mediados de mayo". */
export function describirVentana(desdeDia: number, hastaDia: number): string {
  const a = tercio(desdeDia);
  const b = tercio(hastaDia);
  return a === b ? `suele abrir a ${a}` : `suele abrir entre ${a} y ${b}`;
}

const mediana = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const medianaRedondeada = (xs: number[]): number | null => (xs.length ? Math.round(mediana(xs)) : null);

/**
 * Ventana de apertura a partir de las aperturas pasadas. Es el arco más corto del año (circular) que contiene todos los días de apertura,
 * así que una serie que abre entre diciembre y enero da "de diciembre a enero" y no "todo el año". null con menos de 2 ediciones.
 * Una edición por año: si hay dos del mismo año con el mismo número se cuenta una; con años repetidos, la primera (por número).
 */
export function predecirApertura(pasadas: AperturaPasada[]): PrediccionApertura | null {
  const porAnio = new Map<number, AperturaPasada>();
  for (const e of [...pasadas].sort((a, b) => a.numero.localeCompare(b.numero))) if (!porAnio.has(e.anio)) porAnio.set(e.anio, e);
  const base = [...porAnio.values()].sort((a, b) => a.anio - b.anio);
  if (base.length < 2) return null;
  const dias = [...new Set(base.map((e) => diaDelAnio(e.apertura)))].sort((a, b) => a - b);
  let k = dias.length - 1; // hueco circular más grande entre aperturas consecutivas; el arco empieza justo después
  let mejor = dias[0] + 365 - dias[k];
  for (let i = 0; i < dias.length - 1; i++) if (dias[i + 1] - dias[i] > mejor) { mejor = dias[i + 1] - dias[i]; k = i; }
  const desdeDia = dias[(k + 1) % dias.length];
  const hastaDia = dias[k];
  const duraciones = base.flatMap((e) => (e.cierre && diasEntre(e.apertura, e.cierre) >= 0 ? [diasEntre(e.apertura, e.cierre)] : []));
  return {
    basadaEn: base.map((e) => ({ numero: e.numero, anio: e.anio, apertura: e.apertura })),
    desdeDia, hastaDia, duracionDias: medianaRedondeada(duraciones), texto: describirVentana(desdeDia, hastaDia),
  };
}

/** Fechas concretas de la ventana para el año `anio` (la que empieza en ese año; si cruza el fin de año, termina en el siguiente). */
export function ventanaEnAnio(p: Pick<PrediccionApertura, 'desdeDia' | 'hastaDia'>, anio: number): { desde: string; hasta: string } {
  const desde = fechaDeDia(anio, p.desdeDia);
  return { desde, hasta: sumarDias(desde, (p.hastaDia - p.desdeDia + 365) % 365) };
}

export type EstadoApertura = 'pronto' | 'retrasada' | 'lejos';

/**
 * Estado de la ventana de este año respecto a `hoy`: `pronto` si ya está dentro o empieza en `dias` días o menos; `retrasada` si ya terminó
 * (y la edición de este año no ha aparecido: puede retrasarse o haberse suprimido); `lejos` si empieza más tarde.
 */
export function estadoApertura(p: Pick<PrediccionApertura, 'desdeDia' | 'hastaDia'>, hoy: string, dias: number): { estado: EstadoApertura; desde: string; hasta: string } {
  const v = ventanaEnAnio(p, Number(hoy.slice(0, 4)));
  if (hoy > v.hasta) return { estado: 'retrasada', ...v };
  return { estado: v.desde <= sumarDias(hoy, dias) ? 'pronto' : 'lejos', ...v };
}
