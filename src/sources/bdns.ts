// Fuente BDNS (Base de Datos Nacional de Subvenciones), API pública sin autenticación.
// 1. Listado de convocatorias recibidas en la ventana de días.
// 2. Mismo listado filtrado por cada región del perfil, para saber qué órganos locales son de esas regiones
//    (el listado no trae región y pedir el detalle de todas sería caro).
// 3. Criba con lo que trae el listado; solo de lo que sobrevive se pide el detalle, y se vuelve a cribar.
import { aFechaBdns, diaLocal, sumarDias } from '../dates.ts';
import type { Convocatoria, Cribada } from '../types.ts';
import type { ContextoFuente, Fuente, ResultadoFuente } from './source.ts';

export const BDNS_API = 'https://www.infosubvenciones.es/bdnstrans/api';
const FICHA = 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/';
const USER_AGENT = 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)';
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
}

async function getJson<T>(f: typeof fetch, ruta: string, params: Record<string, string | number> = {}): Promise<T> {
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

export const bdns: Fuente = { nombre: 'bdns', recoger };
