// Fase `parecidas` (determinista, sin LLM): descubrimiento de convocatorias por organizaciones parecidas.
// Para cada parecida ACTIVA se traen sus concesiones desde 2022 (por NIF). De lo que ganaron salen las SERIES (mismo órgano y
// título salvo el año); si BDNS tiene una edición NUEVA de la serie (año posterior al de lo ganado) y no está resuelta ni cerrada,
// es candidata: entra en el flujo normal (reglas → criba → análisis → puntuación) con la etiqueta de origen "parecidas" y la
// organización (y la edición anterior) que la ganó. La convocatoria vieja y ya resuelta nunca es candidata.
//   · Sin duplicados: el id es `bdns:<número>`, el mismo que la fuente directa. Si ya está guardada solo se añade la etiqueta.
//   · Solo las guardadas por esta vía llevan marca en `descubiertas_parecidas`: sin etiquetas (se desactivó la organización) dejan
//     de estar en juego. Si luego las trae la fuente directa, la marca se quita y se quedan.
//   · Las etiquetas se reconstruyen en cada ejecución desde lo guardado (no dependen de la red ni de la caché).
//   · "Abierta o próxima": se guarda salvo que su fecha fin de solicitud ya haya pasado; el resto (plazo calculado, cierre) lo
//     deciden las fases de plazo y ranking, porque el indicador `abierto` de BDNS no es fiable.
//   · Cada consulta se cachea `diasCache` días y comparte el tope de peticiones HTTP a BDNS y la pausa con la fase de ganadores.
import type { DatabaseSync } from 'node:sqlite';
import { anioEdicion, claveSerie, edicionesComparables, textoBusquedaSerie } from '../concesiones.ts';
import { diaLocal, sumarDias } from '../dates.ts';
import {
  borrarGanadasHuerfanas, concesionesDe, consultaReciente, edicionesDeSerie, existeConvocatoria, ganadasDeParecidasActivas, guardarGanadasDeParecida,
  leerParecidas, marcarConsulta, marcarDescubierta, type OrigenDescubierta, reemplazarOrigenesParecidas,
} from '../db/ganadores.ts';
import { guardarConvocatoria } from '../db/repo.ts';
import { condicionAmbito, cribar } from '../rules.ts';
import { convocatoriaConDetalle } from '../sources/bdns.ts';
import { concesionesDeNif } from '../sources/bdns-concesiones.ts';
import type { Perfil, Reloj } from '../types.ts';
import { buscarEdiciones } from './ganadores.ts';

export interface ConfigParecidas {
  diasCache: number;
  /** Tope de peticiones HTTP a BDNS de esta fase (el de ganadores se descuenta de lo que quede del tope total). */
  maxPeticiones: number;
  pausaMs: number;
  /** Solo se buscan series con alguna concesión de una parecida desde este año (por defecto 2022, el suelo de BDNS: todo lo que hay). */
  desdeAnio: number;
  /** Solo son candidatas las ediciones nuevas registradas en BDNS en los últimos N días. */
  diasEdicion: number;
}

export const CONFIG_PARECIDAS_POR_DEFECTO: ConfigParecidas = { diasCache: 7, maxPeticiones: 100, pausaMs: 250, desdeAnio: 2022, diasEdicion: 400 };

export interface ResumenParecidas {
  /** Parecidas activas consideradas. */
  organizaciones: number;
  consultas: number;
  peticiones: number;
  desdeCache: number;
  omitidasPorTope: number;
  /** Series (convocatorias que se repiten) ganadas por parecidas en la ventana. */
  series: number;
  /** Candidatas con etiqueta de origen tras la fase. */
  etiquetadas: number;
  /** De ellas, guardadas ahora por primera vez (no venían de BDNS directo). */
  nuevas: number;
  /** De ellas, ya conocidas (directo u otra pasada): solo se añadió la etiqueta. */
  yaConocidas: number;
  errores: string[];
}

