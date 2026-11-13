// API HTTP (Hono). Sin estado propio: lee de la BD. `crearApi` es el punto de prueba (app.request en memoria).
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { diaLocal, sumarDias } from '../dates.ts';
import { descartesEntre, filasRanking, leerConvocatoria, leerPlazo, leerPuntuacion, ultimasEjecuciones, type VeredictoFase } from '../db/repo.ts';
import { FASE_ANALISIS } from '../fases/analisis.ts';
import type { Analisis } from '../fases/analisis-esquema.ts';
import { FASE_CRIBA } from '../fases/criba.ts';
import { type ConfigPuntuacion, leerConfigPuntuacion } from '../puntuacion.ts';
import { construirRanking } from '../ranking.ts';
import { config } from '../config.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import type { Reloj } from '../types.ts';

const DIA = /^\d{4}-\d{2}-\d{2}$/;

export function crearApi({ db, reloj, fuentes, puntuacion }: { db: DatabaseSync; reloj: Reloj; fuentes?: Fuente[]; puntuacion?: ConfigPuntuacion }): Hono {
  const api = new Hono();
  const cfg = puntuacion ?? leerConfigPuntuacion(config.rutaPuntuacion);

  api.get('/salud', (c) => c.json({ ok: true }));

  /**
   * "Esta semana": ranking por puntuación dividido en "cierran pronto" (cierre en `cierranProntoDias` días o menos) y
   * "nuevas" (vistas por primera vez en los últimos `nuevasDias` días); cada convocatoria sale en una sola sección
   * (cierran pronto manda). Las cerradas y las excluidas no salen. Ver src/ranking.ts.
   * `convocatorias` ya viene en orden: primero las de "cierran_pronto", luego las "nuevas", cada una por puntuación.
   * `puntuacion` es null si aún no hubo ninguna pasada tras guardarla.
   */
  api.get('/semana', (c) => {
    const hasta = diaLocal(reloj.now());
    const { nuevasDias, cierranProntoDias } = cfg;
    const filas = construirRanking(filasRanking(db, hasta), hasta, { nuevasDias, cierranProntoDias });
    return c.json({
      desde: sumarDias(hasta, -(nuevasDias - 1)),
      hasta,
      nuevasDias,
      cierranProntoDias,
      // plazo: { fechaCierre, tipo (literal|calculada|desconocida), textoOriginal, fechaBase, baseOrigen, aproximada, detalle, diasHastaCierre }
      // puntuacion: { total 0-100, factores: [{ id, nombre, peso, subpuntuacion 0-1, conocido, explicacion }], analizada, calculadoEn } | null
      convocatorias: filas.map(({ primeraVez, puntuacion, ...f }) => ({
        ...f,
        primeraVez,
        puntuacion: puntuacion && { total: puntuacion.total, analizada: puntuacion.analizada, factores: puntuacion.factores, calculadoEn: puntuacion.calculadoEn },
      })),
      ultimaEjecucion: ultimasEjecuciones(db, 1)[0] ?? null,
    });
  });

  /**
   * Descartadas con su motivo (reglas y fases). Por defecto, los últimos 7 días.
   * `?por=criba_llm` (o `analisis`, `regla:ambito`…) filtra; `?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` cambia la ventana.
   */
  api.get('/descartes', (c) => {
    const hoy = diaLocal(reloj.now());
    const hasta = DIA.test(c.req.query('hasta') ?? '') ? c.req.query('hasta')! : hoy;
    const desde = DIA.test(c.req.query('desde') ?? '') ? c.req.query('desde')! : sumarDias(hasta, -6);
    const por = c.req.query('por') || null;
    return c.json({ desde, hasta, por, convocatorias: descartesEntre(db, desde, hasta, por) });
  });

  /** Ficha de una convocatoria: datos de la fuente, veredictos de criba y análisis (campos con cita) y enlaces. */
  api.get('/convocatorias/:id', (c) => {
    const g = leerConvocatoria(db, c.req.param('id'));
    if (!g) return c.json({ error: 'No existe' }, 404);
    const conv = g.convocatoria;
    const fase = (nombre: string): VeredictoFase | null => g.fases.find((f) => f.fase === nombre) ?? null;
    const criba = fase(FASE_CRIBA);
    const analisis = fase(FASE_ANALISIS);
    const datosAnalisis = analisis?.datos as { analisis: Analisis; modelo: string; documentos: unknown; documentosConError: string[] } | undefined;
    const enJuego = !g.descarte && !g.fases.some((f) => f.descarta) && (!g.condicion || (criba !== null && !criba.descarta));
    return c.json({
      id: conv.id,
      fuente: conv.fuente,
      titulo: conv.titulo,
      organo: [conv.organo.nivel1, conv.organo.nivel2, conv.organo.nivel3].filter(Boolean).join(' · '),
      fechaPublicacion: conv.fechaPublicacion,
      url: conv.url,
      tipo: conv.tipo,
      finalidad: conv.finalidad,
      abierto: conv.abierto,
      descarte: g.descarte,
      condicion: g.condicion,
      enJuego,
      criba: criba && { descarta: criba.descarta, motivo: criba.motivo, ...(criba.datos as object) },
      analisis: analisis && datosAnalisis
        ? {
          descarta: analisis.descarta,
          motivo: analisis.motivo,
          modelo: datosAnalisis.modelo,
          campos: datosAnalisis.analisis,
          documentos: datosAnalisis.documentos,
          documentosConError: datosAnalisis.documentosConError,
        }
        : null,
      plazo: leerPlazo(db, conv.id, diaLocal(reloj.now())),
      // null si aún no hubo pasada; `excluida` = motivo por el que no entra en el ranking (el desglose se muestra igual).
      puntuacion: leerPuntuacion(db, conv.id),
      enlaces: fuentePorNombre(conv.fuente, fuentes)?.enlaces?.(conv) ?? [{ tipo: 'ficha', titulo: 'Ficha en la fuente', url: conv.url }],
    });
  });

  api.get('/ejecuciones', (c) => c.json(ultimasEjecuciones(db, 20)));

  return api;
}
