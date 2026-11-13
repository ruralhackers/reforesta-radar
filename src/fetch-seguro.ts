// Descarga segura de URLs que salen de DATOS (páginas de fundaciones, enlaces extraídos de ellas, documentos de BDNS/UE): el servidor las
// pide desde la misma máquina que otros servicios, así que no pueden llevarlo a direcciones internas (SSRF). Los hosts fijos de APIs
// (infosubvenciones, SEDIA, Anthropic, Resend) no pasan por aquí.
//
//  - Solo http y https, sin credenciales en la URL.
//  - Cada salto (la URL inicial y cada redirección, a mano con `redirect: 'manual'`, máximo MAX_SALTOS) se valida: si el host es una IP, se
//    comprueba directamente (las formas decimal/hexadecimal las normaliza el parser de URL); si es un nombre, se resuelve por DNS (todas
//    las direcciones, A y AAAA) y se rechaza si ALGUNA es de loopback, red privada, enlace local, CGNAT, ULA, sin especificar, multicast,
//    reservada, o IPv6 mapeada (::ffff:a.b.c.d, que Node compara con las reglas IPv4) o NAT64 hacia cualquiera de ellas.
//  - El cuerpo se lee por streaming y se aborta al pasar `maxBytes` (no se confía en Content-Length).
//
// Límite conocido: la comprobación y la conexión resuelven el DNS por separado (ventana de "DNS rebinding"); con el `fetch` global no se
// puede fijar la IP validada sin una dependencia nueva. La ventana es de milisegundos y el atacante solo vería texto que va al LLM.
// La resolución DNS solo se hace con el `fetch` real: con un fetch inyectado (tests) no hay red y se usa el `resolver` si se da.
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export const MAX_SALTOS = 5;

export class ErrorUrlBloqueada extends Error {}
export class ErrorTamano extends Error {}

export type Resolver = (host: string) => Promise<string[]>;

export const resolverDns: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const PROHIBIDAS = new BlockList();
for (const [red, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PROHIBIDAS.addSubnet(red, bits, 'ipv4');
for (const [red, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) PROHIBIDAS.addSubnet(red, bits, 'ipv6');

export function ipProhibida(ip: string): boolean {
  const v = isIP(ip);
  if (!v) return true; // lo que no es una IP válida no se admite
  return PROHIBIDAS.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

function hostSinCorchetes(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '');
}

/** Comprobación sin red: esquema, credenciales, IP literal y nombres claramente internos. Sirve para validar al guardar y al extraer. */
export function urlPermitidaSintactica(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const h = hostSinCorchetes(u);
    if (isIP(h)) return !ipProhibida(h);
    return h.includes('.') && !/\.(local|internal|localhost|lan|home|corp|intranet)$/i.test(h);
  } catch {
    return false;
  }
}

async function validarSalto(url: URL, resolver: Resolver | null): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ErrorUrlBloqueada(`esquema no permitido (${url.protocol})`);
  if (url.username || url.password) throw new ErrorUrlBloqueada('URL con credenciales');
  const h = hostSinCorchetes(url);
  if (isIP(h)) {
    if (ipProhibida(h)) throw new ErrorUrlBloqueada(`dirección no permitida (${h})`);
    return;
  }
  if (!h.includes('.') || /\.(local|internal|localhost|lan)$/i.test(h)) throw new ErrorUrlBloqueada(`nombre de host interno (${h})`);
  if (!resolver) return;
  let direcciones: string[];
  try {
    direcciones = await resolver(h);
  } catch (e) {
    throw new Error(`no se pudo resolver ${h}: ${(e as Error).message}`);
  }
  if (direcciones.length === 0) throw new Error(`no se pudo resolver ${h}`);
  const mala = direcciones.find(ipProhibida);
  if (mala) throw new ErrorUrlBloqueada(`${h} resuelve a una dirección no permitida (${mala})`);
}

export interface OpcionesFetchSeguro {
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  /** DNS. Por defecto, el del sistema con el fetch real y ninguno con un fetch inyectado (tests). */
  resolver?: Resolver | null;
  maxSaltos?: number;
}

export interface RespuestaSegura {
  status: number;
  ok: boolean;
  tipoContenido: string;
  bytes: Uint8Array;
  /** URL final tras las redirecciones. */
  url: string;
}

async function leerLimitado(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declarado = Number(res.headers.get('content-length') ?? 0);
  if (declarado > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ErrorTamano(`demasiado grande (${declarado} bytes)`);
  }
  if (!res.body) return new Uint8Array(0);
  const lector = res.body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await lector.cancel().catch(() => {});
      throw new ErrorTamano(`demasiado grande (más de ${maxBytes} bytes)`);
    }
    trozos.push(value);
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const t of trozos) { bytes.set(t, o); o += t.byteLength; }
  return bytes;
}

export async function fetchSeguro(f: typeof fetch, url: string, o: OpcionesFetchSeguro): Promise<RespuestaSegura> {
  const resolver = o.resolver === undefined ? (f === globalThis.fetch ? resolverDns : null) : o.resolver;
  const limite = o.maxSaltos ?? MAX_SALTOS;
  const senal = AbortSignal.timeout(o.timeoutMs);
  let actual: URL;
  try {
    actual = new URL(url);
  } catch {
    throw new ErrorUrlBloqueada('URL no válida');
  }
  for (let salto = 0; ; salto++) {
    await validarSalto(actual, resolver);
    const res = await f(actual.toString(), { headers: o.headers, redirect: 'manual', signal: senal });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {});
      if (salto >= limite) throw new Error(`demasiadas redirecciones (más de ${limite})`);
      try {
        actual = new URL(res.headers.get('location')!, actual);
      } catch {
        throw new ErrorUrlBloqueada('redirección a una URL no válida');
      }
      continue;
    }
    const tipoContenido = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, ok: false, tipoContenido, bytes: new Uint8Array(0), url: actual.toString() };
    }
    return { status: res.status, ok: true, tipoContenido, bytes: await leerLimitado(res, o.maxBytes), url: actual.toString() };
  }
}
