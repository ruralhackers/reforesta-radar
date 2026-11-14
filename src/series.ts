// Serie de ediciones de una convocatoria (la misma, año tras año) y predicción de cuándo abrirá la siguiente.
// Todo sale de lo guardado (ediciones_serie, convocatorias, plazos y concesiones): sin red ni LLM, barato de recalcular en cada petición.
import type { DatabaseSync } from 'node:sqlite';
import { claveSerie, tituloSinAnio } from './concesiones.ts';
import { diaLocal } from './dates.ts';
import { concesionesDe } from './db/ganadores.ts';
import { relevantesBdns } from './db/repo.ts';
import { type AperturaPasada, estadoApertura, type EstadoApertura, medianaRedondeada, predecirApertura, type PrediccionApertura } from './prediccion.ts';
import { tituloParaMostrar } from './titulo.ts';
import type { Convocatoria, Perfil } from './types.ts';

const FICHA_BDNS = 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/';
export const PROXIMAS_DIAS_POR_DEFECTO = 60;

export interface EdicionSerie {
  numeroConvocatoria: string;
  anio: number;
  titulo: string;
  /** Ficha de la fuente (BDNS). */
  url: string;
  /** Id de la ficha en el radar si la edición está guardada como convocatoria; null si solo se conoce su historial. */
  convocatoriaId: string | null;
  /** Es la convocatoria cuya ficha se está viendo. */
  propia: boolean;
  /** YYYY-MM-DD: inicio de solicitudes si se conoce; si no, publicación en BDNS. */
  apertura: string | null;
  cierre: string | null;
  presupuesto: number | null;
  /** null = BDNS aún no publica concesiones de esta edición. */
  ganadores: number | null;
  importeTotal: number | null;
  importeMedio: number | null;
  /** gano = figura entre los ganadores; no_figura = hay ganadores y no está (BDNS no publica quién perdió); sin_datos = sin concesiones. */
  reforesta: 'gano' | 'no_figura' | 'sin_datos';
  importeReforesta: number | null;
}

interface FilaEdicion {
  numero_convocatoria: string; titulo: string; anio: number | null; fecha_publicacion: string | null; inicio_solicitud: string | null;
  fin_solicitud: string | null; presupuesto: number | null; cid: string | null; c_fecha: string | null; c_datos: string | null; p_cierre: string | null;
}

const dia = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * Ediciones de una serie con sus datos, por año (más antigua primero). Un año con dos convocatorias distintas es ambiguo (no se sabe cuál es
 * "la edición") y no sale, salvo la propia. Lo que dice la convocatoria guardada (detalle, plazo) manda sobre lo guardado de su historial.
 */
export function historialDeSerie(db: DatabaseSync, serie: string, perfil: Perfil | null, propio: string | null = null): EdicionSerie[] {
  const filas = db.prepare(`
    SELECT es.numero_convocatoria, es.titulo, es.anio, d.fecha_publicacion, d.inicio_solicitud, d.fin_solicitud, d.presupuesto,
           c.id AS cid, c.fecha_publicacion AS c_fecha, c.datos AS c_datos, p.fecha_cierre AS p_cierre
    FROM ediciones_serie es
    LEFT JOIN ediciones_detalle d ON d.numero_convocatoria = es.numero_convocatoria
    LEFT JOIN convocatorias c ON c.id = 'bdns:' || es.numero_convocatoria
    LEFT JOIN plazos p ON p.convocatoria_id = c.id
    WHERE es.serie = ? AND es.anio IS NOT NULL`).all(serie) as unknown as FilaEdicion[];
  const porAnio = new Map<number, FilaEdicion[]>();
  for (const f of filas) porAnio.set(f.anio!, [...(porAnio.get(f.anio!) ?? []), f]);
  const elegidas = [...porAnio.values()].flatMap((fs) => (fs.length === 1 ? fs : fs.filter((f) => f.numero_convocatoria === propio)));
  return elegidas.sort((a, b) => a.anio! - b.anio!).map((f) => {
    const detalle = (f.c_datos ? (JSON.parse(f.c_datos) as { detalle?: Record<string, unknown> }).detalle : undefined) ?? {};
    const concesiones = concesionesDe(db, f.numero_convocatoria);
    const importes = concesiones.flatMap((g) => (g.importe !== null ? [g.importe] : []));
    const total = importes.reduce((s, x) => s + x, 0);
    const mias = concesiones.filter((g) => g.nif !== null && g.nif === perfil?.nif);
    const presupuesto = typeof detalle.presupuestoTotal === 'number' ? detalle.presupuestoTotal : f.presupuesto;
    return {
      numeroConvocatoria: f.numero_convocatoria, anio: f.anio!, titulo: f.titulo, url: FICHA_BDNS + f.numero_convocatoria,
      convocatoriaId: f.cid, propia: f.numero_convocatoria === propio,
      apertura: dia(detalle.fechaInicioSolicitud) ?? f.inicio_solicitud ?? f.c_fecha ?? f.fecha_publicacion,
      cierre: dia(detalle.fechaFinSolicitud) ?? f.p_cierre ?? f.fin_solicitud,
      presupuesto: presupuesto ?? null,
      ganadores: concesiones.length || null,
      importeTotal: importes.length ? Math.round(total * 100) / 100 : null,
      importeMedio: importes.length ? Math.round((total / importes.length) * 100) / 100 : null,
      reforesta: mias.length ? 'gano' : concesiones.length ? 'no_figura' : 'sin_datos',
      importeReforesta: mias.length ? Math.round(mias.reduce((s, g) => s + (g.importe ?? 0), 0) * 100) / 100 : null,
    };
  });
}

