// Puntuación explicable 0-100 de una convocatoria. Función pura y determinista (sin LLM, sin reloj, sin BD):
// recibe lo ya extraído (análisis con citas, plazo) y la configuración de pesos (seed/puntuacion.json) y devuelve
// el total y, por factor, una subpuntuación 0-1 con una explicación de una línea.
//
// Factores: encaje, importe, cierre (días que faltan), esfuerzo (cofinanciación y requisitos) y probabilidad.
// Un dato desconocido nunca cuenta como bueno: el factor vale su `valorDesconocido` (configurable) y la
// explicación empieza por "desconocido/a". La probabilidad es enchufable (`ProveedorProbabilidad`).
// Quedan fuera del ranking (`excluida`) las que no admiten entidades sin ánimo de lucro, las ya cerradas y las de plazo desconocido vistas
// por primera vez hace más de `diasMaximosSinPlazo` días (60 por defecto).
import { readFileSync } from 'node:fs';
import type { Analisis } from './fases/analisis-esquema.ts';
import type { Convocatoria } from './types.ts';

export const DIAS_MAXIMOS_SIN_PLAZO = 60;

export const FACTORES = ['encaje', 'importe', 'cierre', 'esfuerzo', 'probabilidad'] as const;
export type IdFactor = (typeof FACTORES)[number];

export interface ConfigPuntuacion {
  pesos: Record<IdFactor, number>;
  nuevasDias: number;
  cierranProntoDias: number;
  encaje: { porLineas: number[]; esflDesconocido: number; valorDesconocido: number };
  importe: { techo: number; minimoSiPerfilNoTiene: number; pesoSoloTotal: number; valorDesconocido: number };
  cierre: { tramos: { hastaDias: number | null; valor: number }[]; valorDesconocido: number };
  esfuerzo: { cofinanciacionMaxima: number; requisitosSinPenalizar: number; penalizacionPorRequisito: number; suelo: number; valorDesconocido: number };
  probabilidad: { valorDesconocido: number };
  /**
   * Programas de la UE que solo permiten ir como socia de un consorcio (p. ej. Horizon Europe). Sin esta sección no hay tratamiento especial.
   * Prefijo = primer tramo del identificador del topic (HORIZON en HORIZON-CL6-2027-...).
   */
  consorcio?: { prefijosPrograma: string[]; esfuerzoMultiplicador: number };
  /**
   * Sin fecha de cierre conocida, una convocatoria deja de entrar en el ranking (y en el correo) pasados estos días desde que se vio por
   * primera vez: si nadie ha sabido fijar el plazo en dos meses, lo más probable es que ya esté cerrada. Por defecto 60.
   */
  diasMaximosSinPlazo?: number;
}

export function leerConfigPuntuacion(ruta: string): ConfigPuntuacion {
  const c = JSON.parse(readFileSync(ruta, 'utf8')) as ConfigPuntuacion;
  let suma = 0;
  for (const f of FACTORES) {
    const p = c?.pesos?.[f];
    if (typeof p !== 'number' || !(p >= 0)) throw new Error(`Configuración de puntuación: falta un peso válido para "${f}" (${ruta})`);
    suma += p;
    if (!c[f] || typeof c[f] !== 'object') throw new Error(`Configuración de puntuación: falta la sección "${f}" (${ruta})`);
  }
  if (suma <= 0) throw new Error(`Configuración de puntuación: los pesos suman 0 (${ruta})`);
  if (!(c.cierranProntoDias >= 0) || !(c.nuevasDias >= 0)) throw new Error(`Configuración de puntuación: nuevasDias/cierranProntoDias inválidos (${ruta})`);
  return c;
}

/** true si es un programa de la UE de los que se enumeran en `consorcio.prefijosPrograma` (la regla es de datos, no de código). */
export function esConsorcio(c: Convocatoria, cfg: Pick<ConfigPuntuacion, 'consorcio'>): boolean {
  const prefijos = cfg.consorcio?.prefijosPrograma ?? [];
  return c.fuente === 'eu_ft' && prefijos.some((x) => x.toUpperCase() === c.fuenteId.split('-')[0].toUpperCase());
}

/** Lo que se sabe de la convocatoria en el momento de puntuar. */
export interface EntradaPuntuacion {
  convocatoria: Convocatoria;
  /** null = aún sin analizar. */
  analisis: Analisis | null;
  plazo: { fechaCierre: string | null; tipo: 'literal' | 'calculada' | 'desconocida'; diasHastaCierre: number | null } | null;
  /** Importe mínimo del perfil, en euros. */
  importeMinimo: number | null;
  /** Días desde que el radar la vio por primera vez (null/ausente = no se sabe; no excluye). */
  diasDesdePrimeraVez?: number | null;
}

export interface Factor {
  id: IdFactor;
  nombre: string;
  /** Peso relativo (de la configuración). */
  peso: number;
  /** 0-1. */
  subpuntuacion: number;
  /** false = faltaba el dato y se usó el valor por desconocido. */
  conocido: boolean;
  /** Una línea. */
  explicacion: string;
}

