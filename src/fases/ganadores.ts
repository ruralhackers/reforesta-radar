// Fase `ganadores` (determinista, sin LLM): trae de BDNS las concesiones de Reforesta (por NIF), de cada candidata en
// juego y de las ediciones anteriores de su serie, y recalcula las organizaciones parecidas (co-ganadoras de las
// convocatorias que gana Reforesta). Cada consulta se cachea `diasCache` días y hay un tope de consultas por ejecución:
// lo que pase se queda para la siguiente.
import type { DatabaseSync } from 'node:sqlite';
import { anioEdicion, claveSerie, edicionesComparables, tituloSinAnio } from '../concesiones.ts';
import { diaLocal } from '../dates.ts';
import {
  concesionesDe, consultaReciente, convocatoriasGanadasPor, edicionesDeSerie, guardarConcesionesDeConvocatoria,
  guardarConcesionesSueltas, guardarParecidasCalculadas, marcarConsulta, type ParecidaCalculada, registrarEdicion,
} from '../db/ganadores.ts';
import { enJuegoTodas } from '../db/repo.ts';
import { buscarConvocatoriasPorTitulo, concesionesDeConvocatoria, concesionesDeNif } from '../sources/bdns-concesiones.ts';
import type { Perfil, Reloj } from '../types.ts';

export interface ConfigGanadores {
  /** Días que vale una consulta a BDNS antes de repetirla. */
  diasCache: number;
  /** Tope de PETICIONES HTTP a BDNS por ejecución (cada consulta pagina; los reintentos por 429 cuentan). */
  maxPeticiones: number;
  /** Pausa fija entre peticiones a BDNS, en ms. */
  pausaMs: number;
}

export const CONFIG_GANADORES_POR_DEFECTO: ConfigGanadores = { diasCache: 7, maxPeticiones: 200, pausaMs: 250 };

export interface ResumenGanadores {
  /** Consultas lógicas hechas (una puede ser varias peticiones, por la paginación). */
  consultas: number;
  /** Peticiones HTTP hechas a BDNS. */
  peticiones: number;
  desdeCache: number;
  /** Consultas sin hacer (o interrumpidas) por el tope de peticiones. */
  omitidasPorTope: number;
  /** Concesiones guardadas en total tras la fase. */
  concesiones: number;
  /** Organizaciones parecidas calculadas (co-ganadoras). */
  parecidas: number;
  errores: string[];
}

class TopeDePeticiones extends Error {}

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Orden de prioridad (con un tope ajustado se hace lo que más importa primero):
 * 1. Concesiones de Reforesta por NIF y los ganadores de cada convocatoria que ganó: con eso se calculan las parecidas.
 * 2. Series de las candidatas que siguen en juego (tras la criba): búsqueda de ediciones.
 * 3. Ganadores de las candidatas y de sus ediciones anteriores.
 */
