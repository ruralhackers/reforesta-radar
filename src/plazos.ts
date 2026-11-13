// Plazo de solicitud de una convocatoria: fecha de cierre literal, calculada o desconocida. Todo determinista (sin LLM).
//
// Orden de preferencia: (1) fecha de fin explícita de la fuente; (2) fecha escrita en el texto del plazo;
// (3) plazo expresado como cómputo desde la publicación, que se calcula; (4) desconocida, con el texto original.
//
// Cómputo soportado (Ley 39/2015, art. 30), siempre "desde la publicación" (de la convocatoria o de su extracto):
//   · "N días hábiles" (N en cifras o en letra, con "(N)" opcional) y "décimo quinto día hábil": se cuentan a partir del
//     día siguiente a la publicación, sin sábados, domingos ni festivos del calendario (seed/festivos.json).
//   · "N días naturales": se suman al día de publicación; si el último día es inhábil, pasa al primer hábil siguiente.
//   · "N días hábiles desde el inicio del plazo" solo si el texto de inicio dice "día siguiente a la publicación"
//     (el inicio es entonces el día siguiente y se cuenta incluyéndolo: mismo resultado que desde la publicación).
//   · "N días" sin calificar: se entienden hábiles (art. 30.2) y el detalle lo dice.
//   · "un mes", "N meses": de fecha a fecha (mismo número de día que la publicación; si el mes de vencimiento no lo
//     tiene, su último día); si cae en día inhábil, pasa al primer hábil siguiente.
// No soportado → desconocida (con el motivo): "desde el inicio del plazo" con inicio ausente o distinto, notificación/aprobación/apertura,
// semanas, "días laborables", varios plazos distintos en el mismo texto, plazos sin referencia a la publicación,
// y cualquier cálculo que cruce un año sin festivos en el fichero.
import { diaDeLaSemana, sumarDias, sumarMeses } from './dates.ts';
import { esHabil, SinFestivosDelAnio, type calendario } from './festivos.ts';

export type TipoPlazo = 'literal' | 'calculada' | 'desconocida';

/** Lo que la fuente sabe del plazo de una convocatoria. */
export interface DatosPlazo {
  /** Fecha de fin de solicitudes explícita (YYYY-MM-DD). */
  fechaFin: string | null;
  textoFin: string | null;
  textoInicio: string | null;
  /** Publicaciones oficiales (extracto en boletín) con su fecha y el nombre del diario. */
  publicaciones: { dia: string; diario: string | null }[];
  /** Fecha de registro/publicación de la convocatoria en la propia fuente (YYYY-MM-DD). */
  registro: string;
}

export interface Plazo {
  /** YYYY-MM-DD; null si desconocida. */
  fechaCierre: string | null;
  tipo: TipoPlazo;
  /** Texto del plazo tal como lo da la fuente (o el análisis). */
  textoOriginal: string | null;
  /** Día de publicación desde el que se contó (solo calculada). */
  fechaBase: string | null;
  /** `extracto`: fecha de publicación del extracto en boletín; `registro`: fecha de registro en la fuente. */
  baseOrigen: 'extracto' | 'registro' | null;
  /** true si la base es solo el registro en la fuente (la publicación real puede ser posterior: el cierre real, también). */
  aproximada: boolean;
  /** Cómo se llegó a esa fecha, o por qué no se pudo. */
  detalle: string;
}

export type Calendario = ReturnType<typeof calendario>;

const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const NUMEROS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11,
  doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, treinta: 30,
  cuarenta: 40, sesenta: 60,
};
const ORDINALES: Record<string, number> = {
  quinto: 5, decimo: 10, decimoquinto: 15, 'decimo quinto': 15, vigesimo: 20, trigesimo: 30,
};
const PALABRAS = Object.keys(NUMEROS).sort((a, b) => b.length - a.length).join('|');
const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9,
  octubre: 10, noviembre: 11, diciembre: 12,
};

interface Computo {
  n: number;
  unidad: 'habiles' | 'naturales' | 'meses';
  sinCalificar: boolean;
}

