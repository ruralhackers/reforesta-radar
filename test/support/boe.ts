// Apoyo a los tests de empresas: sumarios y resoluciones reales del BOE grabados en test/fixtures/boe/ (ver scripts/record-boe.ts) y un fetch que los sirve.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIR_BOE = join(import.meta.dirname, '..', 'fixtures', 'boe');

/** Sumario grabado de un día (AAAAMMDD) o undefined. */
export function sumarioGrabado(dia: string): string | undefined {
  const f = join(DIR_BOE, `sumario-${dia}.json`);
  return existsSync(f) ? readFileSync(f, 'utf8') : undefined;
}

export function resolucionGrabada(id: string): string | undefined {
  const f = join(DIR_BOE, `${id}.xml`);
  return existsSync(f) ? readFileSync(f, 'utf8') : undefined;
}

export interface OpcionesFetchBoe {
  /** Sumarios o resoluciones que sustituyen o añaden a los grabados: clave = URL completa. `number` = ese estado HTTP. */
  extra?: Map<string, string | number>;
  peticiones?: string[];
}

/** Fetch falso del BOE: sumarios y resoluciones grabados; un día sin grabar responde 404 (como un día sin BOE). */
export function fetchBoe({ extra = new Map(), peticiones = [] }: OpcionesFetchBoe = {}): typeof fetch {
  return (async (entrada: string | URL | Request) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    peticiones.push(url);
    const e = extra.get(url);
    if (typeof e === 'number') return new Response('error', { status: e });
    if (typeof e === 'string') return new Response(e, { status: 200 });
    const dia = /\/sumario\/(\d{8})$/.exec(url)?.[1];
    if (dia) {
      const s = sumarioGrabado(dia);
      return s ? new Response(s, { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('{"status":{"code":"404"}}', { status: 404 });
    }
    const id = /xml\.php\?id=(BOE-[A-Z0-9-]+)$/.exec(url)?.[1];
    const r = id && resolucionGrabada(id);
    return r ? new Response(r, { status: 200, headers: { 'Content-Type': 'application/xml' } }) : new Response('no encontrado', { status: 404 });
  }) as typeof fetch;
}

export const urlSumario = (dia: string) => `https://www.boe.es/datosabiertos/api/boe/sumario/${dia.replaceAll('-', '')}`;
export const urlResolucion = (id: string) => `https://www.boe.es/diario_boe/xml.php?id=${id}`;
