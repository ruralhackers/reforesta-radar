// Respuestas reales de BDNS grabadas en test/fixtures/bdns (ver scripts/record-bdns-fixtures.ts).
// `fetchGrabado` las sirve como un fetch falso; una URL sin grabar falla, para que el test lo note.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIR_GRABACIONES = join(import.meta.dirname, '..', 'fixtures', 'bdns');
/** Concesiones (ganadores) y búsquedas de ediciones grabadas: solo las sirve `fetchGrabado({ concesiones: true })`. */
export const DIR_CONCESIONES = join(import.meta.dirname, '..', 'fixtures', 'bdns-concesiones');
/** Respuestas de la búsqueda SEDIA de EU Funding & Tenders (ver scripts/record-eu-ft.ts). */
export const DIR_EU_FT = join(import.meta.dirname, '..', 'fixtures', 'eu-ft');
/** Reloj con el que se grabó EU F&T: la consulta lleva la fecha de hoy (deadlineDate >= hoy), así que las grabaciones valen para este día. */
export const AHORA_EU_FT = new Date('2026-11-13T09:00:00Z');
/** Documentos descargados (PDF de BDNS, bases en BOE…), tal cual llegan. */
export const DIR_DOCUMENTOS = join(import.meta.dirname, '..', 'fixtures', 'documentos');

/** Escenarios grabados: un reloj fijo y una ventana de días. */
export const ESCENARIOS = {
  /** Ventana con la 923290 (MITECO, línea A interés social), recibida el 2026-08-03. */
  agosto2026: { ahora: new Date('2026-08-04T08:00:00Z'), diasAtras: 2 },
  /** Ventana con la 825309 (CAM, ESFL proyectos ambientales 2025), recibida el 2025-04-07. */
  abril2025: { ahora: new Date('2025-04-08T08:00:00Z'), diasAtras: 2 },
} as const;

/** Convocatorias cuyos documentos (PDF, bases) están grabados para el análisis. */
export const CON_DOCUMENTOS = ['923290', '923289', '923292'];

/** Nombre de fichero estable para un documento: host + ruta + consulta. */
export function claveDocumento(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}${u.search}`.replace(/[^\w=.-]+/g, '_');
}

/** Nombre de fichero estable para una URL de la API (ruta + parámetros ordenados). */
export function claveGrabacion(url: string): string {
  const u = new URL(url);
  const ruta = u.pathname.replace(/^\/bdnstrans\/api\//, '');
  const params = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
  const base = `${ruta}${params ? `__${params}` : ''}`.replace(/[^\w=.-]+/g, '_');
  // Los nombres de fichero tienen tope (255): las búsquedas por títulos largos se acortan con un hash para seguir siendo únicas.
  return (base.length > 180 ? `${base.slice(0, 140)}__${createHash('sha1').update(base).digest('hex').slice(0, 16)}` : base) + '.json';
}

export const esSedia = (url: string) => new URL(url).host === 'api.tech.ec.europa.eu';

/** Nombre de fichero de una página SEDIA: número de página + hash del texto y de la consulta (el cuerpo multipart). */
export async function claveSedia(url: string, init?: RequestInit): Promise<string> {
  const u = new URL(url);
  const parte = init?.body instanceof FormData ? init.body.get('query') : null;
  const consulta = parte && typeof parte !== 'string' ? await parte.text() : String(parte ?? '');
  const hash = createHash('sha1').update(`${u.searchParams.get('text')}|${consulta}`).digest('hex').slice(0, 10);
  return `sedia_p${u.searchParams.get('pageNumber')}_${hash}.json`;
}

const paginaVacia = () => new Response(JSON.stringify({ content: [], last: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** ¿Es una consulta de la fase de ganadores (concesiones o búsqueda de ediciones por título)? */
export function esConsultaDeGanadores(url: string): boolean {
  const u = new URL(url);
  return u.pathname.endsWith('/concesiones/busqueda') || (u.pathname.endsWith('/convocatorias/busqueda') && u.searchParams.has('descripcion'));
}

/**
 * Fetch falso con las grabaciones. Las consultas de ganadores (concesiones, búsqueda de ediciones) devuelven una página vacía,
 * para que los tests que no tratan de ellas no dependan de las grabaciones de concesiones; con `concesiones: true` se sirven
 * las grabadas en DIR_CONCESIONES (y una sin grabar falla).
 */
export function fetchGrabado({ concesiones = false, euFt = false, euCascada = false }: { concesiones?: boolean; euFt?: boolean; euCascada?: boolean } = {}): typeof fetch {
  return (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = entrada instanceof Request ? entrada.url : String(entrada);
    if (esSedia(url)) {
      // EU Funding & Tenders: sin `euFt`, una página vacía (los tests de BDNS no dependen de esta fuente).
      // Las convocatorias en cascada (type 8) las sirve `euCascada`; el resto de la API SEDIA, `euFt`.
      const parte = init?.body instanceof FormData ? init.body.get('query') : null;
      const esCascada = parte && typeof parte !== 'string' ? JSON.parse(await parte.text()).bool?.must?.some((m: { terms?: { type?: string[] } }) => m.terms?.type?.includes('8')) : false;
      if (esCascada ? !euCascada : !euFt) return new Response(JSON.stringify({ totalResults: 0, results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const f = join(DIR_EU_FT, await claveSedia(url, init));
      if (!existsSync(f)) throw new Error(`Sin grabación de EU F&T para ${url} (${f})`);
      return new Response(readFileSync(f), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (esConsultaDeGanadores(url)) {
      if (!concesiones) return paginaVacia();
      const f = join(DIR_CONCESIONES, claveGrabacion(url));
      if (!existsSync(f)) throw new Error(`Sin grabación de concesiones para ${url} (${f})`);
      return new Response(readFileSync(f), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const documento = join(DIR_DOCUMENTOS, claveDocumento(url));
    if (existsSync(documento)) return new Response(readFileSync(documento), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    const fichero = join(DIR_GRABACIONES, claveGrabacion(url));
    if (!existsSync(fichero)) throw new Error(`Sin grabación para ${url} (${fichero})`);
    return new Response(readFileSync(fichero), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
