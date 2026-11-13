// Apoyo a los tests de fundaciones: páginas reales grabadas en test/fixtures/fundaciones/ y un fetch que las sirve.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIR_FUNDACIONES = join(import.meta.dirname, '..', 'fixtures', 'fundaciones');

/** Nombre del fichero de una página grabada: host + ruta. */
export function claveFundacion(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}`.replace(/[^A-Za-z0-9.]+/g, '_').replace(/_$/, '') + '.html';
}

export function paginaGrabada(url: string): string {
  const f = join(DIR_FUNDACIONES, claveFundacion(url));
  if (!existsSync(f)) throw new Error(`Sin grabación de ${url} (${f})`);
  return readFileSync(f, 'utf8');
}

/** Fetch falso: sirve las páginas de `paginas` (url → html, que puede cambiar entre pasadas) y cuenta las peticiones. */
export function fetchPaginas(paginas: Map<string, string | number>, peticiones: string[] = []): typeof fetch {
  return (async (entrada: string | URL | Request) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    peticiones.push(url);
    const p = paginas.get(url);
    if (p === undefined) return new Response('no encontrada', { status: 404 });
    if (typeof p === 'number') return new Response('error', { status: p });
    return new Response(p, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
}