/** Aperturas conocidas hasta `hoy` (una edición con apertura futura aún no es historia). */
export function aperturasPasadas(ediciones: EdicionSerie[], hoy: string): AperturaPasada[] {
  return ediciones.flatMap((e) => (e.apertura && e.apertura <= hoy ? [{ numero: e.numeroConvocatoria, anio: e.anio, apertura: e.apertura, cierre: e.cierre }] : []));
}

export interface ResumenSerie {
  /** Presupuesto total de la última edición (null si se desconoce). */
  ultimoPresupuesto: number | null;
  /** Mediana del número de concesiones de las ediciones con concesiones publicadas. */
  ganadoresTipicos: number | null;
  /** Mediana del importe medio por concesión de esas ediciones. */
  premioMedioTipico: number | null;
  /** Años de las ediciones que Reforesta ganó. */
  reforestaGano: number[];
}

export function resumenDeSerie(ediciones: EdicionSerie[]): ResumenSerie {
  const con = ediciones.filter((e) => e.ganadores !== null);
  return {
    ultimoPresupuesto: ediciones.at(-1)?.presupuesto ?? null,
    ganadoresTipicos: medianaRedondeada(con.map((e) => e.ganadores!)),
    premioMedioTipico: medianaRedondeada(con.flatMap((e) => (e.importeMedio !== null ? [e.importeMedio] : []))),
    reforestaGano: ediciones.filter((e) => e.reforesta === 'gano').map((e) => e.anio),
  };
}

export interface SerieFicha {
  /** Hay una clave de serie (el título no es demasiado genérico). */
  esSerie: boolean;
  ediciones: EdicionSerie[];
  /** Año de la edición que se predice (la siguiente a la última conocida). */
  anioSiguiente: number | null;
  /** null con menos de 2 ediciones pasadas con fecha de apertura. */
  prediccion: PrediccionApertura | null;
  resumen: ResumenSerie;
}

/** Línea de tiempo de la serie de una convocatoria y predicción de la siguiente edición. */
export function serieDeConvocatoria(db: DatabaseSync, c: Convocatoria, perfil: Perfil | null, hoy: string): SerieFicha {
  const serie = claveSerie(c.titulo, c.organo);
  const ediciones = serie ? historialDeSerie(db, serie, perfil, c.fuenteId) : [];
  return {
    esSerie: serie !== null,
    ediciones,
    anioSiguiente: ediciones.length ? ediciones[ediciones.length - 1].anio + 1 : null,
    prediccion: predecirApertura(aperturasPasadas(ediciones, hoy)),
    resumen: resumenDeSerie(ediciones),
  };
}

export interface SerieProxima {
  serie: string;
  titulo: string;
  estado: Exclude<EstadoApertura, 'lejos'>;
  /** Ventana de este año. */
  ventana: { desde: string; hasta: string };
  prediccion: PrediccionApertura;
  ultimaEdicion: EdicionSerie;
  resumen: ResumenSerie;
}

/**
 * Series que se espera que abran en los próximos `dias` días (o que ya deberían haber abierto este año). Solo las relevantes para el perfil:
 * alguna edición guardada pasó la criba (las reglas de ámbito ya la filtraron) y la última edición conocida no la descartó el equipo.
 * Se excluyen las que ya tienen la edición de este año (o posterior) y las que tienen menos de 2 aperturas pasadas conocidas.
 */
export function seriesProximas(db: DatabaseSync, ahora: Date, perfil: Perfil | null, dias: number = PROXIMAS_DIAS_POR_DEFECTO): SerieProxima[] {
  const hoy = diaLocal(ahora);
  const anio = Number(hoy.slice(0, 4));
  const { relevantes, descartadasPorEquipo } = relevantesBdns(db);
  const series = (db.prepare('SELECT serie, numero_convocatoria AS n FROM ediciones_serie').all() as { serie: string; n: string }[])
    .filter((f) => relevantes.has(f.n)).map((f) => f.serie);
  const resultado: SerieProxima[] = [];
  for (const serie of new Set(series)) {
    const ediciones = historialDeSerie(db, serie, perfil);
    const ultima = ediciones.at(-1);
    if (!ultima || ultima.anio >= anio || descartadasPorEquipo.has(ultima.numeroConvocatoria)) continue;
    const prediccion = predecirApertura(aperturasPasadas(ediciones, hoy));
    if (!prediccion) continue;
    const e = estadoApertura(prediccion, hoy, dias);
    if (e.estado === 'lejos') continue;
    resultado.push({
      serie, titulo: tituloParaMostrar(null, tituloSinAnio(ultima.titulo)), estado: e.estado, ventana: { desde: e.desde, hasta: e.hasta },
      prediccion, ultimaEdicion: ultima, resumen: resumenDeSerie(ediciones),
    });
  }
  // Primero las que abren antes (las retrasadas, tras las que están por abrir); desempate por título.
  return resultado.sort((a, b) => (a.estado === b.estado ? a.ventana.desde.localeCompare(b.ventana.desde) : a.estado === 'pronto' ? -1 : 1) || a.titulo.localeCompare(b.titulo));
}
