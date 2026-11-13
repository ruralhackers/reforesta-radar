// Modo privado (TEAM_PASSWORD). Una sola pieza reutilizable: `requiereEquipo`.
//
// - Sin contraseña (variable ausente o vacía): modo demo, `requiereEquipo` deja pasar todo y todo está abierto.
// - Con contraseña: lo privado devuelve 401 sin sesión. Se entra con POST /api/sesion {password}, que da una cookie
//   firmada, HttpOnly y SameSite=Lax de larga duración (180 días). DELETE /api/sesion sale. GET /api/sesion dice
//   { modoPrivado, autenticado } para que la web se adapte.
//
// CÓMO MARCAR UNA RUTA COMO PRIVADA (Tasks 12, 13...): ponla en un sub-router propio y móntalo tras el middleware:
//     const privadaX = new Hono();
//     privadaX.use('*', acceso.requiereEquipo);   // una línea
//     privadaX.put('/', ...);
//     api.route('/x', privadaX);
//   Lo público (GET que debe verse sin entrar) va en `api` directamente y NUNCA devuelve decisiones ni notas.
//
// Clave de firma: HMAC-SHA256 derivada de TEAM_PASSWORD y SESSION_SECRET (opcional). Cambiar TEAM_PASSWORD (o el secreto)
// invalida todas las cookies antiguas. Sin SESSION_SECRET la clave depende solo de la contraseña: pon un secreto largo
// y aleatorio para que la cookie no se pueda fabricar a partir de una contraseña adivinada.
//
// Fuerza bruta: pausa fija ante contraseña errónea y límite en memoria por IP (10 intentos fallidos / 15 min → 429).
// El intento se reserva de forma síncrona antes de leer el cuerpo (las ráfagas en paralelo no lo esquivan) y se libera
// si la contraseña es buena. No hay bloqueo global: una contraseña correcta nunca se rechaza por los fallos de otras IP.
// IP del cliente: CF-Connecting-IP (Cloudflare Tunnel); X-Forwarded-For (último salto) / X-Real-IP solo si
// RADAR_CONFIAR_X_FORWARDED_FOR=1; si no hay cabecera, la dirección del socket. Se reinicia con el proceso.
//
// CSRF: SameSite=Lax impide que otra web envíe la cookie en POST/PUT/DELETE, y además las escrituras exigen
// Content-Type: application/json (un formulario HTML cruzado no puede enviarlo sin pasar por CORS). Suficiente aquí.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export interface OpcionesEquipo {
  /** Contraseña del equipo; vacía o ausente = modo demo (todo abierto). */
  password?: string | null;
  /** Secreto extra para derivar la clave de firma. */
  secret?: string | null;
  /** Pausa (ms) ante contraseña errónea. */
  retrasoMs?: number;
  /** Fuerza la marca Secure de la cookie; por defecto, la petición es https (o X-Forwarded-Proto: https). */
  secure?: boolean;
  /** Fiarse de X-Forwarded-For / X-Real-IP para la IP del cliente (solo detrás de un proxy propio que los fije). */
  confiarXForwardedFor?: boolean;
  /** Duración de la sesión en días. */
  dias?: number;
}

const COOKIE = 'radar_equipo';
const VENTANA_MS = 15 * 60 * 1000;
const MAX_POR_IP = 10;

const sha = (s: string) => createHash('sha256').update(s).digest();
const igualesEnTiempoConstante = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

