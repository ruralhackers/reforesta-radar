// Fase `empresas_compra_absorcion`: empresas que COMPRAN créditos de absorción (compensan su huella con un proyecto forestal de otro), candidatas a patrocinar
// a una ONG de restauración. Sin LLM: los dos listados del registro del MITECO son datos estructurados (src/sources/huella.ts):
//   - listadodecompensacion.xlsx: quién compensó, cuántas tCO2, con qué proyecto y cuándo (sin NIF).
//   - listadoproyectosdeabsorcion.xlsx: dónde está cada proyecto (provincia, CCAA) y quién lo promueve. Se une por el código del proyecto
//     (prefijo de «CÓDIGO TONELADAS RETIRADAS»); si el proyecto no está en el listado (ni en BAJAS) se prueba por nombre, y si no, la provincia queda desconocida.
// Cada comprador (nombre con su forma societaria) es una señal `compra_absorcion` con la fila literal del registro como cita. Prioridad 2 si alguna compra
// fue en un proyecto de los territorios del perfil o la última es reciente (`aniosRecientes`); si no, 1 (baja confianza, oculta por defecto). La empresa
// se une por nombre a las que ya hay (DIA, huella): con una DIA sigue siendo 3. Sin NIF no se une jamás con una empresa de otro CIF.
import type { DatabaseSync } from 'node:sqlite';
import { claveEmpresa, esEntidadJuridica, PRIORIDAD_REGISTRO_COMPENSA, PRIORIDAD_REGISTRO_ZONA, registrarSenal } from '../db/empresas.ts';
import { type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { codigoProyectoDe, descargarFichero, type FilaCompensacion, type FilaProyecto, leerListadoCompensacion, leerListadoProyectos, sinAcentosNombre, textoCompra, textoProyecto, URL_COMPENSACION, URL_PROYECTOS } from '../sources/huella.ts';
import type { Perfil, Reloj } from '../types.ts';
import { rangoLugar } from '../zona.ts';
import { diaLocal } from '../dates.ts';

export const FASE_COMPRAS = 'empresas_compra_absorcion';

export interface ConfigCompras {
  /** Una compra de hace menos de tantos años cuenta como reciente. */
  aniosRecientes: number;
  timeoutMs: number;
  maxBytes: number;
}

export const CONFIG_COMPRAS_POR_DEFECTO: ConfigCompras = { aniosRecientes: 2, timeoutMs: 60_000, maxBytes: 20 * 1024 * 1024 };

export interface ResumenCompras {
  compensacionesLeidas: number;
  proyectosLeidos: number;
  /** Compensaciones cuyo proyecto no se ha podido localizar ni por código ni por nombre. */
  sinProyecto: number;
  /** Compradores distintos (por nombre con forma societaria) tras los descartes. */
  compradores: number;
  /** Descartadas: sin forma jurídica identificable, administración pública o solo compran en proyectos propios. */
  sinFormaJuridica: number;
  administraciones: number;
  soloProyectosPropios: number;
  /** De los compradores, los que han comprado en un proyecto de los territorios del perfil. */
  enTerritorio: number;
  recientes: number;
  /** Con prioridad visible (2): en territorio o reciente. */
  relevantes: number;
  /** No guardados porque ya hay dos o más empresas con ese nombre y CIF distintos: sin NIF no se sabe a cuál pertenece la compra. */
  ambiguos: number;
  empresasNuevas: string[];
  empresasUnidas: string[];
  fase: RegistroFase;
  errores: string[];
}

export interface ContextoCompras {
  db: DatabaseSync;
  fetch: typeof fetch;
  reloj: Reloj;
  perfil: Perfil;
}

export interface Compra {
  compensacion: FilaCompensacion;
  proyecto: FilaProyecto | null;
  tco2: number;
  enTerritorio: boolean;
}

export interface Comprador {
  nombre: string;
  clave: string;
  /** Más reciente primero. */
  compras: Compra[];
  tco2Total: number;
  /** La compra que da el motivo: la más reciente de las de territorio, o si no la más reciente. */
  principal: Compra;
  enTerritorio: boolean;
  reciente: boolean;
  prioridad: number;
}

const MAX_MOTIVO = 260;
const ADMINISTRACION = /(^| )(ayuntamiento|diputacion|universidad|mancomunidad|consorcio|junta de|gobierno de|consejeria|ministerio|cabildo|consell|generalitat|xunta|comunidad de madrid)( |$)/;
const limpio = (t: string) => t.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
const claveSinForma = (n: string) => claveEmpresa(n).replace(/ (slu|sau|sl|sa|sll|scoop)$/, '');
const numero = (v: string) => { const n = Number(v.replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const fmt = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const recortar = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : t);

/** Resumen de datos, sin escribir nada: los compradores que salen de los dos listados y los descartes. Función pura (testeable). */
export function derivarCompradores(compensaciones: FilaCompensacion[], proyectos: FilaProyecto[], perfil: Perfil, ahora: Date, cfg: Pick<ConfigCompras, 'aniosRecientes'> = CONFIG_COMPRAS_POR_DEFECTO): {
  compradores: Comprador[]; sinProyecto: number; sinFormaJuridica: number; administraciones: number; soloProyectosPropios: number;
} {
  const porCodigo = new Map(proyectos.map((p) => [p.codigo, p]));
  const porNombre = new Map<string, FilaProyecto>();
  for (const p of proyectos) porNombre.set(sinAcentosNombre(p.nombre), p);
  const limite = new Date(ahora);
  limite.setUTCFullYear(limite.getUTCFullYear() - cfg.aniosRecientes);
  const desde = diaLocal(limite);

  const porComprador = new Map<string, { nombre: string; filas: FilaCompensacion[] }>();
  for (const c of compensaciones) {
    const clave = claveEmpresa(c.organizacion);
    if (!clave) continue;
    const g = porComprador.get(clave) ?? { nombre: c.organizacion, filas: [] };
    g.filas.push(c);
    porComprador.set(clave, g);
  }
  let sinProyecto = 0;
  for (const c of compensaciones) if (!(porCodigo.get(codigoProyectoDe(c)) ?? porNombre.get(sinAcentosNombre(c.proyecto)))) sinProyecto++;

  const compradores: Comprador[] = [];
  let sinFormaJuridica = 0;
  let administraciones = 0;
  let soloProyectosPropios = 0;
  for (const [clave, g] of porComprador) {
    if (ADMINISTRACION.test(clave)) { administraciones++; continue; }
    if (!esEntidadJuridica(g.nombre, null)) { sinFormaJuridica++; continue; }
    const compras: Compra[] = [];
    for (const c of g.filas) {
      const proyecto = porCodigo.get(codigoProyectoDe(c)) ?? porNombre.get(sinAcentosNombre(c.proyecto)) ?? null;
      // Compensar con un proyecto que uno mismo promueve no es comprar: no es una señal de que patrocine proyectos ajenos.
      if (proyecto && claveSinForma(proyecto.promotor) === claveSinForma(g.nombre)) continue;
      const enTerritorio = !!proyecto && rangoLugar(proyecto.provincia, proyecto.ccaa, perfil) !== null;
      compras.push({ compensacion: c, proyecto, tco2: numero(c.tco2), enTerritorio });
    }
    if (compras.length === 0) { soloProyectosPropios++; continue; }
    compras.sort((a, b) => b.compensacion.fecha.localeCompare(a.compensacion.fecha) || b.compensacion.fila - a.compensacion.fila);
    const principal = compras.find((x) => x.enTerritorio) ?? compras[0];
    const enTerritorio = compras.some((x) => x.enTerritorio);
    const reciente = compras[0].compensacion.fecha >= desde;
    compradores.push({
      nombre: g.nombre, clave, compras, tco2Total: compras.reduce((s, x) => s + x.tco2, 0), principal, enTerritorio, reciente,
      prioridad: enTerritorio || reciente ? PRIORIDAD_REGISTRO_COMPENSA : PRIORIDAD_REGISTRO_ZONA,
    });
  }
  return { compradores, sinProyecto, sinFormaJuridica, administraciones, soloProyectosPropios };
}

/** «Compensó 120 tCO2 en 2025 con el proyecto de absorción «…» (Ávila)», más las demás compras si las hay. Lo dicen los datos, no un modelo. */
export function motivoCompra(c: Comprador): string {
  const p = c.principal;
  const lugar = p.proyecto?.provincia ? ` (${p.proyecto.provincia})` : '';
  const base = `Compensó ${fmt(p.tco2)} tCO2 en ${p.compensacion.fecha.slice(0, 4)} con el proyecto de absorción «${recortar(limpio(p.compensacion.proyecto), 90)}»${lugar}`;
  const mas = c.compras.length - 1;
  const resto = mas > 0 ? `; ${mas} compensaci${mas === 1 ? 'ón' : 'ones'} más, ${fmt(c.tco2Total)} tCO2 en total` : '';
  return limpio(`${base}${resto}`).slice(0, MAX_MOTIVO);
}

/** Dónde y quién: «Bosque Los Cantos» (Adanero, Ávila), promovido por EULEN, S.A. */
export function descripcionProyecto(c: Comprador): string {
  const p = c.principal.proyecto;
  if (!p) return `«${limpio(c.principal.compensacion.proyecto)}» (ubicación no consta en el listado de proyectos)`;
  const sitio = [p.localizacion && p.localizacion.toLowerCase() !== p.nombre.toLowerCase() ? p.localizacion : '', p.provincia].filter(Boolean).join(', ');
  return limpio(`«${recortar(p.nombre, 90)}»${sitio ? ` (${sitio})` : ''}, promovido por ${p.promotor || 'promotor desconocido'}`);
}

export async function recogerEmpresasCompras(ctx: ContextoCompras, cfg: ConfigCompras = CONFIG_COMPRAS_POR_DEFECTO): Promise<ResumenCompras> {
  const { db } = ctx;
  const ahora = ctx.reloj.now();
  const fase = registroFaseVacio(FASE_COMPRAS, null);
  const r: ResumenCompras = {
    compensacionesLeidas: 0, proyectosLeidos: 0, sinProyecto: 0, compradores: 0, sinFormaJuridica: 0, administraciones: 0, soloProyectosPropios: 0, enTerritorio: 0, recientes: 0, relevantes: 0, ambiguos: 0,
    empresasNuevas: [], empresasUnidas: [], fase, errores: [],
  };
  const falla = (m: string) => { r.errores.push(m); fase.errores.push(m); return r; };
  let compensaciones: FilaCompensacion[];
  let proyectos: FilaProyecto[];
  try {
    const opciones = { timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes };
    const [c, p] = [await descargarFichero(ctx.fetch, URL_COMPENSACION, opciones), await descargarFichero(ctx.fetch, URL_PROYECTOS, opciones)];
    compensaciones = leerListadoCompensacion(c!.datos);
    proyectos = leerListadoProyectos(p!.datos);
  } catch (e) {
    return falla(`Compra de absorciones (registro del MITECO): ${(e as Error).message}`);
  }
  r.compensacionesLeidas = compensaciones.length;
  r.proyectosLeidos = proyectos.length;
  const d = derivarCompradores(compensaciones, proyectos, ctx.perfil, ahora, cfg);
  Object.assign(r, { sinProyecto: d.sinProyecto, sinFormaJuridica: d.sinFormaJuridica, administraciones: d.administraciones, soloProyectosPropios: d.soloProyectosPropios, compradores: d.compradores.length });
  r.enTerritorio = d.compradores.filter((c) => c.enTerritorio).length;
  r.recientes = d.compradores.filter((c) => c.reciente).length;
  r.relevantes = d.compradores.filter((c) => c.prioridad >= PRIORIDAD_REGISTRO_COMPENSA).length;
  if (d.sinProyecto) fase.avisos.push(`${d.sinProyecto} compensaciones con un proyecto que no consta en el listado de proyectos de absorción (su provincia queda desconocida)`);

  /** Empresas guardadas con ese nombre (con o sin CIF añadido a la clave) y CIF distintos: el listado de compensaciones no trae NIF y no se decide por el equipo. */
  const ambiguo = (clave: string) => {
    const cifs = db.prepare(`SELECT DISTINCT cif FROM empresas WHERE cif IS NOT NULL AND (clave = ? OR clave LIKE ?)`).all(clave, `${clave} %`) as { cif: string }[];
    return cifs.length > 1;
  };
  for (const c of d.compradores) {
    try {
      if (ambiguo(claveEmpresa(c.nombre))) { r.ambiguos++; fase.avisos.push(`${c.nombre}: hay varias empresas con ese nombre y CIF distintos; no se une la compra a ninguna`); continue; }
      const p = c.principal;
      const cita = textoCompra(p.compensacion);
      const medidas = [{ tipo: 'compensacion', cita }, ...(p.proyecto ? [{ tipo: 'proyecto_absorcion', cita: textoProyecto(p.proyecto) }] : [])];
      const provincia = p.proyecto?.provincia || null;
      const { nueva } = registrarSenal(db, {
        nombre: c.nombre, cif: null, origen: 'compra_absorcion', prioridad: c.prioridad, motivo: motivoCompra(c), cita, provincia,
        senal: { boeId: `compra:${c.clave}`, titulo: `Compra de absorciones (MITECO): ${c.nombre}`, proyecto: descripcionProyecto(c), provincia, medidas, enlace: URL_COMPENSACION, fechaPublicacion: c.compras[0].compensacion.fecha },
      }, ahora);
      (nueva ? r.empresasNuevas : r.empresasUnidas).push(c.nombre);
    } catch (e) {
      falla(`${c.nombre}: ${(e as Error).message}`);
    }
  }
  fase.procesadas = d.compradores.length;
  fase.descartadas = d.sinFormaJuridica + d.administraciones + d.soloProyectosPropios + r.ambiguos;
  return r;
}
