// Utilidades de texto: HTML → texto plano y normalización para comprobar citas literales.

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML (extractos de BOE/BDNS, páginas de bases) → texto plano con un salto por párrafo. */
export function htmlATexto(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|table|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTIDADES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Forma canónica para buscar una cita dentro de un texto: minúsculas, comillas y guiones tipográficos unificados,
 * sin guiones de partición de línea de los PDF y con todo el espacio en blanco reducido a un espacio.
 */
export function normalizarParaCita(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/­/g, '')
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚´`]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2') // "cofinan-\nciación" → "cofinanciación"
    .replace(/\s+/g, ' ')
    .trim();
}

/** true si la cita aparece literalmente (salvo espacios, mayúsculas y tipografía) en el texto. */
export function citaEnTexto(cita: string, textoNormalizado: string): boolean {
  const c = normalizarParaCita(cita).replace(/^["'.…\s]+|["'.…\s]+$/g, '');
  if (c.length < 8) return false; // una cita de dos palabras no prueba nada
  // Se admiten citas con elipsis: cada trozo debe aparecer, en orden.
  let desde = 0;
  for (const trozo of c.split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/).filter(Boolean)) {
    const i = textoNormalizado.indexOf(trozo, desde);
    if (i < 0) return false;
    desde = i + trozo.length;
  }
  return true;
}

// --- Cifras: el valor de un campo numérico (importe, porcentaje, plazo, fecha) debe estar en su cita ---

const UNIDADES: Record<string, number> = {
  // "un", "una" y "uno" no cuentan: casi siempre son artículos ("un porcentaje") y harían fallar valores sin cifras.
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, cien: 100, ciento: 100,
};
const DECENAS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const MESES_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UNIDADES_EN: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const DECENAS_EN: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "17.389.322,52" → 17389322.52 (coma decimal, punto de millares); "100.000" → 100000; "20,5" → 20.5; "09" → 9. */
function cifraEs(token: string): number {
  let t = token;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  return Number.parseFloat(t);
}

/** "3,000,000" → 3000000; "3,000.50" → 3000.5; "3.5" → 3.5 (coma de millares, punto decimal). */
function cifraEn(token: string): number {
  return Number.parseFloat(token.replace(/,/g, ''));
}

/**
 * Cada cifra del texto con sus lecturas posibles. El formato es ambiguo ("1.500" = 1500 en castellano y 1,5 en inglés; "3,000" = 3
 * en castellano y 3000 en inglés), así que se guardan las dos. También: millares con espacio ("3 000 000"), "3 million" / "3 millones" /
 * "€3.5M" (×10⁶) y las partes de una fecha.
 */
function cifrasDe(s: string): number[][] {
  const grupos: number[][] = [];
  const re = /(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d[\d.,]*\d|\d)(\s*(?:million|millones|millon|mn|m)(?![a-z\p{L}]))?/giu;
  for (const m of s.matchAll(re)) {
    const t = m[1].replace(/[  ]/g, '');
    const lecturas = [cifraEs(t), cifraEn(t)].filter(Number.isFinite);
    const alts = m[2] ? lecturas.map((v) => v * 1e6) : lecturas;
    if (alts.length) grupos.push([...new Set(alts)]);
  }
  return grupos;
}

function palabrasNumericas(s: string): number[] {
  const n: number[] = [];
  const palabras = s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().split(/[^a-zñ]+/).filter(Boolean);
  for (let i = 0; i < palabras.length; i++) {
    const p = palabras[i];
    if (p in DECENAS) {
      const u = palabras[i + 1] === 'y' ? UNIDADES[palabras[i + 2]] : undefined;
      n.push(DECENAS[p] + (u && u < 10 ? u : 0));
    } else if (p in UNIDADES) n.push(UNIDADES[p]);
    else if (p in DECENAS_EN) {
      const u = UNIDADES_EN[palabras[i + 1]];
      n.push(DECENAS_EN[p] + (u && u < 10 ? u : 0));
    } else if (p in UNIDADES_EN) n.push(UNIDADES_EN[p]);
    const mes = MESES.indexOf(p);
    if (mes >= 0) n.push(mes + 1);
    const mesEn = MESES_EN.indexOf(p);
    if (mesEn >= 0) n.push(mesEn + 1);
  }
  return n;
}

/**
 * Números que aparecen en un texto (todas las lecturas posibles de cada cifra): cifras en formato castellano o inglés, con millares
 * y decimales, "3 million", números en letra hasta noventa y nueve (castellano e inglés), meses por su número (también en inglés) y las
 * partes de una fecha (30/09/2026 → 30, 9, 2026). Sirve para comparar un valor con su cita sin depender del formato:
 * "15 días hábiles" ~ "fifteen working days", "30 de septiembre" ~ "30/09/2026", "3.000.000 €" ~ "EUR 3,000,000" ~ "€3 million".
 */
export function numerosDe(s: string): Set<number> {
  return new Set([...cifrasDe(s).flat(), ...palabrasNumericas(s)]);
}

/**
 * true si todos los números del valor están en la cita (un valor sin números no se puede contrastar así: true).
 * Cada cifra del valor vale si CUALQUIERA de sus lecturas está en la cita.
 */
export function valorEnCita(valor: string, cita: string): boolean {
  const enCita = [...numerosDe(cita)];
  const esta = (v: number) => enCita.some((c) => Math.abs(c - v) < 1e-9 * Math.max(1, Math.abs(v)));
  return cifrasDe(valor).every((alts) => alts.some(esta)) && palabrasNumericas(valor).every(esta);
}
