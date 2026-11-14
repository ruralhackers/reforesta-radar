// Licitaciones (fuente placsp) como dato: las abiertas que pasaron la criba LLM, puntuadas con el reloj de ahora y partidas en las que están «para preparar» (analizadas
// y con puntuación >= umbral del perfil) y las demás (sin analizar, con menos encaje o fuera de escala), plegadas. Lo usan la API (/api/licitaciones, /api/semana, /api/contadores).
// Las licitaciones no entran en "Esta semana" ni en el correo (ver FUENTE_LICITACIONES en db/repo.ts): tienen su propia página.
import type { DatabaseSync } from 'node:sqlite';
import { diaLocal } from './dates.ts';
import { filasLicitaciones, leerFases, leerPerfil } from './db/repo.ts';
import { FASE_ANALISIS } from './fases/analisis.ts';
import { esAnalisisLicitacion } from './fases/analisis-licitacion-esquema.ts';
import { puntuarConvocatoria } from './fases/puntuacion.ts';
import { ingresosAnuales, presupuestoMaximoLicitacion, umbralDelPerfil } from './perfil.ts';
import { type ConfigPuntuacion, ponderacionDelPrecio, presupuestoEfectivo } from './puntuacion.ts';
import { type Licitacion, licitacionDe } from './sources/placsp.ts';
import { tituloParaMostrar } from './titulo.ts';
import type { Convocatoria } from './types.ts';

/** Lo que enseña la tarjeta de una licitación (y la cabecera de su ficha), además de título, órgano y plazo. */
export interface ResumenTarjetaLicitacion {
  tituloCorto: string;
  /** Presupuesto base sin IVA, en euros (null = no consta o por precios unitarios). */
  presupuesto: number | null;
  /** Con varios lotes, el presupuesto que cuenta es el del lote más pequeño. */
  presupuestoDeLote: boolean;
  /** Valor estimado del contrato (con prórrogas y modificaciones), si difiere del presupuesto base. */
  valorEstimado: number | null;
  /** Presupuesto por encima del máximo del perfil: «probablemente fuera de escala». */
  fueraDeEscala: boolean;
  /** «Sin lotes», «3 lotes (de 12.000 a 40.000 €)»; null si no se sabe. */
  lotes: string | null;
  procedimiento: string | null;
  tipoContrato: string | null;
  duracion: string | null;
  /** Titular de la solvencia: lo que dice el análisis (con cita) o, sin él, el anuncio (origen 'anuncio'); null si nada la cifra. */
  solvencia: { texto: string; origen: 'analisis' | 'anuncio' } | null;
  /** Puntos del precio sobre 100 (null = no consta). */
  ponderacionPrecio: number | null;
  /** Una frase de por qué encaja: la del análisis o, sin él, la de la criba. */
  porQue: string | null;
  lineas: string[];
  /** Contrato reservado a otro tipo de entidad (centros especiales de empleo…). */
  reservado: boolean;
}

const euros = (n: number) => `${Math.round(n).toLocaleString('es-ES')} €`;
const frasePunto = (t: string) => { const l = t.replace(/\s+/g, ' ').trim(); return l ? (/[.!?]$/.test(l) ? l : `${l}.`) : null; };
const corto = (t: string, max: number) => { const l = t.replace(/\s+/g, ' ').trim(); return l.length <= max ? l : `${l.slice(0, max - 1).replace(/[\s,;:.]+$/, '')}…`; };

function textoLotes(l: Licitacion | null): string | null {
  if (!l) return null;
  if (l.lotes.length === 0) return 'Sin lotes';
  const importes = l.lotes.map((x) => x.presupuestoSinIva).filter((x): x is number => x != null && x > 0);
  const n = `${l.lotes.length} ${l.lotes.length === 1 ? 'lote' : 'lotes'}`;
  if (importes.length === 0) return n;
  const [min, max] = [Math.min(...importes), Math.max(...importes)];
  return min === max ? `${n} de ${euros(min)}` : `${n} (de ${euros(min)} a ${euros(max)})`;
}

export function resumenTarjetaLicitacion(db: DatabaseSync, c: Convocatoria): ResumenTarjetaLicitacion {
  const l = licitacionDe(c);
  const fases = leerFases(db, c.id);
  const datos = fases.find((f) => f.fase === FASE_ANALISIS)?.datos as { analisis?: unknown } | undefined;
  const a = esAnalisisLicitacion(datos?.analisis) ? datos.analisis : null;
  const criba = fases.find((f) => f.fase === 'criba_llm');
  const maximo = presupuestoMaximoLicitacion(leerPerfil(db));
  const { importe, deLote } = presupuestoEfectivo(l, a);
  const textoSolvencia = a?.solvenciaEconomica.valor ?? null;
  const solvenciaAnuncio = l?.solvenciaEconomica[0] ?? null;
  const motivo = a?.lineas.find((x) => x.motivo)?.motivo ?? (criba && !criba.descarta ? criba.motivo : null);
  return {
    tituloCorto: tituloParaMostrar(a?.tituloCorto, c.titulo),
    presupuesto: importe, presupuestoDeLote: deLote,
    valorEstimado: l?.valorEstimado != null && l.valorEstimado > 0 && l.valorEstimado !== l.presupuestoSinIva ? l.valorEstimado : null,
    fueraDeEscala: importe !== null && importe > maximo,
    lotes: textoLotes(l), procedimiento: l?.procedimiento ?? null, tipoContrato: l?.tipoContrato ?? null, duracion: a?.duracion.valor ?? l?.duracion ?? null,
    solvencia: textoSolvencia ? { texto: corto(textoSolvencia, 160), origen: 'analisis' } : solvenciaAnuncio ? { texto: corto(solvenciaAnuncio, 160), origen: 'anuncio' } : null,
    ponderacionPrecio: ponderacionDelPrecio(l, a).puntos,
    porQue: motivo ? frasePunto(motivo) : null,
    lineas: a?.lineas.map((x) => x.linea) ?? [],
    reservado: a?.reservaSocial.valor === 'si',
  };
}

/** Licitaciones abiertas que pasaron la criba, puntuadas ahora, de mejor a peor, con el corte: analizadas y con puntuación >= umbral = «para preparar». */
export function calcularLicitaciones(db: DatabaseSync, ahora: Date, cfg: ConfigPuntuacion) {
  const hoy = diaLocal(ahora);
  const perfil = leerPerfil(db);
  const importeMinimo = perfil?.importeMinimo ?? null;
  const filas = filasLicitaciones(db, hoy, (conv, plazo) => puntuarConvocatoria(db, conv, plazo, importeMinimo, cfg, undefined, hoy), ahora)
    .filter((f) => !f.puntuacion?.excluida && !(f.plazo?.diasHastaCierre != null && f.plazo.diasHastaCierre < 0))
    .sort((a, b) => (b.puntuacion?.total ?? -1) - (a.puntuacion?.total ?? -1)
      || (a.plazo?.fechaCierre ?? '9999').localeCompare(b.plazo?.fechaCierre ?? '9999') || a.id.localeCompare(b.id));
  const umbral = umbralDelPerfil(perfil);
  const paraPreparar = filas.filter((f) => f.puntuacion?.analizada && f.puntuacion.total >= umbral);
  const dentro = new Set(paraPreparar.map((f) => f.id));
  return {
    filas, umbral, paraPreparar, conMenosEncaje: filas.filter((f) => !dentro.has(f.id)),
    presupuestoMaximo: presupuestoMaximoLicitacion(perfil), ingresosAnuales: ingresosAnuales(perfil),
  };
}
