// Título corto para mostrar: el que genera el análisis ("tituloCorto") o, mientras no hay, el título oficial hecho legible.
// BDNS manda títulos en MAYÚSCULAS, con encabezados administrativos ("Resolución de 9 de octubre… por la que se convoca…") y de tres líneas:
// aquí se pasan a frase normal (nunca mayúsculas sostenidas), se quita el encabezado y se recorta en límite de palabra.
export const MAX_TITULO_CORTO = 90;

const SIGLAS = new Set(['UE', 'ONG', 'ONGD', 'IVA', 'IRPF', 'PYME', 'PYMES', 'FEADER', 'FEDER', 'FSE', 'LIFE', 'BDNS', 'BOE', 'BOCM', 'CSIC', 'URJC', 'UNED', 'ESO', 'TIC', 'I+D', 'I+D+I', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII', 'XXIII', 'XXIV', 'XXV', 'XXVI', 'XXVII', 'XXVIII', 'XXIX', 'XXX', 'XXXI', 'XXXII', 'XXXIII', 'XXXIV', 'XXXV', 'XXXVI', 'XXXVII', 'XXXVIII', 'XXXIX', 'XL']);
// Tras estas palabras suele ir un nombre propio ("Ayuntamiento de alberic" → "Ayuntamiento de Alberic").
const PROPIO = /\b((?:ayuntamiento|diputación|diputacion|cabildo|consell|distrito|universidad|mancomunidad|comarca|municipio|ciudad|fundación|fundacion)\s+(?:de la |de los |de las |del |de )?)(\p{L})/giu;

const letras = (t: string) => t.replace(/[^\p{L}]/gu, '');
const mayusculas = (t: string) => t.replace(/[^\p{Lu}]/gu, '');

/** Más de la mitad de las letras en mayúscula (y al menos un puñado de ellas). */
export function esMayusculas(t: string): boolean {
  const l = letras(t);
  return l.length >= 8 && mayusculas(l).length / l.length > 0.6;
}

const ENCABEZADO = [
  /^(?:resoluci[oó]n|acuerdo|decreto|orden|extracto)\b[^.]*?\b(?:por (?:la|el) que se (?:aprueba|convoca|establece|publica|acuerda)|por (?:la|el) cual se (?:aprueba|convoca))\s+(?:la\s+|el\s+|las\s+|los\s+)?(?:convocatoria\s+(?:p[uú]blica\s+)?(?:de|para)\s+(?:la\s+concesi[oó]n\s+de\s+)?|bases\s+(?:reguladoras\s+)?(?:de|para)\s+)?/i,
  /^(?:aprobaci[oó]n\s+de\s+las\s+bases\s+(?:reguladoras\s+)?(?:de|del)\s+)/i,
  /^(?:bases\s+reguladoras\s+y\s+convocatoria\s+(?:p[uú]blica\s+)?(?:de|del|para)\s+)/i,
  /^(?:bases\s+reguladoras\s+(?:de|del|para)\s+(?:la\s+)?)/i,
  /^(?:bases\s+y\s+convocatoria\s+(?:reguladoras?\s+)?(?:de|del|para)\s+)/i,
  /^(?:convocatoria\s+(?:p[uú]blica\s+)?(?:de|del|para)\s+(?:la\s+concesi[oó]n\s+de\s+)?)/i,
  /^(?:extracto\s+(?:de\s+las\s+)?bases\s+)/i,
];

function frase(t: string): string {
  let r = esMayusculas(t) ? t.toLowerCase() : t;
  if (r !== t) {
    r = r.replace(/[\p{L}+]+/gu, (w) => (SIGLAS.has(w.toUpperCase()) ? w.toUpperCase() : w));
    r = r.replace(PROPIO, (_m, ant: string, c: string) => `${ant}${c.toUpperCase()}`);
  }
  return r.charAt(0).toUpperCase() + r.slice(1);
}

/** Corta en el último límite de palabra antes de `max` caracteres, con "…". */
export function recortar(t: string, max: number): string {
  if (t.length <= max) return t;
  const corte = t.slice(0, max - 1);
  const i = corte.lastIndexOf(' ');
  return `${(i > max / 2 ? corte.slice(0, i) : corte).replace(/[\s,;:.\-–(]+$/, '')}…`;
}

/** Título oficial → frase legible y corta (sin mayúsculas sostenidas). Nunca devuelve vacío si el original no lo está. */
export function tituloLegible(oficial: string, max = MAX_TITULO_CORTO): string {
  const limpio = oficial.replace(/\s+/g, ' ').replace(/^["“'«]+|["”'»]+$/g, '').trim();
  if (!limpio) return '';
  let t = limpio;
  for (const re of ENCABEZADO) {
    const sin = t.replace(re, '');
    if (sin !== t && sin.trim().length >= 12) { t = sin.trim(); break; }
  }
  return recortar(frase(t).replace(/[.\s]+$/, ''), max);
}

/** Valida el título corto que dio el LLM: una línea, sin mayúsculas sostenidas, no más largo que el límite; null si no vale. */
export function validarTituloCorto(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (t.length < 6) return null;
  const bueno = esMayusculas(t) ? frase(t) : t;
  return recortar(bueno, MAX_TITULO_CORTO);
}

/** Lo que se muestra: el título corto del análisis y, si no hay, el oficial legible. */
export const tituloParaMostrar = (tituloCorto: string | null | undefined, oficial: string): string => tituloCorto?.trim() || tituloLegible(oficial);
