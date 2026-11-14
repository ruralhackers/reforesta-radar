// El informe público de "Cómo sabemos": se calcula SOLO con lo guardado por el backtest (nada privado) y lleva las cifras con su denominador.
import type { DatabaseSync } from 'node:sqlite';
import { PALABRAS_AMBIENTALES } from './conjuntos.ts';
import { type FilaConjunto, leerConjunto, leerResultados, type Modo, type ResultadoGuardado, totalEjecuciones } from './db.ts';

const FICHA_BDNS = 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/';

export interface FilaInformeA {
  numero: string;
  etiqueta: string | null;
  titulo: string;
  fechaPublicacion: string;
  urlBdns: string;
  notas: string[];
  /** null = aún sin calcular. */
  resultado: {
    pasoReglas: boolean;
    motivoReglas: string | null;
    pasoCriba: boolean;
    motivoCriba: string | null;
    etapa: ResultadoGuardado['etapa'];
    puntuacion: number | null;
    factores: unknown[];
    completa: boolean;
    destacada: boolean;
    /** Éxito = pasa reglas y criba y su puntuación llega al umbral de "destacada". Provisional nunca cuenta. */
    exito: boolean;
  } | null;
}

export interface FilaInformeB {
  numero: string;
  titulo: string;
  organo: string;
  fechaPublicacion: string;
  urlBdns: string;
  reglas: string[];
  ganadoras: string[];
  procesada: boolean;
  pasoReglas: boolean | null;
  pasoCriba: boolean | null;
  etapa: string | null;
  motivo: string | null;
  puntuacion: number | null;
  destacada: boolean | null;
}

export interface MetricaB {
  /** Admitidas por las reglas objetivas (denominador de "encajaban"). */
  conjunto: number;
  /** De ellas, procesadas con resultado definitivo (denominador de los porcentajes). */
  procesadas: number;
  provisionales: number;
  sinProcesar: number;
  /** BDNS no devolvió el detalle. */
  sinDatos: number;
  pasanCriba: number;
  porcentajePasaCriba: number | null;
  /** Puntuaciones de las que pasan la criba. */
  puntuaciones: number[];
  medianaPuntuacion: number | null;
  distribucion: { etiqueta: string; n: number }[];
  destacadas: number;
  /** Encajaban (reglas objetivas), las ganó una parecida y Reforesta no figura entre los ganadores (por construcción del conjunto). */
  encajabanSinReforesta: number;
}

export interface InformeModo {
  modo: Modo;
  umbral: number;
  a: { filas: FilaInformeA[]; total: number; calculadas: number; completas: number; exitos: number; pasanReglas: number; pasanCriba: number };
  b: { filas: FilaInformeB[]; metrica: MetricaB; excluidas: { motivo: string; n: number }[]; examinadas: number };
  titular: string;
  titularB: string | null;
  coste: { ejecuciones: number; llamadas: number; costeUsd: number };
}

export interface Informe {
  generadoEn: string;
  modos: Partial<Record<Modo, InformeModo>>;
  reglasB: { palabrasAmbientales: string[] };
}

const mediana = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);

const CUBOS: [string, (p: number) => boolean][] = [
  ['menos de 20', (p) => p < 20], ['20–29', (p) => p >= 20 && p < 30], ['30–39', (p) => p >= 30 && p < 40],
  ['40–49', (p) => p >= 40 && p < 50], ['50–59', (p) => p >= 50 && p < 60], ['60 o más', (p) => p >= 60],
];

export function metricaB(conjunto: FilaConjunto[], resultados: ResultadoGuardado[]): MetricaB {
  const admitidas = conjunto.filter((c) => c.admitida);
  const porNumero = new Map(resultados.filter((r) => r.conjunto === 'b').map((r) => [r.numero, r]));
  const con = admitidas.map((c) => porNumero.get(c.numero)).filter((r): r is ResultadoGuardado => !!r);
  const definitivas = con.filter((r) => r.completa);
  const sinDatos = con.filter((r) => r.etapa === 'sin_datos').length;
  const pasan = definitivas.filter((r) => r.pasoCriba);
  const puntuaciones = pasan.flatMap((r) => (r.puntuacion === null ? [] : [r.puntuacion]));
  return {
    conjunto: admitidas.length, procesadas: definitivas.length, provisionales: con.length - definitivas.length - sinDatos, sinProcesar: admitidas.length - con.length, sinDatos,
    pasanCriba: pasan.length, porcentajePasaCriba: pct(pasan.length, definitivas.length), puntuaciones: puntuaciones.sort((a, b) => a - b),
    medianaPuntuacion: mediana(puntuaciones), distribucion: CUBOS.map(([etiqueta, f]) => ({ etiqueta, n: puntuaciones.filter(f).length })),
    destacadas: definitivas.filter((r) => r.destacada).length, encajabanSinReforesta: admitidas.length,
  };
}

