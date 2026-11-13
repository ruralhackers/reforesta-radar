// Texto principal de una página web (heurística tipo "readability", sin dependencias) y su huella.
// Se quitan scripts, estilos, menús, cabeceras, pies, formularios y bloques con pinta de banner de cookies o menú; si hay <main> o <article>,
// se usa su contenido. Los enlaces se conservan como "texto [url absoluta]" para que el LLM pueda dar el enlace de cada convocatoria.
import { createHash } from 'node:crypto';
import { htmlATexto } from './texto.ts';

const BLOQUES_FUERA = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'nav', 'footer', 'aside', 'form', 'select', 'button', 'dialog'];
// header se quita solo si no está dentro de <main>/<article> (ahí suele ser el título de la sección): se trata aparte.
const RUIDO = /(cookie|consent|gdpr|banner|breadcrumb|migas|menu|navbar|nav-|sidebar|footer|newsletter|social|share|compartir)/i;

function quitarBloques(html: string, etiqueta: string): string {
  return html.replace(new RegExp(`<${etiqueta}\\b[^>]*>[\\s\\S]*?<\\/${etiqueta}>`, 'gi'), ' ');
}

/** Quita `<div|section|ul ...class|id="...ruido...">…</…>` cuando no anidan otro igual (heurística de coste bajo). */
function quitarRuidoPorClase(html: string): string {
  return html.replace(/<(div|section|ul|aside)\b([^>]*)>((?:(?!<\1\b)[\s\S])*?)<\/\1>/gi, (m, _t, atrs: string) => {
    const nombre = /(?:class|id)\s*=\s*["']([^"']*)["']/gi;
    for (let a = nombre.exec(atrs); a; a = nombre.exec(atrs)) if (RUIDO.test(a[1])) return ' ';
    return m;
  });
}

function absoluta(href: string, base: string): string | null {
  try {
    const u = new URL(href.replace(/&amp;/g, '&'), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export function textoPrincipal(html: string, base: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const b of BLOQUES_FUERA) h = quitarBloques(h, b);
  // El contenido principal, si la página lo marca; si no, todo el <body>.
  const principal = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(h) ?? /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(h);
  if (principal && htmlATexto(principal[1]).length > 400) h = principal[1];
  else h = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(h)?.[1] ?? h;
  h = quitarBloques(h, 'header');
  h = quitarRuidoPorClase(h);
  // Enlaces: "texto [url]"; los de ancla, javascript: y similares se quedan solo con el texto.
  h = h.replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, interior: string) => {
    const abs = absoluta(href, base);
    const t = interior.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return abs && t ? ` ${t} [${abs}] ` : ` ${t} `;
  });
  return htmlATexto(h).replace(/\n{2,}/g, '\n').trim();
}

const MESES = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december';
// Lo que se conserva tal cual al calcular la huella (cambia el significado de la convocatoria): fechas y plazos, años, importes y porcentajes.
const CONSERVAR = new RegExp([
  `\\d{1,2}(?:º|°)?\\s+(?:de\\s+)?(?:${MESES})(?:\\s+(?:de\\s+)?\\d{4})?`, // 15 de febrero de 2027
  `(?:${MESES})\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?`, // February 15, 2027
  `(?:${MESES})\\s+(?:de\\s+)?\\d{4}`, // febrero de 2027
  '\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}', '\\d{4}-\\d{2}-\\d{2}', // 15/02/2027, 2027-02-15
  '\\b(?:19|20)\\d{2}\\b', // años
  '\\d[\\d.,\\s]*\\s?(?:€|eur\\b|euros?\\b|%|k€|m€)', '(?:€|eur)\\s?\\d[\\d.,]*', // importes y porcentajes
].join('|'), 'gi');
const HORA = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?\b/gi;
const RELATIVO = /\bhace\s+(?:un|una|unos|unas|\d+)\s+(?:segundos?|minutos?|horas?|d[ií]as?|semanas?|meses|mes|a[ñn]os?)\b|\b\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b|\b(?:hoy|ayer|anteayer|today|yesterday)\b/gi;
const MARCADOR = '\u0001';
// Los números guardados se sustituyen por letras (a-j = 0-9) para que el borrado de números sueltos no los toque.
const codigo = (n: number) => String(n).replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const decodificar = (c: string) => Number([...c].map((l) => 'abcdefghij'.indexOf(l)).join(''));

/**
 * Texto con lo "que baila" quitado antes de la huella: contadores y números sueltos, horas, "hace 3 días", "hoy/ayer". Se conservan las fechas,
 * los años, los importes y los porcentajes: un plazo que pasa del 15 al 20 de febrero SÍ debe contar como cambio.
 */
export function normalizarParaHuella(texto: string): string {
  const guardados: string[] = [];
  let t = texto.toLowerCase().replace(RELATIVO, ' ').replace(HORA, ' ');
  t = t.replace(CONSERVAR, (m) => { guardados.push(m.replace(/\s+/g, ' ')); return `${MARCADOR}${codigo(guardados.length - 1)}${MARCADOR}`; });
  t = t.replace(/\d[\d.,]*/g, ' '); // lo que queda de números: contadores, páginas, visitas…
  t = t.replace(new RegExp(`${MARCADOR}([a-j]+)${MARCADOR}`, 'g'), (_m, i: string) => guardados[decodificar(i)]);
  return t.replace(/\s+/g, ' ').trim();
}

/** Huella estable del texto principal: insensible a mayúsculas, espacios, contadores, horas y fechas relativas. */
export function huellaDeTexto(texto: string): string {
  return createHash('sha256').update(normalizarParaHuella(texto)).digest('hex');
}
