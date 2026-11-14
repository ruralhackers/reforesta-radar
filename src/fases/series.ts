// Fase `series` (determinista, sin LLM): para las series de las convocatorias relevantes (pasaron la criba y siguen en juego, o pedidas con
// `npm run cargar`), trae de BDNS el detalle de sus ediciones pasadas que aún no están guardadas (fecha de publicación, inicio y fin de
// solicitudes, presupuesto). Con eso se predice cuándo abrirá la siguiente (src/prediccion.ts). Una petición por edición, una sola vez
// (el detalle de una edición cerrada no cambia); respeta el tope de peticiones a BDNS y la pausa entre ellas.
import type { DatabaseSync } from 'node:sqlite';
import { claveSerie } from '../concesiones.ts';
import { apuntarFalloEdicion, borrarFalloEdicion, edicionesSinDetalle, fallosDeEdiciones, guardarDetalleEdicion } from '../db/ganadores.ts';
import { leerConvocatoria, relevantesBdns } from '../db/repo.ts';
import { calendario, type TablaFestivos } from '../festivos.ts';
import { calcularPlazo } from '../plazos.ts';
import { bdns, convocatoriaDeNumero } from '../sources/bdns.ts';
import type { Perfil, Reloj } from '../types.ts';

export interface ConfigSeries {
  /** Tope de PETICIONES HTTP a BDNS de esta fase (el motor pasa lo que queda del tope de la ejecución). */
  maxPeticiones: number;
  pausaMs: number;
}

export interface ResumenSeries {
  /** Series relevantes revisadas. */
  series: number;
  /** Detalles de ediciones guardados en esta ejecución. */
  detalles: number;
  peticiones: number;
  /** Ediciones sin traer por el tope. */
  omitidasPorTope: number;
  /** Ediciones en espera: fallaron `MAX_INTENTOS` veces y no se vuelven a pedir hasta pasados `DIAS_ESPERA` días. */
  enEspera: number;
  /** Fallos que no son error de la ejecución: la edición que agota sus intentos pasa a espera. */
  avisos: string[];
  /** Fallos pasajeros (aún quedan intentos). */
  errores: string[];
}

export const MAX_INTENTOS = 3;
export const DIAS_ESPERA = 14;

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const soloDia = (f: string | null | undefined): string | null => (f && /^\d{4}-\d{2}-\d{2}/.test(f) ? f.slice(0, 10) : null);

export async function recogerHistorialSeries(
  ctx: { db: DatabaseSync; fetch: typeof fetch; reloj: Reloj; dormir?: (ms: number) => Promise<void> }, perfil: Perfil, festivos: TablaFestivos, cfg: ConfigSeries,
  incluirIds: string[] = [],
): Promise<ResumenSeries> {
  const { db } = ctx;
  const dormir = ctx.dormir ?? dormirReal;
  const r: ResumenSeries = { series: 0, detalles: 0, peticiones: 0, omitidasPorTope: 0, enEspera: 0, avisos: [], errores: [] };
  const series = new Set<string>();
  const { relevantes } = relevantesBdns(db);
  const claves = new Map<string, string>(); // número → serie
  for (const f of db.prepare('SELECT numero_convocatoria AS n, serie FROM ediciones_serie').all() as { n: string; serie: string }[]) claves.set(f.n, f.serie);
  for (const n of relevantes) { const s = claves.get(n); if (s) series.add(s); }
  for (const id of incluirIds) {
    const c = leerConvocatoria(db, id)?.convocatoria;
    const s = c && claveSerie(c.titulo, c.organo);
    if (s) series.add(s);
  }
  r.series = series.size;
  const fallos = fallosDeEdiciones(db);
  const ahora = ctx.reloj.now();
  const enEspera = (n: string) => {
    const x = fallos.get(n);
    return x !== undefined && x.intentos >= MAX_INTENTOS && ahora.getTime() - new Date(x.ultimoEn).getTime() < DIAS_ESPERA * 86_400_000;
  };
  const todas = edicionesSinDetalle(db, [...series]);
  const pendientes = todas.filter((e) => !enEspera(e.numero));
  r.enEspera = todas.length - pendientes.length;
  const cal = calendario(festivos, perfil.ambito.regiones);

  /** Cuenta cada petición HTTP (reintentos incluidos), la espacia y corta al llegar al tope. */
  let agotado = false;
  const f: typeof fetch = async (entrada, init) => {
    if (r.peticiones >= cfg.maxPeticiones) { agotado = true; throw new Error('tope de peticiones a BDNS'); }
    if (cfg.pausaMs > 0) await dormir(cfg.pausaMs); // también antes de la primera: la fase anterior acaba de pedir a BDNS
    r.peticiones++;
    return ctx.fetch(entrada, init);
  };

  for (const [i, e] of pendientes.entries()) {
    if (agotado || r.peticiones >= cfg.maxPeticiones) { r.omitidasPorTope = pendientes.length - i; break; }
    try {
      const c = await convocatoriaDeNumero(f, e.numero);
      const datos = bdns.datosPlazo!(c);
      let fin: string | null = null;
      try { fin = calcularPlazo(datos, null, cal).fechaCierre; } catch { /* sin calendario para ese año: sin fin */ }
      const d = (c.datos as { detalle?: { fechaInicioSolicitud?: string | null; presupuestoTotal?: number | null } }).detalle;
      guardarDetalleEdicion(db, e.numero, {
        fechaPublicacion: soloDia(c.fechaPublicacion), inicioSolicitud: soloDia(d?.fechaInicioSolicitud), finSolicitud: fin, presupuesto: d?.presupuestoTotal ?? null,
      }, ctx.reloj.now());
      borrarFalloEdicion(db, e.numero);
      r.detalles++;
    } catch (err) {
      if (agotado) { r.omitidasPorTope = pendientes.length - i; break; }
      const mensaje = `BDNS edición ${e.numero}: ${(err as Error).message}`;
      if (apuntarFalloEdicion(db, e.numero, (err as Error).message, ahora) >= MAX_INTENTOS) r.avisos.push(`${mensaje} (${MAX_INTENTOS} intentos: no se vuelve a pedir en ${DIAS_ESPERA} días)`);
      else r.errores.push(mensaje);
    }
  }
  return r;
}