export function crearAcceso(opciones: OpcionesEquipo = {}) {
  const password = opciones.password || null;
  const modoPrivado = password !== null;
  const dias = opciones.dias ?? 180;
  const retrasoMs = opciones.retrasoMs ?? 500;
  const clave = password ? createHmac('sha256', opciones.secret ?? '').update(`radar-equipo:${password}`).digest() : null;
  const firmar = (texto: string) => createHmac('sha256', clave!).update(texto).digest('base64url');

  const crearCookie = (ahora: number) => {
    const caduca = ahora + dias * 86_400_000;
    return `${caduca}.${firmar(`v1.${caduca}`)}`;
  };
  const cookieValida = (valor: string | undefined, ahora: number): boolean => {
    if (!clave || !valor) return false;
    const [caduca, firma, ...resto] = valor.split('.');
    if (!caduca || !firma || resto.length || !/^\d+$/.test(caduca) || Number(caduca) < ahora) return false;
    return igualesEnTiempoConstante(firma, firmar(`v1.${caduca}`));
  };
  const autenticado = (c: Parameters<MiddlewareHandler>[0]) => !modoPrivado || cookieValida(getCookie(c, COOKIE), Date.now());

  const exigirJson = (c: Parameters<MiddlewareHandler>[0]) =>
    ['POST', 'PUT', 'PATCH'].includes(c.req.method) && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json');

  /** Middleware de lo privado: sin contraseña configurada no hace nada. Ver la cabecera del fichero. */
  const requiereEquipo: MiddlewareHandler = async (c, next) => {
    if (!modoPrivado) return next();
    if (!autenticado(c)) return c.json({ error: 'Hace falta la contraseña del equipo' }, 401);
    if (exigirJson(c)) return c.json({ error: 'Las escrituras deben enviarse como application/json' }, 415);
    return next();
  };

  // --- /api/sesion ---
  const intentos = new Map<string, number[]>();
  const reciente = (ts: number[], ahora: number) => ts.filter((t) => ahora - t < VENTANA_MS);
  const ipDe = (c: Parameters<MiddlewareHandler>[0]): string => {
    const cf = c.req.header('cf-connecting-ip')?.trim();
    if (cf) return cf;
    if (opciones.confiarXForwardedFor) {
      const x = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || c.req.header('x-real-ip')?.trim();
      if (x) return x;
    }
    try { return getConnInfo(c).remote.address ?? 'desconocida'; } catch { return 'desconocida'; }
  };

  const sesion = new Hono();
  sesion.get('/', (c) => c.json({ modoPrivado, autenticado: autenticado(c) }));
  sesion.post('/', async (c) => {
    if (!modoPrivado) return c.json({ modoPrivado, autenticado: true });
    if (exigirJson(c)) return c.json({ error: 'Debe enviarse como application/json' }, 415);
    const ahora = Date.now();
    const ip = ipDe(c);
    // Poda: fuera las IP sin intentos recientes.
    for (const [k, ts] of intentos) { const v = reciente(ts, ahora); if (v.length) intentos.set(k, v); else intentos.delete(k); }
    const previos = intentos.get(ip) ?? [];
    if (previos.length >= MAX_POR_IP) return c.json({ error: 'Demasiados intentos; prueba más tarde' }, 429);
    // Reserva síncrona (antes de cualquier await): si la contraseña es buena se libera.
    const reserva = ahora + Math.random();
    intentos.set(ip, [...previos, reserva]);
    const cuerpo = await c.req.json().catch(() => null) as { password?: unknown } | null;
    const intento = typeof cuerpo?.password === 'string' ? cuerpo.password : '';
    if (!igualesEnTiempoConstante(intento, password!)) {
      if (retrasoMs > 0) await new Promise((r) => setTimeout(r, retrasoMs));
      return c.json({ error: 'Contraseña incorrecta' }, 401);
    }
    const resto = (intentos.get(ip) ?? []).filter((t) => t !== reserva);
    if (resto.length) intentos.set(ip, resto); else intentos.delete(ip);
    const secure = opciones.secure ?? (new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https');
    setCookie(c, COOKIE, crearCookie(ahora), { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: dias * 86_400 });
    return c.json({ modoPrivado, autenticado: true });
  });
  sesion.delete('/', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ modoPrivado, autenticado: !modoPrivado });
  });

  return { modoPrivado, requiereEquipo, sesion };
}