class TopeDePeticiones extends Error {}
const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function descubrirParecidas(
  ctx: { db: DatabaseSync; fetch: typeof fetch; reloj: Reloj; dormir?: (ms: number) => Promise<void> }, perfil: Perfil, cfg: ConfigParecidas = CONFIG_PARECIDAS_POR_DEFECTO,
): Promise<ResumenParecidas> {
  const { db } = ctx;
  const ahora = ctx.reloj.now();
  const hoy = diaLocal(ahora);
  const dormir = ctx.dormir ?? dormirReal;
  const r: ResumenParecidas = { organizaciones: 0, consultas: 0, peticiones: 0, desdeCache: 0, omitidasPorTope: 0, series: 0, etiquetadas: 0, nuevas: 0, yaConocidas: 0, errores: [] };
  let agotado = false;

  const f: typeof fetch = async (entrada, init) => {
    if (r.peticiones >= cfg.maxPeticiones) throw new TopeDePeticiones('tope de peticiones a BDNS');
    if (r.peticiones > 0 && cfg.pausaMs > 0) await dormir(cfg.pausaMs);
    r.peticiones++;
    return ctx.fetch(entrada, init);
  };
  const pedir = async (clave: string, consulta: () => Promise<void>): Promise<void> => {
    if (consultaReciente(db, clave, ahora, cfg.diasCache)) { r.desdeCache++; return; }
    if (agotado) { r.omitidasPorTope++; return; }
    r.consultas++;
    try {
      await consulta();
    } catch (e) {
      if (e instanceof TopeDePeticiones) { agotado = true; r.omitidasPorTope++; return; }
      r.errores.push(`BDNS ${clave}: ${(e as Error).message}`);
    }
  };

  borrarGanadasHuerfanas(db);
  const activas = leerParecidas(db, true);
  r.organizaciones = activas.length;

  // 1. Lo que ganó cada parecida activa.
  for (const o of activas) {
    await pedir(`parecida:${o.nif}`, async () => guardarGanadasDeParecida(db, o.nif, await concesionesDeNif(f, o.nif), ahora));
  }

  // 2. Series ganadas recientemente (la clave de serie exige un título lo bastante específico).
  const anioMin = cfg.desdeAnio;
  interface Ganada { numero: string; anio: number | null; ultimoAnio: number; orgs: { nif: string; nombre: string }[] }
  const porSerie = new Map<string, { texto: string; ganadas: Map<string, Ganada>; ultimoAnio: number }>();
  for (const g of ganadasDeParecidasActivas(db)) {
    const serie = claveSerie(g.titulo, g.organo);
    if (!serie) continue;
    const ultimoAnio = Number((g.fechaConcesion ?? '0000').slice(0, 4));
    const s = porSerie.get(serie) ?? { texto: textoBusquedaSerie(g.titulo), ganadas: new Map(), ultimoAnio: 0 };
    const previa = s.ganadas.get(g.numeroConvocatoria) ?? { numero: g.numeroConvocatoria, anio: anioEdicion(g.titulo, g.fechaConcesion), ultimoAnio, orgs: [] };
    previa.orgs.push({ nif: g.nif, nombre: g.nombre });
    s.ganadas.set(g.numeroConvocatoria, previa);
    s.ultimoAnio = Math.max(s.ultimoAnio, ultimoAnio);
    porSerie.set(serie, s);
  }
  const series = [...porSerie].filter(([, s]) => s.ultimoAnio >= anioMin).sort((a, b) => b[1].ultimoAnio - a[1].ultimoAnio || a[0].localeCompare(b[0]));
  r.series = series.length;
  for (const [serie, s] of series) await pedir(`serie:${serie}`, () => buscarEdiciones(db, f, serie, s.texto, hoy, ahora));

  // 3. Ediciones nuevas de esas series: candidatas.
  const desde = sumarDias(hoy, -cfg.diasEdicion);
  const origenes = new Map<string, OrigenDescubierta[]>();
  for (const [serie, s] of series) {
    const ediciones = edicionesDeSerie(db, serie);
    for (const e of ediciones) {
      if (s.ganadas.has(e.numeroConvocatoria) || e.anio === null || (e.fecha ?? '0000') < desde) continue;
      if (concesionesDe(db, e.numeroConvocatoria).length > 0) continue; // ya resuelta: no hay a qué presentarse
      const previas = edicionesComparables(ediciones, { numeroConvocatoria: e.numeroConvocatoria, anio: e.anio }).filter((p) => s.ganadas.has(p.numeroConvocatoria));
      if (previas.length === 0) continue;
      const id = `bdns:${e.numeroConvocatoria}`;
      if (!existeConvocatoria(db, id)) {
        await pedir(`detalle:${e.numeroConvocatoria}`, async () => {
          const c = await convocatoriaConDetalle(f, {
            numeroConvocatoria: e.numeroConvocatoria, descripcion: e.titulo, fechaRecepcion: e.fecha!,
            nivel1: null, nivel2: null, nivel3: null, // el detalle trae el órgano
          });
          marcarConsulta(db, `detalle:${e.numeroConvocatoria}`, 1, ahora);
          const fin = (c.datos as { detalle?: { fechaFinSolicitud?: string | null } }).detalle?.fechaFinSolicitud;
          if (fin && /^\d{4}-\d{2}-\d{2}/.test(fin) && fin.slice(0, 10) < hoy) return; // ya cerrada: no es candidata
          const descarte = cribar(c, perfil);
          guardarConvocatoria(db, { convocatoria: c, descarte, condicion: descarte ? null : condicionAmbito(c, perfil) }, ahora);
          marcarDescubierta(db, id);
          r.nuevas++;
        });
      } else {
        r.yaConocidas++;
      }
      if (!existeConvocatoria(db, id)) continue;
      const lista = origenes.get(id) ?? [];
      for (const p of previas) for (const o of s.ganadas.get(p.numeroConvocatoria)!.orgs) lista.push({ nif: o.nif, nombre: o.nombre, numeroPrevio: p.numeroConvocatoria, anioPrevio: p.anio });
      origenes.set(id, lista);
    }
  }
  reemplazarOrigenesParecidas(db, origenes);
  r.etiquetadas = origenes.size;
  return r;
}
