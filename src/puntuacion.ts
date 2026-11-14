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
import { type AnalisisLicitacion, esAnalisisLicitacion } from './fases/analisis-licitacion-esquema.ts';
import type { Licitacion } from './sources/placsp.ts';
import type { Convocatoria } from './types.ts';

export const DIAS_MAXIMOS_SIN_PLAZO = 60;

export const FACTORES = ['encaje', 'importe', 'cierre', 'esfuerzo', 'probabilidad'] as const;
/** Factores de una licitación (fuente placsp): encaje, escala frente a la capacidad, plazo de ofertas, viabilidad de la solvencia y peso del precio. */
export const FACTORES_LICITACION = ['encaje', 'escala', 'plazo', 'viabilidad', 'precio'] as const;
export type IdFactor = (typeof FACTORES)[number] | (typeof FACTORES_LICITACION)[number];

/**
 * Pesos y umbrales propios de las licitaciones (sección `licitaciones` de seed/puntuacion.json; sin ella valen los de CONFIG_LICITACIONES_POR_DEFECTO).
 * Tramos de `plazo`: primer tramo cuyo `hastaDias` >= días que faltan; de `precio`: primer tramo cuyo `hastaPuntos` >= puntos (sobre 100) del precio.
 */
export interface ConfigLicitaciones {
  pesos: Record<(typeof FACTORES_LICITACION)[number], number>;
  encaje: { porLineas: number[]; valorDesconocido: number };
  /** Presupuesto base sin IVA: <= `optimo` vale 1; hasta el máximo del perfil baja a `valorEnElMaximo`; por encima del máximo, 0 («probablemente fuera de escala»). */
  escala: { optimo: number; valorEnElMaximo: number; valorMinimo: number; valorDesconocido: number };
  plazo: { tramos: { hastaDias: number | null; valor: number }[]; valorDesconocido: number };
  /** Volumen de negocio exigido / ingresos anuales: <= `holgado` vale 1, <= `justo` vale `valorJusto`, más vale `valorExcesivo`; con clasificación exigida se multiplica por `multiplicadorClasificacion`. */
  viabilidad: { holgado: number; justo: number; valorJusto: number; valorExcesivo: number; multiplicadorClasificacion: number; valorDesconocido: number };
  precio: { tramos: { hastaPuntos: number | null; valor: number }[]; valorDesconocido: number };
}

export const CONFIG_LICITACIONES_POR_DEFECTO: ConfigLicitaciones = {
  pesos: { encaje: 30, escala: 25, plazo: 15, viabilidad: 20, precio: 10 },
  encaje: { porLineas: [0, 0.7, 0.9, 1], valorDesconocido: 0.3 },
  escala: { optimo: 100_000, valorEnElMaximo: 0.3, valorMinimo: 0.2, valorDesconocido: 0.4 },
  plazo: { tramos: [{ hastaDias: 2, valor: 0.1 }, { hastaDias: 5, valor: 0.4 }, { hastaDias: 10, valor: 0.8 }, { hastaDias: null, valor: 1 }], valorDesconocido: 0.4 },
  viabilidad: { holgado: 1, justo: 2, valorJusto: 0.6, valorExcesivo: 0.2, multiplicadorClasificacion: 0.4, valorDesconocido: 0.4 },
  precio: { tramos: [{ hastaPuntos: 30, valor: 1 }, { hastaPuntos: 50, valor: 0.8 }, { hastaPuntos: 70, valor: 0.55 }, { hastaPuntos: null, valor: 0.3 }], valorDesconocido: 0.5 },
};

export interface ConfigPuntuacion {
  pesos: Record<(typeof FACTORES)[number], number>;
  nuevasDias: number;
  cierranProntoDias: number;
  /** Ventana (días) de "Se espera que abran pronto"; por defecto 60. */
  proximasDias?: number;
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
  /** Licitaciones (fuente placsp): pesos y umbrales propios. Ausente = CONFIG_LICITACIONES_POR_DEFECTO. */
  licitaciones?: ConfigLicitaciones;
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
  if (c.proximasDias !== undefined && !(Number.isFinite(c.proximasDias) && c.proximasDias >= 0)) throw new Error(`Configuración de puntuación: proximasDias inválido (${ruta})`);
  if (c.licitaciones !== undefined) {
    const l = c.licitaciones;
    let sumaL = 0;
    for (const f of FACTORES_LICITACION) {
      const p = l?.pesos?.[f];
      if (typeof p !== 'number' || !(p >= 0)) throw new Error(`Configuración de puntuación: falta un peso válido en licitaciones.pesos para "${f}" (${ruta})`);
      sumaL += p;
      if (!l[f] || typeof l[f] !== 'object') throw new Error(`Configuración de puntuación: falta la sección licitaciones.${f} (${ruta})`);
    }
    if (sumaL <= 0) throw new Error(`Configuración de puntuación: los pesos de licitaciones suman 0 (${ruta})`);
  }
  return c;
}

