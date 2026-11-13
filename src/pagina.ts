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

/** Huella estable del texto principal: insensible a mayúsculas y espacios. */
export function huellaDeTexto(texto: string): string {
  return createHash('sha256').update(texto.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}
