// Fuente BDNS (Base de Datos Nacional de Subvenciones), API pública sin autenticación.
// 1. Listado de convocatorias recibidas en la ventana de días.
// 2. Mismo listado filtrado por cada región del perfil, para saber qué órganos locales son de esas regiones
//    (el listado no trae región y pedir el detalle de todas sería caro).
// 3. Criba con lo que trae el listado; solo de lo que sobrevive se pide el detalle, y se vuelve a cribar.
import { aFechaBdns, diaLocal, sumarDias } from '../dates.ts';
import type { DatosPlazo } from '../plazos.ts';
import type { Convocatoria, Cribada } from '../types.ts';
import { htmlATexto } from '../texto.ts';
import type { ContextoFuente, DocumentoFuente, Enlace, Fuente, ResultadoFuente } from './source.ts';

export const BDNS_API = 'https://www.infosubvenciones.es/bdnstrans/api';
const FICHA = 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/';
export const USER_AGENT = 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)';
const TAM_PAGINA = 1000;
const DETALLES_EN_PARALELO = 2;
const REINTENTOS = 4; // BDNS responde 429 si se le pide deprisa
const TIMEOUT_MS = 60_000;

interface ItemListado {
  id: number;
  numeroConvocatoria: string;
  descripcion: string;
  fechaRecepcion: string;
  nivel1: string;
  nivel2: string | null;
  nivel3: string | null;
}

interface PaginaListado {
  content: ItemListado[];
  last: boolean;
}

interface NodoRegion {
  id: number;
  descripcion: string;
  children: NodoRegion[];
}

interface Detalle {
  codigoBDNS: string;
  descripcion: string;
  fechaRecepcion: string;
  organo: { nivel1: string; nivel2: string | null; nivel3: string | null };
  tipoConvocatoria: string | null;
  descripcionFinalidad: string | null;
  regiones: { descripcion: string }[] | null;
  abierto: boolean | null;
  // Para la criba y el análisis (pueden faltar en detalles antiguos):
  sedeElectronica?: string | null;
  presupuestoTotal?: number | null;
  descripcionBasesReguladoras?: string | null;
  urlBasesReguladoras?: string | null;
  fechaInicioSolicitud?: string | null;
  fechaFinSolicitud?: string | null;
  textInicio?: string | null;
  textFin?: string | null;
  documentos?: { id: number; descripcion: string | null; nombreFic: string | null }[] | null;
  anuncios?: { titulo: string | null; texto: string | null; url: string | null; cve: string | null; desDiarioOficial: string | null; datPublicacion: string | null }[] | null;
}

export async function getJson<T>(f: typeof fetch, ruta: string, params: Record<string, string | number> = {}): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const url = `${BDNS_API}${ruta}${qs.size ? `?${qs}` : ''}`;
  for (let intento = 0; ; intento++) {
    const res = await f(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 429 || res.status >= 500) && intento < REINTENTOS) {
      const espera = Number(res.headers.get('Retry-After')) * 1000 || 1000 * 2 ** intento;
      await new Promise((r) => setTimeout(r, Math.min(espera, 30_000)));
      continue;
    }
    throw new Error(`BDNS ${res.status} en ${ruta}`);
  }
}

async function listarTodo(f: typeof fetch, filtros: Record<string, string | number>): Promise<ItemListado[]> {
  const items: ItemListado[] = [];
  for (let page = 0; ; page++) {
    const p = await getJson<PaginaListado>(f, '/convocatorias/busqueda', {
      page, pageSize: TAM_PAGINA, order: 'fechaRecepcion', direccion: 'desc', ...filtros,
    });
    items.push(...p.content);
    if (p.last || p.content.length === 0) return items;
  }
}

/** "ES30 - COMUNIDAD DE MADRID" → "ES30" */
function codigoRegion(descripcion: string): string {
  return descripcion.split(' - ')[0].trim();
}

function idsDeRegiones(arbol: NodoRegion[], codigos: string[]): Map<number, string> {
  const ids = new Map<number, string>();
  const visitar = (nodos: NodoRegion[]) => {
    for (const n of nodos) {
      const codigo = codigoRegion(n.descripcion);
      if (codigos.includes(codigo)) ids.set(n.id, codigo);
      visitar(n.children ?? []);
    }
  };
  visitar(arbol);
  return ids;
}

function desdeListado(item: ItemListado, regiones: string[]): Convocatoria {
  return {
    id: `bdns:${item.numeroConvocatoria}`,
    fuente: 'bdns',
    fuenteId: item.numeroConvocatoria,
    titulo: item.descripcion.trim(),
    organo: { nivel1: item.nivel1, nivel2: item.nivel2, nivel3: item.nivel3 },
    fechaPublicacion: item.fechaRecepcion,
    url: FICHA + item.numeroConvocatoria,
    tipo: null,
    finalidad: null,
    regiones,
    abierto: null,
    datos: { listado: item },
  };
}