function diaValido(y: number, m: number, d: number): string | null {
  const f = new Date(Date.UTC(y, m - 1, d));
  if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Si el texto es solo una fecha ("15 de septiembre 2025", "09/05/2025", "hasta el 3 de marzo de 2026"), la devuelve. */
export function fechaEnTexto(texto: string): string | null {
  const t = norm(texto);
  if ('computo' in interpretarComputo(texto)) return null;
  const encontradas = new Set<string>();
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    const d = diaValido(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d) encontradas.add(d);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s+de\s+([a-z]+)\s+(?:de\s+)?(\d{4})\b/g)) {
    const mes = MESES[m[2]];
    const d = mes ? diaValido(Number(m[3]), mes, Number(m[1])) : null;
    if (d) encontradas.add(d);
  }
  return encontradas.size === 1 ? [...encontradas][0] : null;
}

/** Interpreta un texto de plazo como cómputo. `null` + motivo si no se reconoce o es ambiguo. */
export function interpretarComputo(texto: string): { computo: Computo } | { motivo: string } {
  const t = norm(texto);
  if (/laborable/.test(t)) return { motivo: 'Habla de días laborables (no se sabe si cuentan los sábados)' };
  if (/semana/.test(t)) return { motivo: 'Plazo en semanas: no soportado' };
  const hallados = new Map<string, Computo>();
  const poner = (c: Computo) => hallados.set(`${c.n}-${c.unidad}`, c);

  const reCantidad = new RegExp(
    `\\b(\\d{1,3}|${PALABRAS})(?:\\s+y\\s+(?:un|uno))?\\s*(?:\\(\\d{1,3}\\)\\s*)?(dias?|meses|mes)\\b(\\s*\\(\\d{1,3}\\))?(\\s+(habiles|naturales)\\b)?`, 'g',
  );
  for (const m of t.matchAll(reCantidad)) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : NUMEROS[m[1]];
    if (!n) continue;
    if (m[2].startsWith('mes')) poner({ n, unidad: 'meses', sinCalificar: false });
    else if (m[5] === 'naturales') poner({ n, unidad: 'naturales', sinCalificar: false });
    else poner({ n, unidad: 'habiles', sinCalificar: m[5] !== 'habiles' });
  }
  for (const m of t.matchAll(/\b(decimo quinto|decimoquinto|decimo|vigesimo|trigesimo|quinto)\s+dia\s+habil\b/g)) {
    poner({ n: ORDINALES[m[1]], unidad: 'habiles', sinCalificar: false });
  }
  if (hallados.size === 0) return { motivo: 'No se reconoce un plazo contado en días o meses' };
  if (hallados.size > 1) return { motivo: 'El texto da varios plazos distintos' };
  return { computo: [...hallados.values()][0] };
}

/** El inicio del plazo es el día siguiente a la publicación (sin otras condiciones): entonces "desde el inicio" = desde la publicación. */
const INICIO_DIA_SIGUIENTE_PUBLICACION = /^(desde )?(el )?(dia )?siguiente (al de |a )?(la |su )?publicacion\b[^,;]*$/;

/** ¿Se cuenta desde la publicación? Mira el texto del plazo (y el de inicio, solo para encontrar la referencia). */
function desdePublicacion(contar: string, inicio: string | null): string | null {
  const t = norm(contar);
  if (/notificacion|aprobacion|apertura|vencimiento|finalizacion/.test(t)) {
    return 'No se cuenta desde la publicación (sino desde la notificación, la aprobación o la apertura)';
  }
  if (/\binicio\b/.test(t) && !(inicio && INICIO_DIA_SIGUIENTE_PUBLICACION.test(norm(inicio)))) {
    return 'Se cuenta desde el inicio del plazo y el texto de inicio no dice que sea el día siguiente a la publicación';
  }
  if (!/public/.test(t) && !(inicio && /public/.test(norm(inicio)))) return 'El texto no dice desde cuándo se cuenta (no menciona la publicación)';
  return null;
}

/** Fecha de publicación de referencia: la del extracto en el diario que cita el texto (o la más temprana). */
function elegirBase(datos: DatosPlazo, texto: string): { dia: string; origen: 'extracto' | 'registro' } {
  const t = norm(`${texto} ${datos.textoInicio ?? ''}`);
  const coincidentes = datos.publicaciones.filter((p) => {
    const sigla = norm(p.diario ?? '').split(/[.\s]/)[0];
    return sigla.length >= 3 && new RegExp(`\\b${sigla}\\b`).test(t);
  });
  const candidatas = (coincidentes.length ? coincidentes : datos.publicaciones).map((p) => p.dia).sort();
  return candidatas.length ? { dia: candidatas[0], origen: 'extracto' } : { dia: datos.registro, origen: 'registro' };
}