function informeModo(modo: Modo, conjuntoA: FilaConjunto[], conjuntoB: FilaConjunto[], resultados: ResultadoGuardado[], coste: InformeModo['coste']): InformeModo {
  const resA = new Map(resultados.filter((r) => r.conjunto === 'a').map((r) => [r.numero, r]));
  const resB = new Map(resultados.filter((r) => r.conjunto === 'b').map((r) => [r.numero, r]));
  const umbral = resultados[0]?.umbral ?? 0;
  const filasA: FilaInformeA[] = conjuntoA.map((c) => {
    const r = resA.get(c.numero) ?? null;
    return {
      numero: c.numero, etiqueta: c.etiqueta, titulo: c.titulo, fechaPublicacion: c.fechaPublicacion, urlBdns: FICHA_BDNS + c.numero, notas: c.reglas,
      resultado: r && {
        pasoReglas: r.pasoReglas, motivoReglas: r.motivoReglas, pasoCriba: r.pasoCriba, motivoCriba: r.motivoCriba, etapa: r.etapa, puntuacion: r.puntuacion,
        factores: r.factores, completa: r.completa, destacada: r.destacada, exito: r.completa && r.pasoReglas && r.pasoCriba && r.destacada,
      },
    };
  });
  const filasB: FilaInformeB[] = conjuntoB.filter((c) => c.admitida).map((c) => {
    const r = resB.get(c.numero) ?? null;
    return {
      numero: c.numero, titulo: c.titulo, organo: c.organo, fechaPublicacion: c.fechaPublicacion, urlBdns: FICHA_BDNS + c.numero, reglas: c.reglas,
      ganadoras: c.ganadoras.map((g) => g.nombre), procesada: !!r && r.completa, pasoReglas: r ? r.pasoReglas : null, pasoCriba: r ? r.pasoCriba : null,
      etapa: r?.etapa ?? null, motivo: r ? (r.motivoReglas ?? r.motivoCriba) : null, puntuacion: r?.puntuacion ?? null, destacada: r ? r.destacada : null,
    };
  });
  const motivos = new Map<string, number>();
  for (const c of conjuntoB.filter((x) => !x.admitida)) {
    const m = (c.reglas[0] ?? 'sin motivo').replace(/\s*[(:].*$/s, '').replace(/\d{4}-\d{2}-\d{2}/, '…').replace(/Registrada en BDNS el … antes de 2022/, 'Registrada antes de 2022');
    const clave = m.startsWith('Fuera del ámbito') ? 'Fuera del ámbito del perfil' : m;
    motivos.set(clave, (motivos.get(clave) ?? 0) + 1);
  }
  const exitos = filasA.filter((f) => f.resultado?.exito).length;
  const completas = filasA.filter((f) => f.resultado?.completa).length;
  const metrica = metricaB(conjuntoB, resultados);
  const totalA = filasA.length;
  const titular = completas === totalA && totalA > 0
    ? `De las ${totalA} convocatorias conocidas (las de Reforesta y los ejemplos del reto), el radar habría pasado ${exitos} por las reglas y la criba con puntuación destacada (${umbral} o más).`
    : `Backtest (a) incompleto: ${completas} de ${totalA} convocatorias calculadas hasta ahora (${exitos} destacadas).`;
  const titularB = metrica.procesadas
    ? `Además, de ${metrica.procesadas} convocatorias que encajaban por reglas objetivas, ganaron organizaciones parecidas y donde Reforesta no figura entre los ganadores, el radar habría dejado pasar la criba a ${metrica.pasanCriba} (${metrica.porcentajePasaCriba} %) y destacado ${metrica.destacadas}.`
    : null;
  return {
    modo, umbral,
    a: {
      filas: filasA, total: totalA, calculadas: filasA.filter((f) => f.resultado).length, completas, exitos,
      pasanReglas: filasA.filter((f) => f.resultado?.completa && f.resultado.pasoReglas).length, pasanCriba: filasA.filter((f) => f.resultado?.completa && f.resultado.pasoCriba).length,
    },
    b: { filas: filasB, metrica, excluidas: [...motivos].map(([motivo, n]) => ({ motivo, n })).sort((x, y) => y.n - x.n), examinadas: conjuntoB.length },
    titular, titularB, coste,
  };
}

export function construirInforme(db: DatabaseSync, ahora: Date): Informe {
  const a = leerConjunto(db, 'a');
  const b = leerConjunto(db, 'b');
  const resultados = leerResultados(db);
  const modos: Informe['modos'] = {};
  for (const modo of ['sin_analisis', 'con_analisis'] as const) {
    const rs = resultados.filter((r) => r.modo === modo);
    if (!rs.length) continue;
    modos[modo] = informeModo(modo, a, b, rs, totalEjecuciones(db, modo));
  }
  return { generadoEn: ahora.toISOString(), modos, reglasB: { palabrasAmbientales: PALABRAS_AMBIENTALES } };
}