export async function recogerGanadores(
  ctx: { db: DatabaseSync; fetch: typeof fetch; reloj: Reloj; dormir?: (ms: number) => Promise<void> }, perfil: Perfil, cfg: ConfigGanadores = CONFIG_GANADORES_POR_DEFECTO,
): Promise<ResumenGanadores> {
  const { db } = ctx;
  const ahora = ctx.reloj.now();
  const hoy = diaLocal(ahora);
  const dormir = ctx.dormir ?? dormirReal;
  const r: ResumenGanadores = { consultas: 0, peticiones: 0, desdeCache: 0, omitidasPorTope: 0, concesiones: 0, parecidas: 0, errores: [] };
  let agotado = false;

  /** Cuenta cada petición HTTP (reintentos incluidos), la espacia y corta al llegar al tope. */
  const f: typeof fetch = async (entrada, init) => {
    if (r.peticiones >= cfg.maxPeticiones) throw new TopeDePeticiones('tope de peticiones a BDNS');
    if (r.peticiones > 0 && cfg.pausaMs > 0) await dormir(cfg.pausaMs);
    r.peticiones++;
    return ctx.fetch(entrada, init);
  };

  /** Hace la consulta salvo que sea reciente o se haya agotado el tope. Un fallo se anota y no corta la fase. */
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
  const pedirConvocatoria = (n: string) => pedir(`conv:${n}`, async () => guardarConcesionesDeConvocatoria(db, n, await concesionesDeConvocatoria(f, n), ahora));

  // 1. Reforesta y lo que ganó.
  if (perfil.nif) {
    await pedir(`nif:${perfil.nif}`, async () => guardarConcesionesSueltas(db, `nif:${perfil.nif}`, await concesionesDeNif(f, perfil.nif), ahora));
  }
  const hechas = new Set<string>();
  for (const n of perfil.nif ? convocatoriasGanadasPor(db, perfil.nif) : []) { hechas.add(n); await pedirConvocatoria(n); }
  r.parecidas = recalcularParecidas(db, perfil, ahora);

  // 2. Series de las candidatas en juego.
  const candidatas = enJuegoTodas(db).filter((c) => c.fuente === 'bdns');
  const series = new Map<string, string>(); // clave → título sin año
  for (const c of candidatas) {
    registrarEdicion(db, c.fuenteId, c.titulo, c.organo, c.fechaPublicacion);
    const s = claveSerie(c.titulo, c.organo);
    if (s) series.set(s, tituloSinAnio(c.titulo));
  }
  for (const [serie, texto] of series) {
    await pedir(`serie:${serie}`, async () => {
      const hits = await buscarConvocatoriasPorTitulo(f, texto, hoy);
      for (const h of hits) {
        if (claveSerie(h.descripcion, h) === serie) registrarEdicion(db, String(h.numeroConvocatoria), h.descripcion, h, h.fechaRecepcion);
      }
      marcarConsulta(db, `serie:${serie}`, hits.length, ahora);
    });
  }

  // 3. Ganadores de las candidatas y de las ediciones con las que se pueden enlazar.
  const numeros = new Set<string>();
  for (const c of candidatas) {
    numeros.add(c.fuenteId);
    const serie = claveSerie(c.titulo, c.organo);
    if (!serie) continue;
    for (const e of edicionesComparables(edicionesDeSerie(db, serie), { numeroConvocatoria: c.fuenteId, anio: anioEdicion(c.titulo, c.fechaPublicacion) })) numeros.add(e.numeroConvocatoria);
  }
  for (const n of numeros) if (!hechas.has(n)) await pedirConvocatoria(n);

  r.parecidas = recalcularParecidas(db, perfil, ahora);
  r.concesiones = Number((db.prepare('SELECT COUNT(*) AS n FROM concesiones').get() as { n: number }).n);
  return r;
}

/**
 * Parecidas = entidades (no personas anonimizadas) que ganaron las mismas convocatorias que ganó Reforesta, ordenadas
 * por cuántas. Si todavía no se sabe qué ha ganado Reforesta no se toca nada (no se borra lo anterior).
 */
export function recalcularParecidas(db: DatabaseSync, perfil: Perfil, ahora: Date): number {
  const ganadas = perfil.nif ? convocatoriasGanadasPor(db, perfil.nif) : [];
  if (ganadas.length === 0) return 0;
  const porNif = new Map<string, { nombres: Map<string, number>; convocatorias: Set<string> }>();
  for (const n of ganadas) {
    for (const c of concesionesDe(db, n)) {
      if (!c.nif || c.esPersona || c.nif === perfil.nif) continue;
      const e = porNif.get(c.nif) ?? { nombres: new Map(), convocatorias: new Set() };
      e.nombres.set(c.nombre, (e.nombres.get(c.nombre) ?? 0) + 1);
      e.convocatorias.add(n);
      porNif.set(c.nif, e);
    }
  }
  const calculadas: ParecidaCalculada[] = [...porNif].map(([nif, e]) => ({
    nif,
    nombre: [...e.nombres].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0],
    evidencia: [...e.convocatorias].sort(),
  }));
  guardarParecidasCalculadas(db, calculadas, ahora);
  return calculadas.length;
}