export interface Puntuacion {
  /** 0-100 entero; 0 si está excluida. */
  total: number;
  /** Motivo por el que no entra en el ranking (no admite ESFL, cerrada); null = entra. */
  excluida: string | null;
  analizada: boolean;
  factores: Factor[];
  /** Programa UE de consorcio (ver `esConsorcio`): sale del ranking principal y su esfuerzo está penalizado. */
  consorcio?: boolean;
}

/** Resultado de un proveedor de probabilidad: `valor` null = sin datos. */
export type ProveedorProbabilidad = (e: EntradaPuntuacion) => { valor: number | null; explicacion: string };

/** Hasta que haya ganadoras parecidas e historial propio (Task 5), no hay datos. */
export const probabilidadSinDatos: ProveedorProbabilidad = () => ({
  valor: null,
  explicacion: 'desconocida: aún no hay ganadoras parecidas ni historial de Reforesta con esta convocatoria',
});

const NOMBRES: Record<IdFactor, string> = {
  encaje: 'Encaje', importe: 'Importe', cierre: 'Tiempo hasta el cierre', esfuerzo: 'Esfuerzo', probabilidad: 'Probabilidad',
};

const limitar = (x: number) => Math.min(1, Math.max(0, x));
const redondear = (x: number) => Math.round(x * 100) / 100;
const euros = (n: number) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;

/**
 * Primer importe en euros de un texto ("17.389.322,52 €", "hasta 60.000 euros", "1,5 millones de euros"); si hay
 * varias cifras, la mayor. null si no hay ninguna.
 */
export function parsearImporte(texto: string | null): number | null {
  if (!texto) return null;
  const encontrados: number[] = [];
  for (const m of texto.matchAll(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(\s*(?:millones|millón|mil\b))?/gi)) {
    let n = Number(m[1].replace(/\./g, '') + (m[2] ? `.${m[2]}` : ''));
    const mult = m[3]?.trim().toLowerCase();
    if (mult) n *= mult === 'mil' ? 1000 : 1_000_000;
    if (Number.isFinite(n)) encontrados.push(n);
  }
  return encontrados.length ? Math.max(...encontrados) : null;
}

/** Porcentaje de cofinanciación de un texto; 0 si dice que no se exige; null si no se entiende. */
export function parsearCofinanciacion(texto: string | null): number | null {
  if (!texto) return null;
  const p = /(\d+(?:[.,]\d+)?)\s*(?:%|por ?ciento)/i.exec(texto);
  if (p) return Number(p[1].replace(',', '.'));
  if (/\b(?:sin|no\s+(?:se\s+)?(?:exige|requiere|existe|hay))\b/i.test(texto)) return 0;
  return null;
}

type Parcial = Omit<Factor, 'id' | 'nombre' | 'peso'>;

function encaje(e: EntradaPuntuacion, c: ConfigPuntuacion['encaje']): Parcial {
  const a = e.analisis;
  if (!a) return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: 'desconocido: la convocatoria aún no se ha analizado' };
  const n = a.lineas.length;
  const base = c.porLineas[Math.min(n, c.porLineas.length - 1)] ?? 0;
  const lineas = n === 0 ? 'no encaja con ninguna línea de Reforesta' : `encaja con ${n === 1 ? 'la línea' : `${n} líneas`}: ${a.lineas.map((l) => l.linea).join(', ')}`;
  if (a.elegibilidadEsfl.valor === 'si') return { subpuntuacion: redondear(base), conocido: true, explicacion: `${lineas}; admite entidades sin ánimo de lucro` };
  return {
    subpuntuacion: redondear(base * c.esflDesconocido), conocido: false,
    explicacion: `${lineas}; desconocido si admite entidades sin ánimo de lucro (se resta un ${Math.round((1 - c.esflDesconocido) * 100)} %)`,
  };
}

function importe(e: EntradaPuntuacion, c: ConfigPuntuacion['importe']): Parcial {
  const a = e.analisis;
  const maximo = parsearImporte(a?.importeMaximoProyecto.valor ?? null);
  const total = parsearImporte(a?.importeTotal.valor ?? null);
  const cifra = maximo ?? total;
  if (cifra === null) {
    return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: `desconocido: ${a ? 'ni el importe por proyecto ni el total constan' : 'sin analizar'}` };
  }
  const minimo = e.importeMinimo ?? c.minimoSiPerfilNoTiene;
  const que = maximo !== null ? `máximo por proyecto ${euros(maximo)}` : `solo consta el importe total (${euros(total!)})`;
  if (cifra < minimo) return { subpuntuacion: 0, conocido: true, explicacion: `${que}, por debajo del mínimo que merece el esfuerzo (${euros(minimo)})` };
  const techo = Math.max(c.techo, minimo * 2);
  let s = 0.3 + 0.7 * limitar(Math.log(cifra / minimo) / Math.log(techo / minimo));
  if (maximo === null) s *= c.pesoSoloTotal;
  return { subpuntuacion: redondear(s), conocido: true, explicacion: maximo !== null ? que : `${que}; no dice cuánto se da por proyecto` };
}

