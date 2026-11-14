// Composición del correo del lunes: funciones puras de datos → asunto, HTML (estilos en línea, una columna, sin imágenes) y texto.
// PUNTO DE EXTENSIÓN (Task 13, "Empresas nuevas de la semana"): `DependenciasResumen.seccionesExtra` devuelve `SeccionCorreo[]`
// que se añaden al final del correo (HTML y texto) con el mismo formato; no hay que tocar este módulo.
import type { Puntuacion } from './puntuacion.ts';
import type { Analisis } from './fases/analisis-esquema.ts';

export interface ItemCorreo {
  titulo: string;
  /** Enlace a la ficha en la web. */
  url: string;
  /** Una línea con el porqué (puede faltar). */
  porQue?: string;
  /** Líneas cortas (importe, cierre…). */
  detalles: string[];
}

export interface SeccionCorreo {
  titulo: string;
  intro?: string;
  items: ItemCorreo[];
}

export interface EntradaItem {
  id: string;
  titulo: string;
  organo: string;
  puntuacion: Pick<Puntuacion, 'factores'> | null;
  plazo: { fechaCierre: string | null; tipo: 'literal' | 'calculada' | 'desconocida'; diasHastaCierre: number | null } | null;
  analisis: Analisis | null;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const fechaCorta = (dia: string) => `${Number(dia.slice(8, 10))} ${MESES[Number(dia.slice(5, 7)) - 1]}`;

export const urlFicha = (urlPublica: string, id: string) => `${urlPublica.replace(/\/+$/, '')}/convocatoria/${encodeURIComponent(id)}`;

/** El porqué en una línea: las dos explicaciones de los factores conocidos que más han aportado (peso × subpuntuación). */
export function porQue(p: EntradaItem['puntuacion']): string | undefined {
  const factores = (p?.factores ?? []).filter((f) => f.conocido && f.subpuntuacion > 0 && f.id !== 'cierre')
    .sort((a, b) => b.peso * b.subpuntuacion - a.peso * a.subpuntuacion).slice(0, 2);
  if (!factores.length) return undefined;
  const t = factores.map((f) => f.explicacion.replace(/[.\s]+$/, '')).join('; ');
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}

/** Corta en el último límite de palabra antes de `max` caracteres y añade "...". */
export function acortar(t: string, max: number): string {
  const l = t.replace(/\s+/g, ' ').trim();
  if (l.length <= max) return l;
  const corte = l.slice(0, max - 3);
  const i = corte.lastIndexOf(' ');
  return `${(i > max / 2 ? corte.slice(0, i) : corte).replace(/[\s,;:.]+$/, '')}...`;
}

const CIFRA_EUROS = /\d[\d.,]*\s*(?:mil\s+|millones?\s+(?:de\s+)?)?(?:€|euros?\b|eur\b)/i;

/**
 * Solo el importe inicial: se corta en el primer "(" o ";" (aclaraciones), y como último recurso en límite de palabra. Si lo que queda no tiene
 * ninguna cifra en euros ("Hasta el 80 %") y la aclaración sí ("máx. 5.000 €"), se conserva esa primera cifra entre paréntesis.
 */
export function importeLimpio(v: string): string {
  const [cabeza, ...resto] = v.split(/[(;]/);
  let base = cabeza.replace(/[\s,.:]+$/, '') || v;
  if (!CIFRA_EUROS.test(base)) {
    const cifra = CIFRA_EUROS.exec(resto.join(' '))?.[0].trim();
    if (cifra) base = `${base} (${cifra})`;
  }
  return acortar(base, 60);
}

const EMPIEZA_CON_LIMITE = /^(hasta|máximo|maximo|como máximo|un máximo|de hasta|desde|entre|sin)\b/i;

export function textoImporte(a: Analisis | null): string {
  if (a?.importeMaximoProyecto.valor) {
    const v = importeLimpio(a.importeMaximoProyecto.valor);
    // "Hasta" solo delante de una cifra en euros que no lleve ya su propio límite ("Entre…", "Sin límite", "el 80 %" no).
    return EMPIEZA_CON_LIMITE.test(v) || !CIFRA_EUROS.test(v) || !/^\d/.test(v) ? `${v} por proyecto` : `Hasta ${v} por proyecto`;
  }
  if (a?.importeTotal.valor) return `${importeLimpio(a.importeTotal.valor)} en total`;
  return 'Importe por confirmar';
}

export function textoCierre(p: EntradaItem['plazo']): string {
  if (!p?.fechaCierre) return 'Cierre sin fecha clara: mira la ficha';
  const d = p.diasHastaCierre;
  const cuando = d === null ? '' : d === 0 ? ' (hoy)' : d === 1 ? ' (mañana)' : ` (en ${d} días)`;
  return `Cierra el ${fechaCorta(p.fechaCierre)}${cuando}${p.tipo === 'calculada' ? ', fecha calculada' : ''}`;
}

export function itemCorreo(e: EntradaItem, urlPublica: string): ItemCorreo {
  return { titulo: acortar(e.titulo, 140), url: urlFicha(urlPublica, e.id), porQue: porQue(e.puntuacion), detalles: [e.organo, `${textoImporte(e.analisis)} · ${textoCierre(e.plazo)}`] };
}

export interface ResumenCorreo {
  asunto: string;
  html: string;
  texto: string;
}

export function componerCorreo(
  p: { hoy: string; lunes: string; total: number; cierranPronto: number; secciones: SeccionCorreo[]; urlPublica: string; consorcio?: number },
): ResumenCorreo {
  const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
  const asunto = `Radar Reforesta · semana del ${fechaCorta(p.lunes)}: ${plural(p.total, 'convocatoria', 'convocatorias')}`
    + (p.cierranPronto ? `, ${p.cierranPronto} ${p.cierranPronto === 1 ? 'cierra pronto' : 'cierran pronto'}` : '');
  const web = p.urlPublica.replace(/\/+$/, '');
  const secciones = p.secciones.filter((s) => s.items.length);
  // Una sola línea (no una sección): convocatorias europeas de consorcio (Horizon), solo como socia; el detalle está en la web.
  const nConsorcio = p.consorcio ?? 0;
  const lineaConsorcio = nConsorcio > 0 ? `${nConsorcio} ${nConsorcio === 1 ? 'convocatoria europea' : 'convocatorias europeas'} para ir como socio de un consorcio` : null;
  const enlaceConsorcio = `${web}/#consorcio`;

  const texto = [
    `Radar Reforesta · semana del ${fechaCorta(p.lunes)}`,
    '',
    ...secciones.flatMap((s) => [
      s.titulo.toUpperCase(), ...(s.intro ? [s.intro] : []), '',
      ...s.items.flatMap((i) => [`* ${i.titulo}`, ...(i.porQue ? [`  ${i.porQue}`] : []), ...i.detalles.map((d) => `  ${d}`), `  ${i.url}`, '']),
    ]),
    ...(lineaConsorcio ? [`${lineaConsorcio}: ${enlaceConsorcio}`, ''] : []),
    `Todo en la web: ${web}`,
    'No respondas a este correo: nadie lo lee.',
  ].join('\n');

  const e = esc;
  const bloque = (s: SeccionCorreo) => `
<h2 style="font-size:16px;margin:28px 0 4px;color:#14532d;">${e(s.titulo)}</h2>${s.intro ? `
<p style="margin:0 0 8px;font-size:14px;color:#555;">${e(s.intro)}</p>` : ''}${s.items.map((i) => `
<div style="margin:12px 0;padding:12px;border:1px solid #e5e7eb;border-radius:8px;">
<a href="${e(i.url)}" style="font-size:15px;font-weight:bold;color:#166534;text-decoration:none;">${e(i.titulo)}</a>${i.porQue ? `
<p style="margin:6px 0 0;font-size:14px;color:#222;">${e(i.porQue)}</p>` : ''}${i.detalles.map((d) => `
<p style="margin:4px 0 0;font-size:13px;color:#555;">${e(d)}</p>`).join('')}
</div>`).join('')}`;
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(asunto)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f4;">
<div style="max-width:560px;margin:0 auto;padding:16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.45;color:#111;background:#ffffff;">
<h1 style="font-size:20px;margin:0;">Radar Reforesta</h1>
<p style="margin:4px 0 0;font-size:14px;color:#555;">Semana del ${e(fechaCorta(p.lunes))}</p>${secciones.map(bloque).join('')}${lineaConsorcio ? `
<p style="margin:20px 0 0;font-size:14px;color:#555;"><a href="${e(enlaceConsorcio)}" style="color:#166534;">${e(lineaConsorcio)}</a></p>` : ''}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 12px;">
<p style="margin:0;font-size:13px;color:#555;">Todo está en la web: <a href="${e(web)}" style="color:#166534;">${e(web)}</a></p>
<p style="margin:4px 0 0;font-size:13px;color:#777;">No respondas a este correo: nadie lo lee.</p>
</div></body></html>
`;
  return { asunto, html, texto };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
