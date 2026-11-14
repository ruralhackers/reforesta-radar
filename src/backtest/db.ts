// Tablas del backtest (migración 17). Nada de aquí toca las convocatorias, decisiones o ranking vivos.
import type { DatabaseSync } from 'node:sqlite';
import { transaccion } from '../db/repo.ts';

export type Modo = 'sin_analisis' | 'con_analisis';
export type Conjunto = 'a' | 'b';

export interface FilaConjunto {
  conjunto: Conjunto;
  numero: string;
  titulo: string;
  organo: string;
  finalidad: string | null;
  fechaPublicacion: string;
  admitida: boolean;
  /** (b) reglas que la admiten, o el motivo de exclusión si no está admitida. (a) notas. */
  reglas: string[];
  /** (b) parecidas que la ganaron. */
  ganadoras: { nif: string; nombre: string }[];
  etiqueta: string | null;
  orden: string;
}

export interface ResultadoGuardado {
  conjunto: Conjunto;
  numero: string;
  modo: Modo;
  pasoReglas: boolean;
  motivoReglas: string | null;
  pasoCriba: boolean;
  motivoCriba: string | null;
  etapa: 'sin_datos' | 'reglas' | 'criba_llm' | 'analisis' | 'puntuacion' | 'puntuada' | 'pendiente';
  puntuacion: number | null;
  factores: unknown[];
  /** Pasa las reglas y la criba y su puntuación (con el reloj en su fecha de publicación) llega al umbral de "destacada". */
  destacada: boolean;
  umbral: number;
  /** false = criba sin hacer por el tope de llamadas: provisional. */
  completa: boolean;
}

export function guardarConjunto(db: DatabaseSync, filas: FilaConjunto[], ahora: Date): void {
  const q = db.prepare(`
    INSERT INTO backtest_conjunto (conjunto, numero, titulo, organo, finalidad, fecha_publicacion, admitida, reglas, ganadoras, etiqueta, orden, creada_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (conjunto, numero) DO UPDATE SET titulo = excluded.titulo, organo = excluded.organo, finalidad = excluded.finalidad,
      fecha_publicacion = excluded.fecha_publicacion, admitida = excluded.admitida, reglas = excluded.reglas,
      ganadoras = excluded.ganadoras, etiqueta = excluded.etiqueta, orden = excluded.orden, creada_en = excluded.creada_en`);
  transaccion(db, () => {
    for (const f of filas) {
      q.run(f.conjunto, f.numero, f.titulo, f.organo, f.finalidad, f.fechaPublicacion, Number(f.admitida), JSON.stringify(f.reglas),
        JSON.stringify(f.ganadoras), f.etiqueta, f.orden, ahora.toISOString());
    }
  });
}

export function borrarConjunto(db: DatabaseSync, conjunto: Conjunto): void {
  db.prepare('DELETE FROM backtest_conjunto WHERE conjunto = ?').run(conjunto);
  db.prepare('DELETE FROM backtest_resultados WHERE conjunto = ?').run(conjunto);
}

export function leerConjunto(db: DatabaseSync, conjunto: Conjunto): FilaConjunto[] {
  const filas = db.prepare('SELECT * FROM backtest_conjunto WHERE conjunto = ? ORDER BY fecha_publicacion, numero').all(conjunto) as Record<string, unknown>[];
  return filas.map((f) => ({
    conjunto, numero: String(f.numero), titulo: String(f.titulo), organo: String(f.organo), finalidad: (f.finalidad as string | null) ?? null,
    fechaPublicacion: String(f.fecha_publicacion), admitida: f.admitida === 1,
    reglas: JSON.parse(String(f.reglas)) as string[], ganadoras: JSON.parse(String(f.ganadoras)) as FilaConjunto['ganadoras'],
    etiqueta: (f.etiqueta as string | null) ?? null, orden: String(f.orden),
  }));
}

export function guardarResultado(db: DatabaseSync, r: ResultadoGuardado, ahora: Date): void {
  db.prepare(`
    INSERT INTO backtest_resultados (conjunto, numero, modo, paso_reglas, motivo_reglas, paso_criba, motivo_criba, etapa, puntuacion, factores, destacada, umbral, completa, calculado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (conjunto, numero, modo) DO UPDATE SET paso_reglas = excluded.paso_reglas, motivo_reglas = excluded.motivo_reglas,
      paso_criba = excluded.paso_criba, motivo_criba = excluded.motivo_criba, etapa = excluded.etapa, puntuacion = excluded.puntuacion,
      factores = excluded.factores, destacada = excluded.destacada, umbral = excluded.umbral, completa = excluded.completa, calculado_en = excluded.calculado_en`)
    .run(r.conjunto, r.numero, r.modo, Number(r.pasoReglas), r.motivoReglas, Number(r.pasoCriba), r.motivoCriba, r.etapa, r.puntuacion,
      JSON.stringify(r.factores), Number(r.destacada), r.umbral, Number(r.completa), ahora.toISOString());
}

export function leerResultados(db: DatabaseSync, modo?: Modo): ResultadoGuardado[] {
  const filas = (modo
    ? db.prepare('SELECT * FROM backtest_resultados WHERE modo = ?').all(modo)
    : db.prepare('SELECT * FROM backtest_resultados').all()) as Record<string, unknown>[];
  return filas.map((f) => ({
    conjunto: f.conjunto as Conjunto, numero: String(f.numero), modo: f.modo as Modo, pasoReglas: f.paso_reglas === 1, motivoReglas: (f.motivo_reglas as string | null) ?? null,
    pasoCriba: f.paso_criba === 1, motivoCriba: (f.motivo_criba as string | null) ?? null, etapa: f.etapa as ResultadoGuardado['etapa'],
    puntuacion: f.puntuacion === null ? null : Number(f.puntuacion), factores: JSON.parse(String(f.factores)) as unknown[],
    destacada: f.destacada === 1, umbral: Number(f.umbral), completa: f.completa === 1,
  }));
}

export function guardarEjecucion(db: DatabaseSync, modo: Modo, ahora: Date, llamadas: number, costeUsd: number): void {
  db.prepare('INSERT INTO backtest_ejecuciones (modo, empezada_en, llamadas, coste_usd) VALUES (?, ?, ?, ?)').run(modo, ahora.toISOString(), llamadas, costeUsd);
}

export function totalEjecuciones(db: DatabaseSync, modo: Modo): { ejecuciones: number; llamadas: number; costeUsd: number } {
  const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(llamadas), 0) AS l, COALESCE(SUM(coste_usd), 0) AS c FROM backtest_ejecuciones WHERE modo = ?').get(modo) as { n: number; l: number; c: number };
  return { ejecuciones: r.n, llamadas: r.l, costeUsd: Math.round(r.c * 10000) / 10000 };
}
