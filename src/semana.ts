// "Esta semana" como dato: las candidatas en juego, puntuadas con el reloj de ahora y repartidas en secciones.
// Lo usan la API (/api/semana) y el correo del lunes, para que ambos cuenten lo mismo.
import type { DatabaseSync } from 'node:sqlite';
import { diaLocal } from './dates.ts';
import { filasRanking, leerConvocatoria, leerFases, leerPerfil } from './db/repo.ts';
import { FASE_ANALISIS } from './fases/analisis.ts';
import type { Analisis } from './fases/analisis-esquema.ts';
import { puntuarConvocatoria } from './fases/puntuacion.ts';
import { infoParecidas } from './parecidas.ts';
import type { ConfigPuntuacion, ProveedorProbabilidad } from './puntuacion.ts';
import { construirRanking, cortarSemana } from './ranking.ts';
import { porQue, textoImporte } from './correo.ts';
import { umbralDelPerfil } from './perfil.ts';
import { tituloParaMostrar } from './titulo.ts';
import { empresasNuevasEntre } from './db/empresas.ts';
import { sumarDias } from './dates.ts';

/** Ranking con secciones y marca de "parecidas". Ya excluye cerradas, excluidas por puntuación y descartadas por el equipo. */
export function calcularRanking(db: DatabaseSync, ahora: Date, cfg: ConfigPuntuacion, probabilidad: ProveedorProbabilidad) {
  const hoy = diaLocal(ahora);
  const perfil = leerPerfil(db);
  const importeMinimo = perfil?.importeMinimo ?? null;
  // La puntuación se calcula aquí, con el reloj de la petición (función pura y barata): total, explicación de cierre y secciones coherentes.
  const conParecidas = filasRanking(db, hoy, (conv, plazo) => puntuarConvocatoria(db, conv, plazo, importeMinimo, cfg, probabilidad, hoy), ahora)
    .map((f) => ({ ...f, parecidas: infoParecidas(db, leerConvocatoria(db, f.id)!.convocatoria, perfil) }));
  return construirRanking(conParecidas, hoy, { nuevasDias: cfg.nuevasDias, cierranProntoDias: cfg.cierranProntoDias });
}

/** Lo que enseña una tarjeta además de lo básico: título corto, importe, líneas de Reforesta y una frase de por qué encaja. */
export interface ResumenTarjeta {
  tituloCorto: string;
  /** null = sin analizar o sin importe en los textos. */
  importe: string | null;
  lineas: string[];
  porQue: string | null;
}

const frasePunto = (t: string) => { const l = t.replace(/\s+/g, ' ').trim(); return l ? (/[.!?]$/.test(l) ? l : `${l}.`) : null; };

export function resumenTarjeta(db: DatabaseSync, id: string, tituloOficial: string, puntuacion: Parameters<typeof porQue>[0]): ResumenTarjeta {
  const datos = leerFases(db, id).find((f) => f.fase === FASE_ANALISIS)?.datos as { analisis?: Analisis } | undefined;
  const a = datos?.analisis ?? null;
  const importe = a && (a.importeMaximoProyecto.valor || a.importeTotal.valor) ? textoImporte(a) : null;
  const motivo = a?.lineas.find((l) => l.motivo)?.motivo ?? null;
  return {
    tituloCorto: tituloParaMostrar(a?.tituloCorto, tituloOficial),
    importe,
    lineas: a?.lineas.map((l) => l.linea) ?? [],
    porQue: (motivo ? frasePunto(motivo) : null) ?? (a ? porQue(puntuacion) ?? null : null),
  };
}

/** "Esta semana" completa para la API: ranking + corte (umbral del perfil, máximo 7) + frase de resumen. Las filas llevan su `ResumenTarjeta`. */
export function calcularSemana(db: DatabaseSync, ahora: Date, cfg: ConfigPuntuacion, probabilidad: ProveedorProbabilidad) {
  const filas = calcularRanking(db, ahora, cfg, probabilidad);
  const umbral = umbralDelPerfil(leerPerfil(db));
  const { paraPreparar, conMenosEncaje } = cortarSemana(filas, umbral);
  const hoy = diaLocal(ahora);
  // Solo las relevantes: con DIA o que compensan su huella dentro de los territorios del perfil (no todo lo que el registro trae por primera vez).
  const perfil = leerPerfil(db);
  const empresasNuevas = empresasNuevasEntre(db, sumarDias(hoy, -(cfg.nuevasDias - 1)), hoy, perfil).length;
  return {
    filas, umbral, paraPreparar, conMenosEncaje, empresasNuevas,
    // "cierran pronto" de la frase: las de arriba que cierran en menos de tres semanas.
    cierranPronto: paraPreparar.filter((f) => f.plazo?.diasHastaCierre != null && f.plazo.diasHastaCierre <= cfg.cierranProntoDias).length,
  };
}