function conDetalle(c: Convocatoria, d: Detalle): Convocatoria {
  const regionesDetalle = (d.regiones ?? []).map((r) => codigoRegion(r.descripcion));
  return {
    ...c,
    titulo: d.descripcion?.trim() || c.titulo,
    organo: d.organo ?? c.organo,
    tipo: d.tipoConvocatoria,
    finalidad: d.descripcionFinalidad,
    regiones: [...new Set([...c.regiones, ...regionesDetalle])],
    abierto: d.abierto,
    datos: { ...(c.datos as object), detalle: d },
  };
}

/** Una convocatoria conocida solo por su número y datos de listado/búsqueda, completada con su detalle (como hace la fuente con las candidatas). */
export async function convocatoriaConDetalle(
  f: typeof fetch, item: { numeroConvocatoria: string; descripcion: string; fechaRecepcion: string; nivel1: string | null; nivel2: string | null; nivel3: string | null },
): Promise<Convocatoria> {
  const c = desdeListado({ id: 0, ...item, nivel1: item.nivel1 ?? '' }, []);
  return conDetalle(c, await getJson<Detalle>(f, '/convocatorias', { numConv: item.numeroConvocatoria }));
}

/** Una convocatoria por su número, solo con su detalle (el backtest no pasa por el listado). */
export async function convocatoriaDeNumero(f: typeof fetch, numero: string): Promise<Convocatoria> {
  const d = await getJson<Detalle>(f, '/convocatorias', { numConv: numero });
  const base = desdeListado({
    id: 0, numeroConvocatoria: numero, descripcion: d.descripcion ?? '', fechaRecepcion: d.fechaRecepcion,
    nivel1: d.organo?.nivel1 ?? '', nivel2: d.organo?.nivel2 ?? null, nivel3: d.organo?.nivel3 ?? null,
  }, []);
  return conDetalle(base, d);
}

async function enParalelo<T>(items: T[], n: number, tarea: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const trabajador = async () => {
    while (i < items.length) await tarea(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, trabajador));
}

async function recoger(ctx: ContextoFuente): Promise<ResultadoFuente> {
  const hasta = diaLocal(ctx.ahora);
  const desde = sumarDias(hasta, -(ctx.diasAtras - 1));
  const ventana = { fechaDesde: aFechaBdns(desde), fechaHasta: aFechaBdns(hasta) };

  const listado = await listarTodo(ctx.fetch, ventana);

  const regionesPorConvocatoria = new Map<string, string[]>();
  if (ctx.perfil.ambito.regiones.length) {
    const arbol = await getJson<NodoRegion[]>(ctx.fetch, '/regiones');
    for (const [id, codigo] of idsDeRegiones(arbol, ctx.perfil.ambito.regiones)) {
      for (const item of await listarTodo(ctx.fetch, { ...ventana, regiones: id })) {
        const r = regionesPorConvocatoria.get(item.numeroConvocatoria) ?? [];
        regionesPorConvocatoria.set(item.numeroConvocatoria, [...r, codigo]);
      }
    }
  }

  const cribadas: Cribada[] = [];
  const pendientes: Convocatoria[] = [];
  const vistas = new Set<string>();
  for (const item of listado) {
    if (vistas.has(item.numeroConvocatoria)) continue; // el paginado puede repetir si entran nuevas durante la lectura
    vistas.add(item.numeroConvocatoria);
    const c = desdeListado(item, regionesPorConvocatoria.get(item.numeroConvocatoria) ?? []);
    const descarte = ctx.cribar(c);
    if (descarte) cribadas.push({ convocatoria: c, descarte });
    else pendientes.push(c);
  }

  const errores: string[] = [];
  await enParalelo(pendientes, DETALLES_EN_PARALELO, async (c) => {
    try {
      const d = await getJson<Detalle>(ctx.fetch, '/convocatorias', { numConv: c.fuenteId });
      const completa = conDetalle(c, d);
      cribadas.push({ convocatoria: completa, descarte: ctx.cribar(completa) });
    } catch (e) {
      errores.push(`Detalle ${c.fuenteId}: ${(e as Error).message}`);
    }
  });

  return { cribadas, errores };
}

/** URL de descarga de un documento adjunto a una convocatoria (comprobada en vivo: devuelve el PDF). */
export function urlDocumentoBdns(idDocumento: number): string {
  return `${BDNS_API}/convocatorias/documentos?idDocumento=${idDocumento}`;
}

function detalleDe(c: Convocatoria): Detalle | null {
  return ((c.datos as { detalle?: Detalle } | null)?.detalle) ?? null;
}

const esUrl = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u.trim());

