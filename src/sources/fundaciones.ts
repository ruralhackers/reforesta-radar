// Fuente "fundacion": fundaciones privadas y programas de RSC con convocatoria, y agregadores del tercer sector, vigilados por cambios.
//
// Por ejecución, y para cada fuente activa de la tabla `fundaciones` (se añaden y quitan desde la web):
//   1. Se descarga la página (pausa entre fuentes, tiempo y tamaño máximos, UA genérico) y se saca su texto principal (src/pagina.ts).
//   2. Se compara su huella con la última guardada. Igual → no hay llamada al LLM y no se devuelve nada (lo ya extraído sigue en la BD).
//   3. Distinta (o primera vez) → Haiku extrae las convocatorias de la página (título, enlace, plazo, importe, extracto). El código comprueba
//      que título, plazo, importe y extracto están en la página: lo que no se encuentra se queda vacío (nunca se inventa).
//   4. Cada candidata entra como convocatoria `fund:<host>:<hash>`, con origen "fundacion" y el nombre de la fuente, y sigue el camino normal
//      (criba, análisis —que descarga la página o el PDF propio de la convocatoria si tiene enlace—, plazo, puntuación, ranking).
//
// Id estable: host del enlace propio de la convocatoria (o de la página vigilada si no lo tiene) + hash del enlace normalizado (o del título
// si no hay enlace propio). Así la misma convocatoria vista desde una fundación y desde un agregador converge en un mismo id.
// La huella solo se guarda si la extracción salió bien: un fallo del LLM o de la red se reintenta entero en la siguiente ejecución.
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { diaLocal } from '../dates.ts';
import { apuntarRevision, type FuenteVigilada, fuentesActivas, type ResultadoRevision } from '../db/fundaciones.ts';
import { type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { aCache, claveCache, desdeCache, llamar } from '../fases/comun.ts';
import { ESQUEMA_EXTRACCION, promptExtraccion } from '../llm/prompts.ts';
import { fetchSeguro, type Resolver, urlPermitidaSintactica } from '../fetch-seguro.ts';
import { huellaDeTexto, textoPrincipal } from '../pagina.ts';
import type { DatosPlazo } from '../plazos.ts';
import { citaEnTexto, normalizarParaCita } from '../texto.ts';
import type { Convocatoria, Cribada } from '../types.ts';
import type { ContextoFuente, DocumentoFuente, Enlace, Fuente, ResultadoFuente } from './source.ts';

export const FASE_EXTRACCION = 'extraccion_fundaciones';
export const USER_AGENT = 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)';
const MIN_CARACTERES = 200;
const MAX_CANDIDATAS = 15;

export interface OpcionesFundaciones {
  pausaMs: number;
  timeoutMs: number;
  maxBytes: number;
  maxFuentes: number;
  maxCaracteres: number;
}

/** Lo que se guarda en `datos.fundacion` de cada convocatoria: de dónde salió y lo que dice la página. */
export interface DatosFundacion {
  fuenteNombre: string;
  tipo: 'fundacion' | 'agregador';
  paginaUrl: string;
  /** Fragmentos literales de la página (o null si no constan). */
  plazo: string | null;
  importe: string | null;
  extracto: string | null;
  /** Enlace propio de la convocatoria; null si solo se conoce la página vigilada. */
  enlacePropio: string | null;
}

interface Candidata { titulo: string; url: string; plazo: string; importe: string; extracto: string }

/** Topes de longitud de lo que sale de una página (que es texto no confiable). */
export const MAX_TITULO = 300;
export const MAX_URL = 500;
export const MAX_LITERAL = 600;

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function normalizarUrl(u: string): string {
  const x = new URL(u);
  x.hash = '';
  return x.toString().replace(/\/$/, '');
}

/** `fund:<host>:<hash>`; ver la cabecera. */
export function idFundacion(paginaUrl: string, titulo: string, enlacePropio: string | null): string {
  const clave = enlacePropio ? normalizarUrl(enlacePropio) : normalizarParaCita(titulo);
  const host = new URL(enlacePropio ?? paginaUrl).host.replace(/^www\./, '');
  return `fund:${host}:${createHash('sha256').update(clave).digest('hex').slice(0, 12)}`;
}