const fmt = (dia: string) => dia.split('-').reverse().join('/');

function sumarHabiles(cal: Calendario, desde: string, n: number): { fin: string; saltados: string[] } {
  let d = desde;
  let contados = 0;
  const saltados: string[] = [];
  while (contados < n) {
    d = sumarDias(d, 1);
    if (esHabil(cal, d)) contados++;
    else if (diaDeLaSemana(d) !== 0 && diaDeLaSemana(d) !== 6) {
      const f = cal.festivo(d);
      if (f) saltados.push(`${fmt(d)} ${f}`);
    }
  }
  return { fin: d, saltados };
}

function primerHabil(cal: Calendario, desde: string): { fin: string; movido: boolean } {
  let d = desde;
  while (!esHabil(cal, d)) d = sumarDias(d, 1);
  return { fin: d, movido: d !== desde };
}

export function calcularPlazo(datos: DatosPlazo, textoAnalisis: string | null, cal: Calendario): Plazo {
  const textoOriginal = datos.textoFin?.trim() || textoAnalisis?.trim() || null;
  const base: Plazo = { fechaCierre: null, tipo: 'desconocida', textoOriginal, fechaBase: null, baseOrigen: null, aproximada: false, detalle: '' };

  if (datos.fechaFin) return { ...base, fechaCierre: datos.fechaFin, tipo: 'literal', detalle: 'Fecha de fin de solicitudes indicada por la fuente' };

  const textos = [datos.textoFin, textoAnalisis].filter((t): t is string => !!t?.trim());
  for (const t of textos) {
    const f = fechaEnTexto(t);
    if (f) return { ...base, fechaCierre: f, tipo: 'literal', textoOriginal: t.trim(), detalle: 'Fecha escrita en el texto del plazo' };
  }

  const motivos: string[] = [];
  for (const t of textos) {
    const r = interpretarComputo(t);
    if ('motivo' in r) { motivos.push(r.motivo); continue; }
    const sinAncla = desdePublicacion(t, datos.textoInicio);
    if (sinAncla) { motivos.push(sinAncla); continue; }
    const { n, unidad, sinCalificar } = r.computo;
    const b = elegirBase(datos, t);
    try {
      let fin: string;
      let como: string;
      if (unidad === 'habiles') {
        const s = sumarHabiles(cal, b.dia, n);
        fin = s.fin;
        como = `${n} días hábiles${sinCalificar ? ' (el texto no los califica: se entienden hábiles, art. 30.2 Ley 39/2015)' : ''} desde el día siguiente al ${fmt(b.dia)}, sin sábados, domingos ni festivos`
          + (s.saltados.length ? ` (festivos saltados: ${s.saltados.join('; ')})` : '');
      } else {
        const bruto = unidad === 'naturales' ? sumarDias(b.dia, n) : sumarMeses(b.dia, n);
        const h = primerHabil(cal, bruto);
        fin = h.fin;
        como = (unidad === 'naturales' ? `${n} días naturales desde el ${fmt(b.dia)}` : `${n} ${n === 1 ? 'mes' : 'meses'} de fecha a fecha desde el ${fmt(b.dia)}`)
          + (h.movido ? `; el ${fmt(bruto)} es inhábil y pasa al primer día hábil siguiente` : '');
      }
      const aproximada = b.origen === 'registro';
      const origen = aproximada
        ? `. Base: fecha de registro en la fuente (${fmt(b.dia)}); no consta la fecha de publicación del extracto, el cierre real puede ser posterior`
        : `. Base: publicación del extracto el ${fmt(b.dia)}`;
      return { ...base, fechaCierre: fin, tipo: 'calculada', textoOriginal: t.trim(), fechaBase: b.dia, baseOrigen: b.origen, aproximada, detalle: como + origen };
    } catch (e) {
      if (e instanceof SinFestivosDelAnio) return { ...base, detalle: `${e.message}: no se puede contar los días hábiles` };
      throw e;
    }
  }
  return { ...base, detalle: motivos.length ? motivos.join(' · ') : 'La fuente no da fecha ni texto de plazo' };
}
