// Fase `ganadores` (determinista, sin LLM): trae de BDNS las concesiones de Reforesta (por NIF), de cada candidata en
// juego y de las ediciones anteriores de su serie, y recalcula las organizaciones parecidas (co-ganadoras de las
// convocatorias que gana Reforesta). Cada consulta se cachea `diasCache` días y hay un tope de consultas por ejecución:
// lo que pase se queda para la siguiente.
import type { DatabaseSync } from 'node:sqlite';
import { claveSerie, tituloSinAnio } from '../concesiones.ts';
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
  /** Tope de consultas a BDNS por ejecución. */
  maxConsultas: number;
}

export const CONFIG_GANADORES_POR_DEFECTO: ConfigGanadores = { diasCache: 7, maxConsultas: 200 };

export interface ResumenGanadores {
  consultas: number;
  desdeCache: number;
  omitidasPorTope: number;
  /** Concesiones guardadas en total tras la fase. */
  concesiones: number;
  /** Organizaciones parecidas calculadas (co-ganadoras). */
  parecidas: number;
  errores: string[];
}

export async function recogerGanadores(
  ctx: { db: DatabaseSync; fetch: typeof fetch; reloj: Reloj }, perfil: Perfil, cfg: ConfigGanadores = CONFIG_GANADORES_POR_DEFECTO,
): Promise<ResumenGanadores> {
  const { db } = ctx;
  const ahora = ctx.reloj.now();
  const hoy = diaLocal(ahora);
  const r: ResumenGanadores = { consultas: 0, desdeCache: 0, omitidasPorTope: 0, concesiones: 0, parecidas: 0, errores: [] };

  /** Hace la consulta salvo que sea reciente o se haya agotado el tope. Un fallo se anota y no corta la fase. */
  const pedir = async (clave: string, consulta: () => Promise<void>): Promise<void> => {
    if (consultaReciente(db, clave, ahora, cfg.diasCache)) { r.desdeCache++; return; }
    if (r.consultas >= cfg.maxConsultas) { r.omitidasPorTope++; return; }
    r.consultas++;
    try {
      await consulta();
    } catch (e) {
      r.errores.push(`BDNS ${clave}: ${(e as Error).message}`);
    }
  };

  if (perfil.nif) {
    await pedir(`nif:${perfil.nif}`, async () => guardarConcesionesSueltas(db, `nif:${perfil.nif}`, await concesionesDeNif(ctx.fetch, perfil.nif), ahora));
  }
  const ganadas = perfil.nif ? convocatoriasGanadasPor(db, perfil.nif) : [];

  // Series que interesan: las de las candidatas (para enseñar quién ganó antes) y las de lo que ya ganó Reforesta (para ver ediciones perdidas).
  const candidatas = enJuegoTodas(db).filter((c) => c.fuente === 'bdns');
  const series = new Map<string, string>(); // clave → título sin año
  for (const c of candidatas) {
    registrarEdicion(db, c.fuenteId, c.titulo, c.organo, c.fechaPublicacion);
    const s = claveSerie(c.titulo, c.organo);
    if (s) series.set(s, tituloSinAnio(c.titulo));
  }
  for (const n of ganadas) {
    const e = db.prepare('SELECT serie, titulo FROM ediciones_serie WHERE numero_convocatoria = ?').get(n) as { serie: string; titulo: string } | undefined;
    if (e) series.set(e.serie, tituloSinAnio(e.titulo));
  }
  for (const [serie, texto] of series) {
    await pedir(`serie:${serie}`, async () => {
      const hits = await buscarConvocatoriasPorTitulo(ctx.fetch, texto, hoy);
      for (const h of hits) {
        if (claveSerie(h.descripcion, h) === serie) registrarEdicion(db, String(h.numeroConvocatoria), h.descripcion, h, h.fechaRecepcion);
      }
      marcarConsulta(db, `serie:${serie}`, hits.length, ahora);
    });
  }

  // Ganadores de: las candidatas, las ediciones de sus series y lo que ganó Reforesta (en ese orden de prioridad).
  const numeros = new Set<string>(candidatas.map((c) => c.fuenteId));
  for (const serie of series.keys()) for (const e of edicionesDeSerie(db, serie)) numeros.add(e.numeroConvocatoria);
  for (const n of ganadas) numeros.add(n);
  for (const n of numeros) {
    await pedir(`conv:${n}`, async () => guardarConcesionesDeConvocatoria(db, n, await concesionesDeConvocatoria(ctx.fetch, n), ahora));
  }

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