/** true si es un programa de la UE de los que se enumeran en `consorcio.prefijosPrograma` (la regla es de datos, no de código). */
export function esConsorcio(c: Convocatoria, cfg: Pick<ConfigPuntuacion, 'consorcio'>): boolean {
  const prefijos = cfg.consorcio?.prefijosPrograma ?? [];
  return c.fuente === 'eu_ft' && prefijos.some((x) => x.toUpperCase() === c.fuenteId.split('-')[0].toUpperCase());
}

/** true si es un premio (fuente vigilada de tipo "premio"): el importe es la dotación del premio y no hay cofinanciación. */
export const esPremio = (c: Convocatoria): boolean => c.tipo === 'premio';

/** Lo que se sabe de la convocatoria en el momento de puntuar. */
export interface EntradaPuntuacion {
  convocatoria: Convocatoria;
  /** null = aún sin analizar. Para una licitación (fuente placsp), el análisis propio (`AnalisisLicitacion`). */
  analisis: Analisis | AnalisisLicitacion | null;
  /** Solo licitaciones: lo que el perfil dice de la escala de la entidad (presupuesto máximo y volumen anual). */
  escalaLicitaciones?: { presupuestoMaximo: number | null; ingresosAnuales: number | null };
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
  escala: 'Escala del contrato', plazo: 'Plazo de ofertas', viabilidad: 'Viabilidad de la solvencia', precio: 'Peso del precio',
};

const limitar = (x: number) => Math.min(1, Math.max(0, x));
const redondear = (x: number) => Math.round(x * 100) / 100;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** YYYY-MM-DD → "5 de junio de 2026". */
export const fechaLarga = (dia: string) => `${Number(dia.slice(8, 10))} de ${MESES[Number(dia.slice(5, 7)) - 1]} de ${dia.slice(0, 4)}`;
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
  const a = e.analisis as Analisis | null;
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
  const a = e.analisis as Analisis | null;
  const maximo = parsearImporte(a?.importeMaximoProyecto.valor ?? null);
  const total = parsearImporte(a?.importeTotal.valor ?? null);
  const cifra = maximo ?? total;
  if (cifra === null) {
    return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: `desconocido: ${a ? 'ni el importe por proyecto ni el total constan' : 'sin analizar'}` };
  }
  const minimo = e.importeMinimo ?? c.minimoSiPerfilNoTiene;
  const premio = esPremio(e.convocatoria);
  const que = premio ? `premio de ${euros(cifra)}` : maximo !== null ? `máximo por proyecto ${euros(maximo)}` : `solo consta el importe total (${euros(total!)})`;
  if (cifra < minimo) return { subpuntuacion: 0, conocido: true, explicacion: `${que}, por debajo del mínimo que merece el esfuerzo (${euros(minimo)})` };
  const techo = Math.max(c.techo, minimo * 2);
  let s = 0.3 + 0.7 * limitar(Math.log(cifra / minimo) / Math.log(techo / minimo));
  if (maximo === null && !premio) s *= c.pesoSoloTotal;
  return { subpuntuacion: redondear(s), conocido: true, explicacion: maximo !== null || premio ? que : `${que}; no dice cuánto se da por proyecto` };
}

function cierre(e: EntradaPuntuacion, c: ConfigPuntuacion['cierre']): Parcial {
  const dias = e.plazo?.diasHastaCierre ?? null;
  if (dias === null) {
    return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: `desconocido: ${e.plazo ? 'no se ha podido fijar la fecha de cierre' : 'sin plazo calculado'}` };
  }
  const tramo = c.tramos.find((t) => t.hastaDias === null || dias <= t.hastaDias);
  const nota = e.plazo?.tipo === 'calculada' ? ' (fecha calculada)' : '';
  if (dias < 0) {
    return { subpuntuacion: 0, conocido: true, explicacion: e.plazo?.fechaCierre ? `cerrada el ${fechaLarga(e.plazo.fechaCierre)}` : 'cerrada' };
  }
  const cuando = dias === 0 ? 'cierra hoy' : dias === 1 ? 'cierra mañana' : `faltan ${dias} días`;
  const valor = tramo?.valor ?? 0;
  const juicio = valor < 0.5 ? 'poco tiempo para preparar la solicitud'
    : tramo?.hastaDias === null ? 'plazo lejano, sin prisa'
    : valor < 1 ? 'tiempo justo' : 'tiempo de sobra';
  return { subpuntuacion: redondear(tramo?.valor ?? 0), conocido: true, explicacion: `${cuando}${nota}: ${juicio}` };
}

