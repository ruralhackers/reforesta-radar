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
