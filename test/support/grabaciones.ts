// Respuestas reales de BDNS grabadas en test/fixtures/bdns (ver scripts/record-bdns-fixtures.ts).
// `fetchGrabado` las sirve como un fetch falso; una URL sin grabar falla, para que el test lo note.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIR_GRABACIONES = join(import.meta.dirname, '..', 'fixtures', 'bdns');
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
  return `${ruta}${params ? `__${params}` : ''}`.replace(/[^\w=.-]+/g, '_') + '.json';
}

export function fetchGrabado(): typeof fetch {
  return (async (entrada: string | URL | Request) => {
    const url = entrada instanceof Request ? entrada.url : String(entrada);
    const documento = join(DIR_DOCUMENTOS, claveDocumento(url));
    if (existsSync(documento)) return new Response(readFileSync(documento), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    const fichero = join(DIR_GRABACIONES, claveGrabacion(url));
    if (!existsSync(fichero)) throw new Error(`Sin grabación para ${url} (${fichero})`);
    return new Response(readFileSync(fichero), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