function validarCandidatas(datos: unknown, texto: string, paginaUrl: string): Candidata[] {
  const lista = (datos as { convocatorias?: unknown } | null)?.convocatorias;
  if (!Array.isArray(lista)) throw new Error('La extracción no devolvió la lista "convocatorias"');
  const norm = normalizarParaCita(texto);
  const pagina = normalizarUrl(paginaUrl);
  const vistos = new Set<string>();
  const salida: Candidata[] = [];
  for (const x of lista.slice(0, MAX_CANDIDATAS)) {
    const o = (x ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const titulo = s('titulo');
    if (!titulo || titulo.length > MAX_TITULO || !norm.includes(normalizarParaCita(titulo).replace(/^["'.…\s]+|["'.…\s]+$/g, ''))) continue; // el título tiene que estar en la página
    let url = '';
    try {
      const u = new URL(s('url'), paginaUrl);
      // Solo enlaces que de verdad aparecen en el texto de la página (el LLM no los inventa) y distintos de la propia página.
      if (u.toString().length <= MAX_URL && urlPermitidaSintactica(u.toString()) && texto.includes(`[${u.toString().replace(/#.*$/, '')}]`) && normalizarUrl(u.toString()) !== pagina) url = u.toString().replace(/#.*$/, '');
    } catch { /* sin enlace */ }
    const literal = (k: string) => (s(k) && s(k).length <= MAX_LITERAL && citaEnTexto(s(k), norm) ? s(k) : '');
    const clave = url ? normalizarUrl(url) : normalizarParaCita(titulo);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push({ titulo, url, plazo: literal('plazo'), importe: literal('importe'), extracto: literal('extracto') });
  }
  return salida;
}

function aConvocatoria(c: Candidata, f: FuenteVigilada, paginaUrl: string, fechaPublicacion: string): Convocatoria {
  const enlacePropio = c.url || null;
  const id = idFundacion(paginaUrl, c.titulo, enlacePropio);
  const datos: DatosFundacion = {
    fuenteNombre: f.nombre, tipo: f.tipo, paginaUrl, plazo: c.plazo || null, importe: c.importe || null, extracto: c.extracto || null,
    enlacePropio,
  };
  return {
    id, fuente: 'fundacion', fuenteId: id.slice('fund:'.length), titulo: c.titulo,
    organo: { nivel1: 'FUNDACIÓN', nivel2: f.nombre, nivel3: f.tipo === 'agregador' ? 'Agregador' : null },
    fechaPublicacion, url: enlacePropio ?? paginaUrl, tipo: null, finalidad: null, regiones: [], abierto: null, datos: { fundacion: datos },
  };
}

async function descargar(f: typeof fetch, url: string, o: OpcionesFundaciones, resolver?: Resolver | null): Promise<string> {
  const r = await fetchSeguro(f, url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, resolver });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!/html|xml|text/i.test(r.tipoContenido)) throw new Error(`no es una página web (${r.tipoContenido || 'sin tipo de contenido'})`);
  return new TextDecoder().decode(r.bytes);
}

export interface ResultadoFundaciones extends ResultadoFuente {
  /** Registro de la extracción LLM (llamadas, tokens, coste); null si no hubo nada que extraer. */
  fase: RegistroFase | null;
  avisos: string[];
}

export function crearFuenteFundaciones(opciones: () => OpcionesFundaciones = () => config.fundaciones): Fuente {
  async function recoger(ctx: ContextoFuente): Promise<ResultadoFundaciones> {
    const o = opciones();
    if (!ctx.db) throw new Error('La fuente de fundaciones necesita la BD');
    const db = ctx.db;
    const dormir = ctx.dormir ?? dormirReal;
    const hoy = diaLocal(ctx.ahora);
    const cribadas: Cribada[] = [];
    const errores: string[] = [];
    const avisos: string[] = [];
    const fase = registroFaseVacio(FASE_EXTRACCION, ctx.modeloLlm ?? null);
    const fuentes = fuentesActivas(db);
    if (fuentes.length > o.maxFuentes) avisos.push(`Tope de ${o.maxFuentes} fuentes por ejecución: ${fuentes.length - o.maxFuentes} sin revisar`);
    let hechas = 0;
    for (const f of fuentes.slice(0, o.maxFuentes)) {
      if (hechas++ > 0 && o.pausaMs > 0) await dormir(o.pausaMs);
      const url = f.url!;
      let resultado: ResultadoRevision;
      try {
        const html = await descargar(ctx.fetch, url, o, ctx.resolver);
        const texto = textoPrincipal(html, url);
        if (texto.length < MIN_CARACTERES) throw new Error('La página no tiene texto (¿se carga con JavaScript o bloquea el acceso?)');
        const huella = huellaDeTexto(texto);
        if (huella === f.huella) {
          resultado = { tipo: 'sin_cambios', huella };
        } else if (!ctx.llm) {
          avisos.push(`${f.nombre}: la página ha cambiado pero no hay LLM configurado; se revisará cuando lo haya`);
          resultado = { tipo: 'sin_cambios', huella }; // no guarda huella: apuntarRevision con sin_cambios no la toca
        } else {
          const recortado = texto.length > o.maxCaracteres;
          if (recortado) avisos.push(`${f.nombre}: página de ${texto.length} caracteres, se leen los primeros ${o.maxCaracteres}`);
          const cuerpo = recortado ? texto.slice(0, o.maxCaracteres) : texto;
          const { sistema, mensaje } = promptExtraccion(ctx.perfil, f.nombre, f.tipo, url, cuerpo);
          const peticion = { tarea: 'extraccion' as const, modelo: ctx.modeloLlm!, sistema, mensaje, esquema: ESQUEMA_EXTRACCION, maxTokens: 8000 };
          const clave = claveCache({ ...peticion });
          const r = desdeCache(db, clave) ?? (await llamar({ db, llm: ctx.llm, reloj: { now: () => ctx.ahora }, fetch: ctx.fetch }, fase, peticion));
          if (r.desdeCache) fase.desdeCache++;
          const candidatas = validarCandidatas(r.datos, cuerpo, url);
          aCache({ db, llm: ctx.llm, reloj: { now: () => ctx.ahora }, fetch: ctx.fetch }, clave, r);
          fase.procesadas++;
          for (const c of candidatas) {
            const conv = aConvocatoria(c, f, url, hoy);
            // La fecha de publicación es la de la primera vez que se vio: una nueva extracción no la mueve.
            const previa = db.prepare('SELECT fecha_publicacion FROM convocatorias WHERE id = ?').get(conv.id) as { fecha_publicacion: string } | undefined;
            if (previa) conv.fechaPublicacion = previa.fecha_publicacion;
            cribadas.push({ convocatoria: conv, descarte: ctx.cribar(conv) });
          }
          resultado = { tipo: 'cambiada', huella };
        }
      } catch (e) {
        resultado = { tipo: 'error', mensaje: (e as Error).message };
        errores.push(`${f.nombre} (${url}): ${(e as Error).message}`);
        fase.errores.push(`${f.nombre}: ${(e as Error).message}`);
      }
      apuntarRevision(db, f.id, resultado, ctx.ahora);
    }
    const hizoAlgo = fase.llamadas > 0 || fase.desdeCache > 0 || fase.errores.length > 0;
    return { cribadas, errores, avisos, fase: hizoAlgo ? fase : null };
  }
  return { nombre: 'fundacion', recoger, documentos, enlaces, datosPlazo };
}

const datosDe = (c: Convocatoria): DatosFundacion | null => ((c.datos as { fundacion?: DatosFundacion } | null)?.fundacion) ?? null;

/** Sin ángulos: el texto de la página no puede cerrar las etiquetas <documento> del prompt del análisis. */
const limpio = (t: string) => t.replace(/[<>]/g, '');

function ficha(c: Convocatoria, d: DatosFundacion): string {
  return [
    `Título: ${limpio(c.titulo)}`,
    `Convocatoria de una fundación privada o programa de RSC (no es una subvención pública). Fuente vigilada: ${d.fuenteNombre}${d.tipo === 'agregador' ? ' (agregador de convocatorias)' : ''}`,
    `Página donde se ha visto: ${d.paginaUrl}`,
    d.enlacePropio && `Enlace de la convocatoria: ${d.enlacePropio}`,
    d.plazo && `Plazo (literal de la página): ${limpio(d.plazo)}`,
    d.importe && `Importe (literal de la página): ${limpio(d.importe)}`,
    d.extracto && `Texto de la página: ${limpio(d.extracto)}`,
  ].filter(Boolean).join('\n');
}

function documentos(c: Convocatoria): DocumentoFuente[] {
  const d = datosDe(c);
  if (!d) return [{ titulo: 'Ficha', url: c.url, texto: `Título: ${c.titulo}` }];
  const docs: DocumentoFuente[] = [{ titulo: 'Ficha de la fundación', url: c.url, texto: ficha(c, d) }];
  // La página o el PDF propios de la convocatoria (bases, requisitos) se descargan en el análisis.
  if (d.enlacePropio) docs.push({ titulo: 'Página de la convocatoria', url: d.enlacePropio });
  return docs;
}

function enlaces(c: Convocatoria): Enlace[] {
  const d = datosDe(c);
  const lista: Enlace[] = [{ tipo: 'ficha', titulo: d?.enlacePropio ? 'Página de la convocatoria' : `Página de ${d?.fuenteNombre ?? 'la fuente'}`, url: c.url }];
  if (d?.enlacePropio && d.paginaUrl !== d.enlacePropio) lista.push({ tipo: 'documento', titulo: `Visto en ${d.fuenteNombre}`, url: d.paginaUrl });
  return lista;
}

function datosPlazo(c: Convocatoria): DatosPlazo {
  const d = datosDe(c);
  return { fechaFin: null, textoFin: d?.plazo ?? null, textoInicio: null, publicaciones: [], registro: c.fechaPublicacion };
}

export const fundaciones: Fuente = crearFuenteFundaciones();
