// BOE de datos abiertos: sumario diario (JSON) y texto de cada resolución (XML). Hosts fijos (www.boe.es): las URLs se construyen
// a partir del identificador (que se valida), nunca se siguen enlaces del JSON.
//   Sumario: https://www.boe.es/datosabiertos/api/boe/sumario/AAAAMMDD  (Accept: application/json; 404 = ese día no hay BOE, p. ej. domingos)
//   Texto:   https://www.boe.es/diario_boe/xml.php?id=BOE-A-AAAA-NNNNN   (XML; el cuerpo está en <texto>, en HTML sencillo)
import { htmlATexto } from '../texto.ts';

const BASE = 'https://www.boe.es';
export const ID_BOE = /^BOE-[A-Z]-\d{4}-\d{1,7}$/;
const USER_AGENT = 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)';
const MAX_BYTES = 8 * 1024 * 1024;

export interface ItemBoe {
  id: string;
  titulo: string;
  /** Día de publicación, AAAA-MM-DD. */
  fecha: string;
}

export const enlaceBoe = (id: string): string => `${BASE}/diario_boe/txt.php?id=${id}`;

/** Título de una declaración o informe de impacto ambiental (no las correcciones de errores ni las declaraciones ambientales estratégicas de planes). */
export function esTituloDia(titulo: string): boolean {
  const t = titulo.toLowerCase();
  if (/corrig\w+ errores|correcci[oó]n de errores/.test(t)) return false;
  return /declaraci[oó]n de impacto ambiental|informe de impacto ambiental/.test(t);
}

const lista = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

/**
 * Items del sumario (JSON) que son DIA o informes de impacto ambiental de MITECO, en la sección III. El JSON del BOE es poco regular:
 * departamento, epígrafe e item son un objeto cuando hay uno y una lista cuando hay varios.
 */
export function itemsDia(sumario: unknown): ItemBoe[] {
  const s = (sumario as { data?: { sumario?: { metadatos?: { fecha_publicacion?: string }; diario?: unknown } } } | null)?.data?.sumario;
  const f = s?.metadatos?.fecha_publicacion ?? '';
  const fecha = /^\d{8}$/.test(f) ? `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6)}` : '';
  const salida: ItemBoe[] = [];
  type Nodo = Record<string, unknown>;
  for (const dia of lista(s?.diario as Nodo | Nodo[])) {
    for (const sec of lista(dia.seccion as Nodo | Nodo[])) {
      if (sec.codigo !== '3') continue;
      for (const dep of lista(sec.departamento as Nodo | Nodo[])) {
        if (dep.codigo !== '9575' && !/TRANSICI[ÓO]N ECOL[ÓO]GICA/i.test(String(dep.nombre ?? ''))) continue;
        for (const ep of lista(dep.epigrafe as Nodo | Nodo[])) {
          for (const it of lista(ep.item as Nodo | Nodo[])) {
            const id = String(it.identificador ?? '');
            const titulo = String(it.titulo ?? '');
            if (ID_BOE.test(id) && esTituloDia(titulo)) salida.push({ id, titulo, fecha });
          }
        }
      }
    }
  }
  return salida;
}

async function leer(f: typeof fetch, url: string, accept: string, timeoutMs: number): Promise<Response> {
  return f(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }); // una redirección es un error: no se sale de boe.es
}

async function cuerpo(res: Response): Promise<string> {
  const declarado = Number(res.headers.get('content-length') ?? 0);
  if (declarado > MAX_BYTES) throw new Error(`respuesta demasiado grande (${declarado} bytes)`);
  const texto = await res.text();
  if (texto.length > MAX_BYTES) throw new Error('respuesta demasiado grande');
  return texto;
}

/** Items DIA de un día (AAAA-MM-DD). `[]` si ese día no hay BOE (404). Otros fallos se lanzan. */
export async function sumarioDia(f: typeof fetch, dia: string, timeoutMs = 30_000): Promise<ItemBoe[]> {
  const res = await leer(f, `${BASE}/datosabiertos/api/boe/sumario/${dia.replaceAll('-', '')}`, 'application/json', timeoutMs);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`BOE sumario ${dia}: HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(await cuerpo(res));
  } catch (e) {
    throw new Error(`BOE sumario ${dia}: respuesta no válida (${(e as Error).message})`);
  }
  return itemsDia(json);
}

/** Texto de una resolución (solo el cuerpo, sin metadatos) como texto plano con un salto por párrafo. */
export async function textoResolucion(f: typeof fetch, id: string, timeoutMs = 30_000): Promise<string> {
  if (!ID_BOE.test(id)) throw new Error(`Identificador de BOE no válido: ${id}`);
  const res = await leer(f, `${BASE}/diario_boe/xml.php?id=${id}`, 'application/xml', timeoutMs);
  if (!res.ok) throw new Error(`BOE ${id}: HTTP ${res.status}`);
  const xml = await cuerpo(res);
  const m = /<texto>([\s\S]*?)<\/texto>/.exec(xml);
  if (!m) throw new Error(`BOE ${id}: la resolución no tiene texto`);
  return htmlATexto(m[1]);
}