function cierre(e: EntradaPuntuacion, c: ConfigPuntuacion['cierre']): Parcial {
  const dias = e.plazo?.diasHastaCierre ?? null;
  if (dias === null) {
    return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: `desconocido: ${e.plazo ? 'no se ha podido fijar la fecha de cierre' : 'sin plazo calculado'}` };
  }
  const tramo = c.tramos.find((t) => t.hastaDias === null || dias <= t.hastaDias);
  const nota = e.plazo?.tipo === 'calculada' ? ' (fecha calculada)' : '';
  const cuando = dias === 0 ? 'cierra hoy' : dias === 1 ? 'cierra mañana' : `faltan ${dias} días`;
  const valor = tramo?.valor ?? 0;
  const juicio = valor < 0.5 ? 'poco tiempo para preparar la solicitud'
    : tramo?.hastaDias === null ? 'plazo lejano, sin prisa'
    : valor < 1 ? 'tiempo justo' : 'tiempo de sobra';
  return { subpuntuacion: redondear(tramo?.valor ?? 0), conocido: true, explicacion: `${cuando}${nota}: ${juicio}` };
}

function esfuerzo(e: EntradaPuntuacion, c: ConfigPuntuacion['esfuerzo']): Parcial {
  const a = e.analisis;
  if (!a) return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: 'desconocido: sin analizar' };
  const pct = parsearCofinanciacion(a.cofinanciacion.valor);
  const n = a.requisitos.length;
  const partes: string[] = [];
  const subs: number[] = [];
  if (pct === null) partes.push('cofinanciación desconocida');
  else {
    subs.push(limitar(1 - pct / c.cofinanciacionMaxima));
    partes.push(pct === 0 ? 'sin cofinanciación' : `cofinanciación del ${pct} %`);
  }
  if (n === 0) partes.push('requisitos desconocidos (ninguno con cita)');
  else {
    subs.push(Math.max(c.suelo, 1 - Math.max(0, n - c.requisitosSinPenalizar) * c.penalizacionPorRequisito));
    partes.push(`${n} requisito${n === 1 ? '' : 's'}`);
  }
  if (subs.length === 0) return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: `desconocido: ${partes.join('; ')}` };
  const media = subs.reduce((t, x) => t + x, 0) / subs.length;
  // Si falta una de las dos mitades se tira hacia el valor desconocido en vez de darla por buena.
  const s = subs.length === 2 ? media : (media + c.valorDesconocido) / 2;
  return { subpuntuacion: redondear(s), conocido: subs.length === 2, explicacion: partes.join('; ') };
}

/** Puntúa una convocatoria. `probabilidad` es el factor enchufable (por defecto, sin datos). */
export function puntuar(
  entrada: EntradaPuntuacion, config: ConfigPuntuacion, probabilidad: ProveedorProbabilidad = probabilidadSinDatos,
): Puntuacion {
  const p = probabilidad(entrada);
  const parciales: Record<IdFactor, Parcial> = {
    encaje: encaje(entrada, config.encaje),
    importe: importe(entrada, config.importe),
    cierre: cierre(entrada, config.cierre),
    esfuerzo: esfuerzo(entrada, config.esfuerzo),
    probabilidad: p.valor === null
      ? { subpuntuacion: config.probabilidad.valorDesconocido, conocido: false, explicacion: p.explicacion }
      : { subpuntuacion: redondear(limitar(p.valor)), conocido: true, explicacion: p.explicacion },
  };
  const consorcio = esConsorcio(entrada.convocatoria, config);
  if (consorcio) {
    const m = config.consorcio!.esfuerzoMultiplicador;
    const e = parciales.esfuerzo;
    parciales.esfuerzo = {
      ...e, subpuntuacion: redondear(e.subpuntuacion * m),
      explicacion: `como socia de un consorcio (${entrada.convocatoria.organo.nivel2 ?? 'UE'}): coordinación con varios socios y cofinanciación, esfuerzo reducido a ${Math.round(m * 100)} %; ${e.explicacion}`,
    };
  }
  const factores: Factor[] = FACTORES.map((id) => ({ id, nombre: NOMBRES[id], peso: config.pesos[id], ...parciales[id] }));
  const suma = factores.reduce((t, f) => t + f.peso, 0);
  const total = Math.round((factores.reduce((t, f) => t + f.peso * f.subpuntuacion, 0) / suma) * 100);

  let excluida: string | null = null;
  const dias = entrada.plazo?.diasHastaCierre ?? null;
  if (entrada.analisis?.elegibilidadEsfl.valor === 'no') excluida = 'No admite entidades sin ánimo de lucro';
  else if (dias !== null && dias < 0) excluida = `Cerrada desde hace ${-dias} día${dias === -1 ? '' : 's'}`;
  else if (dias === null && (entrada.diasDesdePrimeraVez ?? 0) > (config.diasMaximosSinPlazo ?? DIAS_MAXIMOS_SIN_PLAZO)) {
    excluida = `Plazo desconocido y vista por primera vez hace ${entrada.diasDesdePrimeraVez} días: probablemente ya cerrada`;
  }
  return { total: excluida ? 0 : total, excluida, analizada: entrada.analisis !== null, factores, ...(consorcio ? { consorcio: true } : {}) };
}