function esfuerzo(e: EntradaPuntuacion, c: ConfigPuntuacion['esfuerzo']): Parcial {
  const a = e.analisis as Analisis | null;
  if (!a) return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: 'desconocido: sin analizar' };
  const premio = esPremio(e.convocatoria);
  const pct = premio ? 0 : parsearCofinanciacion(a.cofinanciacion.valor);
  const n = a.requisitos.length;
  const partes: string[] = [];
  const subs: number[] = [];
  if (premio) { subs.push(1); partes.push('premio: sin cofinanciación'); }
  else if (pct === null) partes.push('cofinanciación desconocida');
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

/** Puntúa una convocatoria. `probabilidad` es el factor enchufable (por defecto, sin datos). Una licitación (fuente placsp) se puntúa con sus propios factores. */
export function puntuar(
  entrada: EntradaPuntuacion, config: ConfigPuntuacion, probabilidad: ProveedorProbabilidad = probabilidadSinDatos,
): Puntuacion {
  if (entrada.convocatoria.fuente === 'placsp') return puntuarLicitacion(entrada, config);
  const p = probabilidad(entrada);
  const parciales: Record<(typeof FACTORES)[number], Parcial> = {
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
  const analisisConvocatoria = entrada.analisis as Analisis | null;
  if (analisisConvocatoria?.elegibilidadSede?.valor === 'no') excluida = analisisConvocatoria.elegibilidadSede.razon ?? 'Exige sede o inscripción en otro territorio';
  else if (analisisConvocatoria?.elegibilidadEsfl.valor === 'no') excluida = 'No admite entidades sin ánimo de lucro';
  else if (dias !== null && dias < 0) excluida = entrada.plazo?.fechaCierre ? `Cerrada el ${fechaLarga(entrada.plazo.fechaCierre)}` : 'Cerrada';
  else if (dias === null && (entrada.diasDesdePrimeraVez ?? 0) > (config.diasMaximosSinPlazo ?? DIAS_MAXIMOS_SIN_PLAZO)) {
    excluida = `Plazo desconocido y vista por primera vez hace ${entrada.diasDesdePrimeraVez} días: probablemente ya cerrada`;
  }
  return { total: excluida ? 0 : total, excluida, analizada: entrada.analisis !== null, factores, ...(consorcio ? { consorcio: true } : {}) };
}

// --- Licitaciones (fuente placsp) ---

/** Importes en euros de un texto (solo cifras seguidas o precedidas de € / euros: ignora artículos, porcentajes y plazos); el mayor, o null. */
export function parsearImporteEuros(texto: string | null): number | null {
  if (!texto) return null;
  const encontrados: number[] = [];
  for (const m of texto.matchAll(/(?:€\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(\s*(?:millones|millón))?\s*(€|euros?\b|eur\b)?/gi)) {
    const antes = texto.slice(Math.max(0, m.index! - 2), m.index!);
    if (!m[4] && !/€\s*$/.test(antes) && !/€/.test(m[0])) continue;
    let n = Number(m[1].replace(/\./g, '') + (m[2] ? `.${m[2]}` : ''));
    if (m[3]) n *= 1_000_000;
    if (Number.isFinite(n)) encontrados.push(n);
  }
  return encontrados.length ? Math.max(...encontrados) : null;
}

const licitacionDe = (c: Convocatoria): Licitacion | null => ((c.datos as { licitacion?: Licitacion } | null)?.licitacion) ?? null;

/** Presupuesto base sin IVA que cuenta para la escala: el del contrato o, con varios lotes (se puede ofertar a uno), el del lote más pequeño con importe. */
export function presupuestoEfectivo(l: Licitacion | null, a: AnalisisLicitacion | null): { importe: number | null; deLote: boolean } {
  const total = l?.presupuestoSinIva ?? parsearImporteEuros(a?.presupuestoBase.valor ?? null);
  const lotes = (l?.lotes ?? []).map((x) => x.presupuestoSinIva).filter((x): x is number => x != null && x > 0);
  if (lotes.length > 1) {
    const menor = Math.min(...lotes);
    if (total == null || total <= 0 || menor < total) return { importe: menor, deLote: true };
  }
  return { importe: total != null && total > 0 ? total : null, deLote: false };
}

/** Puntos (sobre 100) del precio: los del análisis (con cita) o, sin él, los criterios del anuncio cuya descripción habla de precio u oferta económica. */
export function ponderacionDelPrecio(l: Licitacion | null, a: AnalisisLicitacion | null): { puntos: number | null; origen: 'analisis' | 'anuncio' | null } {
  const dicho = Number((a?.ponderacionPrecio.valor ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  if (a?.ponderacionPrecio.valor && Number.isFinite(dicho)) return { puntos: dicho, origen: 'analisis' };
  const economicos = (l?.criterios ?? []).filter((k) => k.peso != null && /precio|econ[oó]mic|baja|importe/i.test(k.descripcion));
  const total = (l?.criterios ?? []).reduce((t, k) => t + (k.peso ?? 0), 0);
  if (economicos.length === 0 || total <= 0) return { puntos: null, origen: null };
  // Con lotes los criterios se repiten por lote: se normaliza a 100 sobre el total de pesos.
  return { puntos: Math.round((economicos.reduce((t, k) => t + (k.peso ?? 0), 0) / total) * 100), origen: 'anuncio' };
}

function puntuarLicitacion(e: EntradaPuntuacion, config: ConfigPuntuacion): Puntuacion {
  const cfg = config.licitaciones ?? CONFIG_LICITACIONES_POR_DEFECTO;
  const l = licitacionDe(e.convocatoria);
  const a = esAnalisisLicitacion(e.analisis) ? e.analisis : null;
  const escalaPerfil = e.escalaLicitaciones ?? { presupuestoMaximo: null, ingresosAnuales: null };
  const dias = e.plazo?.diasHastaCierre ?? null;
  const parciales: Record<(typeof FACTORES_LICITACION)[number], Parcial> = {
    encaje: ((): Parcial => {
      if (!a) return { subpuntuacion: cfg.encaje.valorDesconocido, conocido: false, explicacion: 'desconocido: la licitación aún no se ha analizado' };
      const n = a.lineas.length;
      const base = cfg.encaje.porLineas[Math.min(n, cfg.encaje.porLineas.length - 1)] ?? 0;
      return { subpuntuacion: redondear(base), conocido: true, explicacion: n === 0 ? 'el objeto del contrato no encaja con ninguna línea de Reforesta' : `el objeto encaja con ${n === 1 ? 'la línea' : `${n} líneas`}: ${a.lineas.map((x) => x.linea).join(', ')}` };
    })(),
    escala: ((): Parcial => {
      const { importe: p, deLote } = presupuestoEfectivo(l, a);
      const c = cfg.escala;
      if (p === null) return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: 'desconocida: presupuesto no indicado o por precios unitarios' };
      const que = `${deLote ? 'el lote más pequeño' : 'presupuesto'} ${euros(p)} sin IVA`;
      const max = escalaPerfil.presupuestoMaximo;
      if (max !== null && p > max) return { subpuntuacion: 0, conocido: true, explicacion: `${que}: probablemente fuera de escala (más de ${euros(max)}${escalaPerfil.ingresosAnuales ? `, ${(p / escalaPerfil.ingresosAnuales).toFixed(1).replace('.', ',')} veces los ingresos anuales` : ''})` };
      if (p <= c.optimo) return { subpuntuacion: p < 3000 ? c.valorMinimo : 1, conocido: true, explicacion: p < 3000 ? `${que}: muy poco para el esfuerzo de una oferta` : `${que}: a la medida de la entidad` };
      if (max === null) return { subpuntuacion: c.valorEnElMaximo, conocido: true, explicacion: `${que}: por encima de lo habitual para la entidad (el perfil no fija un máximo)` };
      const t = (p - c.optimo) / Math.max(1, max - c.optimo);
      return { subpuntuacion: redondear(1 - t * (1 - c.valorEnElMaximo)), conocido: true, explicacion: `${que}: grande para la entidad (el máximo asumible es ${euros(max)})` };
    })(),
    plazo: ((): Parcial => {
      const c = cfg.plazo;
      if (dias === null) return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: `desconocido: ${e.plazo ? 'no se ha podido fijar el plazo de ofertas' : 'sin plazo calculado'}` };
      if (dias < 0) return { subpuntuacion: 0, conocido: true, explicacion: e.plazo?.fechaCierre ? `plazo de ofertas cerrado el ${fechaLarga(e.plazo.fechaCierre)}` : 'plazo de ofertas cerrado' };
      const tramo = c.tramos.find((t) => t.hastaDias === null || dias <= t.hastaDias);
      const cuando = dias === 0 ? 'las ofertas se presentan hoy' : dias === 1 ? 'las ofertas se presentan mañana' : `faltan ${dias} días para presentar la oferta`;
      const v = tramo?.valor ?? 0;
      return { subpuntuacion: redondear(v), conocido: true, explicacion: `${cuando}: ${v < 0.5 ? 'muy poco tiempo para preparar la oferta' : v < 1 ? 'tiempo justo' : 'tiempo de sobra'}` };
    })(),
    viabilidad: ((): Parcial => {
      const c = cfg.viabilidad;
      if (a?.reservaSocial.valor === 'si') return { subpuntuacion: 0, conocido: true, explicacion: 'contrato reservado a otro tipo de entidad (centros especiales de empleo, empresas de inserción…)' };
      const exigido = parsearImporteEuros(a?.solvenciaEconomica.valor ?? null) ?? parsearImporteEuros(l?.solvenciaEconomica.join(' ') ?? null);
      const delAnuncio = !a?.solvenciaEconomica.valor;
      const partes: string[] = [];
      let v: number | null = null;
      if (exigido !== null && escalaPerfil.ingresosAnuales) {
        const veces = exigido / escalaPerfil.ingresosAnuales;
        v = veces <= c.holgado ? 1 : veces <= c.justo ? c.valorJusto : c.valorExcesivo;
        partes.push(`${delAnuncio ? 'el anuncio' : 'los pliegos'} pide un volumen de negocio de ${euros(exigido)} (${veces.toFixed(1).replace('.', ',')} veces los ingresos anuales de la entidad)`);
      }
      if (a?.clasificacion.valor) { v = (v ?? 1) * c.multiplicadorClasificacion; partes.push('exige clasificación empresarial'); }
      if (v === null) return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: `desconocida: ${a ? 'no consta qué solvencia económica se exige' : 'sin analizar y el anuncio no cifra la solvencia'}` };
      return { subpuntuacion: redondear(v), conocido: true, explicacion: partes.join('; ') };
    })(),
    precio: ((): Parcial => {
      const c = cfg.precio;
      const { puntos, origen } = ponderacionDelPrecio(l, a);
      if (puntos === null) return { subpuntuacion: c.valorDesconocido, conocido: false, explicacion: 'desconocido: no consta cuánto pesa el precio en la adjudicación' };
      const tramo = c.tramos.find((t) => t.hastaPuntos === null || puntos <= t.hastaPuntos);
      const v = tramo?.valor ?? 0;
      return { subpuntuacion: redondear(v), conocido: true, explicacion: `el precio vale ${puntos} puntos de 100${origen === 'anuncio' ? ' (según el anuncio)' : ''}: ${v >= 0.8 ? 'pesan más la calidad y la memoria técnica' : v >= 0.55 ? 'equilibrado entre precio y calidad' : 'se adjudica sobre todo por precio'}` };
    })(),
  };
  const factores: Factor[] = FACTORES_LICITACION.map((id) => ({ id, nombre: NOMBRES[id], peso: cfg.pesos[id], ...parciales[id] }));
  const suma = factores.reduce((t, f) => t + f.peso, 0);
  const total = Math.round((factores.reduce((t, f) => t + f.peso * f.subpuntuacion, 0) / suma) * 100);
  let excluida: string | null = null;
  if (a?.reservaSocial.valor === 'si') excluida = 'Contrato reservado a otro tipo de entidad';
  else if (dias !== null && dias < 0) excluida = e.plazo?.fechaCierre ? `Plazo de ofertas cerrado el ${fechaLarga(e.plazo.fechaCierre)}` : 'Plazo de ofertas cerrado';
  else if (dias === null && (e.diasDesdePrimeraVez ?? 0) > (config.diasMaximosSinPlazo ?? DIAS_MAXIMOS_SIN_PLAZO)) excluida = `Plazo desconocido y vista por primera vez hace ${e.diasDesdePrimeraVez} días: probablemente ya cerrada`;
  return { total: excluida ? 0 : total, excluida, analizada: a !== null, factores };
}