/**
 * Ficha de metadatos para el LLM. Deliberadamente sin `tiposBeneficiarios` ni sectores: en BDNS son poco fiables
 * (la 923290 dice "personas físicas" y es para ONG) y la elegibilidad se decide por el texto.
 */
function fichaMetadatos(c: Convocatoria, d: Detalle): string {
  const lineas = [
    `Título: ${c.titulo}`,
    `Órgano convocante: ${[c.organo.nivel1, c.organo.nivel2, c.organo.nivel3].filter(Boolean).join(' · ')}`,
    `Código BDNS: ${c.fuenteId}`,
    `Fecha de registro en BDNS: ${c.fechaPublicacion}`,
    d.tipoConvocatoria && `Tipo de convocatoria: ${d.tipoConvocatoria}`,
    d.descripcionFinalidad && `Finalidad: ${d.descripcionFinalidad}`,
    d.presupuestoTotal != null && `Presupuesto total: ${d.presupuestoTotal} €`,
    d.fechaInicioSolicitud && `Inicio de solicitudes: ${d.fechaInicioSolicitud}`,
    d.fechaFinSolicitud && `Fin de solicitudes: ${d.fechaFinSolicitud}`,
    d.textInicio && `Inicio del plazo (texto): ${d.textInicio}`,
    d.textFin && `Fin del plazo (texto): ${d.textFin}`,
    d.descripcionBasesReguladoras && `Bases reguladoras: ${d.descripcionBasesReguladoras}`,
    d.regiones?.length && `Regiones: ${d.regiones.map((r) => r.descripcion.trim()).join(', ')}`,
  ];
  return lineas.filter(Boolean).join('\n');
}

function documentos(c: Convocatoria): DocumentoFuente[] {
  const d = detalleDe(c);
  if (!d) return [{ titulo: 'Ficha BDNS', url: c.url, texto: `Título: ${c.titulo}` }];
  const docs: DocumentoFuente[] = [{ titulo: 'Ficha BDNS', url: c.url, texto: fichaMetadatos(c, d) }];
  for (const a of d.anuncios ?? []) {
    if (!a.texto) continue;
    const titulo = `Extracto ${a.cve ?? ''}`.trim();
    docs.push({ titulo, url: esUrl(a.url) ? a.url : null, texto: [a.titulo, htmlATexto(a.texto)].filter(Boolean).join('\n\n') });
  }
  for (const doc of d.documentos ?? []) {
    docs.push({ titulo: `Documento: ${doc.descripcion ?? doc.nombreFic ?? doc.id}`, url: urlDocumentoBdns(doc.id) });
  }
  if (esUrl(d.urlBasesReguladoras)) docs.push({ titulo: 'Bases reguladoras', url: d.urlBasesReguladoras.trim() });
  return docs;
}

function enlaces(c: Convocatoria): Enlace[] {
  const d = detalleDe(c);
  const r: Enlace[] = [{ tipo: 'ficha', titulo: 'Ficha en BDNS', url: c.url }];
  if (!d) return r;
  if (esUrl(d.urlBasesReguladoras)) r.push({ tipo: 'bases', titulo: d.descripcionBasesReguladoras?.trim() || 'Bases reguladoras', url: d.urlBasesReguladoras.trim() });
  for (const a of d.anuncios ?? []) {
    if (esUrl(a.url)) r.push({ tipo: 'extracto', titulo: [a.desDiarioOficial, a.cve, a.datPublicacion].filter(Boolean).join(' · ') || 'Extracto', url: a.url });
  }
  if (esUrl(d.sedeElectronica)) r.push({ tipo: 'sede', titulo: 'Sede electrónica', url: d.sedeElectronica.trim() });
  for (const doc of d.documentos ?? []) {
    r.push({ tipo: 'documento', titulo: doc.descripcion ?? doc.nombreFic ?? `Documento ${doc.id}`, url: urlDocumentoBdns(doc.id) });
  }
  return r;
}

const soloDia = (f: string | null | undefined): string | null => (f && /^\d{4}-\d{2}-\d{2}/.test(f) ? f.slice(0, 10) : null);

function datosPlazo(c: Convocatoria): DatosPlazo {
  const d = detalleDe(c);
  return {
    fechaFin: soloDia(d?.fechaFinSolicitud),
    textoFin: d?.textFin?.trim() || null,
    textoInicio: d?.textInicio?.trim() || null,
    publicaciones: (d?.anuncios ?? []).flatMap((a) => {
      const dia = soloDia(a.datPublicacion);
      return dia ? [{ dia, diario: a.desDiarioOficial }] : [];
    }),
    registro: c.fechaPublicacion,
  };
}

export const bdns: Fuente = { nombre: 'bdns', recoger, documentos, enlaces, datosPlazo };
