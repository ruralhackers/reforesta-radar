// Conjuntos de prueba del backtest.
//   (a) Las convocatorias CAM "proyectos ambientales" de 2022 a 2026 y los ejemplos del reto (MITECO 923290 y CAM Orden 1689/2026).
//   (b) Las ganadas desde 2022 por organizaciones parecidas activas, filtradas SOLO con reglas objetivas (ver `evaluarCandidataB`),
//       sin las que ganó Reforesta y sin las del conjunto (a), para no contar dos veces.
// Todo lo que se examina se guarda, también lo excluido y por qué, para que el conjunto sea revisable.
import { createHash } from 'node:crypto';
import { normalizar } from '../rules.ts';
import { concesionesDeNif } from '../sources/bdns-concesiones.ts';
import { getJson } from '../sources/bdns.ts';
import type { Perfil } from '../types.ts';
import type { FilaConjunto } from './db.ts';

/** Las del conjunto (a), con su etiqueta. La "Orden 1689/2026" del reto no es otra convocatoria: es el título del extracto de la 904719 (se comprueba en vivo). */
export const CONJUNTO_A: { numero: string; etiqueta: string }[] = [
  { numero: '626301', etiqueta: 'CAM proyectos ambientales 2022' },
  { numero: '703977', etiqueta: 'CAM proyectos ambientales 2023' },
  { numero: '782630', etiqueta: 'CAM proyectos ambientales 2024' },
  { numero: '825309', etiqueta: 'CAM proyectos ambientales 2025' },
  { numero: '904719', etiqueta: 'CAM proyectos ambientales 2026 · ejemplo del reto: Orden 1689/2026' },
  { numero: '923290', etiqueta: 'MITECO línea A 2026 · ejemplo del reto' },
];
/** Texto del extracto con el que se identifica la Orden 1689/2026 del reto en BDNS. */
export const ORDEN_DEL_RETO = { texto: 'Orden 1689/2026', numero: '904719' };

export interface DetalleBdns {
  codigoBDNS: string;
  descripcion: string;
  fechaRecepcion: string;
  organo: { nivel1: string; nivel2: string | null; nivel3: string | null };
  tipoConvocatoria: string | null;
  descripcionFinalidad: string | null;
  regiones: { descripcion: string }[] | null;
  anuncios?: { titulo: string | null }[] | null;
  objetivos?: unknown;
}

const organoTexto = (o: DetalleBdns['organo']) => [o.nivel1, o.nivel2, o.nivel3].filter(Boolean).join(' · ');
const hash = (numero: string) => createHash('sha1').update(`backtest:${numero}`).digest('hex').slice(0, 12);

export async function resolverConjuntoA(f: typeof fetch, dormir: (ms: number) => Promise<void>): Promise<FilaConjunto[]> {
  const filas: FilaConjunto[] = [];
  for (const { numero, etiqueta } of CONJUNTO_A) {
    const d = await getJson<DetalleBdns>(f, '/convocatorias', { numConv: numero });
    const nota: string[] = [];
    if (numero === ORDEN_DEL_RETO.numero) {
      const extracto = (d.anuncios ?? []).map((a) => a.titulo ?? '').find((t) => t.includes(ORDEN_DEL_RETO.texto));
      nota.push(extracto
        ? `La ${ORDEN_DEL_RETO.texto} del reto es esta misma convocatoria: su extracto se titula «${extracto.slice(0, 90)}…»`
        : `La ${ORDEN_DEL_RETO.texto} del reto no localizada en BDNS (el extracto de la ${numero} ya no la nombra)`);
    }
    filas.push({
      conjunto: 'a', numero, titulo: d.descripcion.trim(), organo: organoTexto(d.organo), finalidad: d.descripcionFinalidad,
      fechaPublicacion: d.fechaRecepcion, admitida: true, reglas: nota, ganadoras: [], etiqueta, orden: hash(numero),
    });
    await dormir(150);
  }
  return filas;
}

// --- Reglas objetivas del conjunto (b) ---------------------------------------------------------------------------------------------

/**
 * Palabras (sin acentos, en minúsculas) que, en el título, el órgano o la finalidad, marcan una convocatoria como ambiental.
 * La finalidad de BDNS no basta: no existe "Medio ambiente" entre las que usan las ganadas (la 825309 es "Otras prestaciones económicas",
 * la 923290 "I+D+i"). Es una lista deliberadamente corta y sin nada específico de Reforesta.
 */
export const PALABRAS_AMBIENTALES = [
  'ambiental', 'ambientales', 'medio ambiente', 'medioambiental', 'biodiversidad', 'naturaleza', 'natural', 'naturales', 'natura 2000', 'forestal',
  'montes', 'ecosistema', 'ecosistemas', 'conservacion', 'fauna', 'flora', 'especies', 'habitat', 'reforestacion', 'cambio climatico', 'transicion ecologica',
  'agroambiental', 'espacios protegidos', 'reserva de la biosfera', 'reservas de la biosfera', 'ornitologi', 'avifauna', 'ecologico', 'ecologica', 'economia azul',
  'voluntariado ambiental', 'sensibilizacion ambiental',
];
const REGEX_AMBIENTAL = new RegExp(`\\b(${PALABRAS_AMBIENTALES.join('|')})\\b`);

/** Si el título limita la convocatoria a empresas, autónomos o administraciones sin nombrar a las entidades sin ánimo de lucro, no admite ESFL. */
const SOLO_OTROS = /\b(empresas?|pymes?|autonomos?|profesionales|sociedades|cooperativas|ayuntamientos|entidades locales|universidades|personas fisicas)\b/;
const DICE_ESFL = /\b(sin animo de lucro|esfl|esal|ong|ongs|tercer sector|asociaciones|fundaciones|organizaciones|entidades (privadas|ambientales|sociales)|entidades del)\b/;

export interface EvaluacionB {
  admitida: boolean;
  /** Reglas que la admiten (o, si no, la que la excluye en `motivo`). */
  reglas: string[];
  motivo: string | null;
}

/**
 * Reglas objetivas, en este orden (la primera que falla excluye):
 *  1. Registrada en BDNS desde 2022 (las concesiones solo existen desde 2022).
 *  2. Concurrencia: ni nominativa ni concesión directa (por `tipoConvocatoria` o por el título).
 *  3. Ámbito del perfil (nivel estatal, comunidad entera del ámbito o región del perfil).
 *  4. Finalidad ambiental: una palabra de PALABRAS_AMBIENTALES en título, órgano o finalidad.
 *  5. Admite ESFL: la ganó una parecida (una entidad sin ánimo de lucro) y el título no la limita a empresas, autónomos o administraciones.
 * No usa el LLM ni el radar: lo que el radar vea después es lo que se mide.
 */
export function evaluarCandidataB(d: DetalleBdns, perfil: Perfil, ganadoras: string[]): EvaluacionB {
  const excluida = (motivo: string): EvaluacionB => ({ admitida: false, reglas: [], motivo });
  if (d.fechaRecepcion < '2022-01-01') return excluida(`Registrada en BDNS el ${d.fechaRecepcion}, antes de 2022`);
  if (/directa/i.test(d.tipoConvocatoria ?? '')) return excluida(`Concesión directa (${d.tipoConvocatoria})`);
  if (/nominativ/i.test(d.descripcion)) return excluida('Nominativa (lo dice el título)');
  const n1 = normalizar(d.organo.nivel1);
  const codigos = (d.regiones ?? []).map((r) => r.descripcion.split(' - ')[0].trim());
  const nivel = perfil.ambito.nivelesSiempre.find((n) => normalizar(n) === n1);
  const comunidad = n1 === 'AUTONOMICA' && d.organo.nivel2 ? perfil.ambito.territorios.find((t) => t.provincias.length === 0 && normalizar(t.comunidad) === normalizar(d.organo.nivel2!))?.comunidad : undefined; // solo comunidades enteras; las parciales, por región
  const region = codigos.find((r) => perfil.ambito.regiones.includes(r));
  const ambito = nivel ? `nivel ${nivel}` : comunidad ? `Comunidad: ${comunidad}` : region ? `región ${region}` : null;
  if (!ambito) return excluida(`Fuera del ámbito del perfil: ${organoTexto(d.organo)}`);
  const texto = normalizar(`${d.descripcion} ${d.organo.nivel2 ?? ''} ${d.organo.nivel3 ?? ''} ${d.descripcionFinalidad ?? ''}`).toLowerCase();
  const palabra = REGEX_AMBIENTAL.exec(texto)?.[1];
  if (!palabra) return excluida('Sin finalidad ambiental (ninguna palabra de la lista en título, órgano o finalidad)');
  const titulo = normalizar(d.descripcion).toLowerCase();
  if (SOLO_OTROS.test(titulo) && !DICE_ESFL.test(titulo)) return excluida('El título la limita a empresas, autónomos o administraciones, sin nombrar entidades sin ánimo de lucro');
  return {
    admitida: true, motivo: null,
    reglas: [
      `Concurrencia competitiva (${d.tipoConvocatoria ?? 'tipo no indicado'}), no nominativa`,
      `Ámbito: ${ambito}`,
      `Finalidad ambiental: «${palabra}»`,
      `Admite ESFL: la ganó ${ganadoras.join(', ')} y el título no la limita a empresas ni administraciones`,
    ],
  };
}

export interface OpcionesConjuntoB {
  /** Números que no entran (los del conjunto (a)). */
  excluir: Set<string>;
  /** Ya examinadas en ejecuciones anteriores: no se vuelven a pedir (la construcción es reanudable). */
  yaExaminadas?: Set<string>;
  dormir: (ms: number) => Promise<void>;
  pausaMs: number;
  /** Tope de consultas de detalle por construcción (cada consulta es una petición a BDNS). */
  maxDetalles: number;
  log: (m: string) => void;
}

/** Concesiones de las parecidas y de Reforesta (por NIF) → convocatorias ganadas → detalle → reglas objetivas. */
export async function construirConjuntoB(
  f: typeof fetch, perfil: Perfil, parecidas: { nif: string; nombre: string }[], o: OpcionesConjuntoB,
): Promise<{ filas: FilaConjunto[]; ganadasPorReforesta: string[]; sinDetalle: string[]; omitidasPorTope: number }> {
  const propias = new Set((await concesionesDeNif(f, perfil.nif)).map((c) => String(c.numeroConvocatoria)));
  const ganadoras = new Map<string, Map<string, string>>(); // número → nif → nombre
  for (const p of parecidas) {
    await o.dormir(o.pausaMs);
    const conc = await concesionesDeNif(f, p.nif);
    o.log(`${p.nombre}: ${conc.length} concesiones`);
    for (const c of conc) {
      const n = String(c.numeroConvocatoria);
      const m = ganadoras.get(n) ?? new Map<string, string>();
      m.set(p.nif, p.nombre);
      ganadoras.set(n, m);
    }
  }
  const filas: FilaConjunto[] = [];
  const sinDetalle: string[] = [];
  let omitidasPorTope = 0;
  let consultas = 0;
  for (const [numero, m] of [...ganadoras].sort(([a], [b]) => a.localeCompare(b))) {
    if (o.excluir.has(numero) || propias.has(numero) || o.yaExaminadas?.has(numero)) continue; // la ganó Reforesta o ya está en (a): no es del conjunto (b)
    if (consultas >= o.maxDetalles) { omitidasPorTope++; continue; }
    consultas++;
    await o.dormir(o.pausaMs);
    let d: DetalleBdns;
    try {
      d = await getJson<DetalleBdns>(f, '/convocatorias', { numConv: numero });
    } catch (e) {
      sinDetalle.push(`${numero}: ${(e as Error).message}`);
      continue;
    }
    const ganadorasLista = [...m].map(([nif, nombre]) => ({ nif, nombre }));
    const ev = evaluarCandidataB(d, perfil, ganadorasLista.map((g) => g.nombre));
    filas.push({
      conjunto: 'b', numero, titulo: d.descripcion.trim(), organo: organoTexto(d.organo), finalidad: d.descripcionFinalidad, fechaPublicacion: d.fechaRecepcion,
      admitida: ev.admitida, reglas: ev.admitida ? ev.reglas : [ev.motivo!], ganadoras: ganadorasLista, etiqueta: null, orden: hash(numero),
    });
  }
  return { filas, ganadasPorReforesta: [...propias], sinDetalle, omitidasPorTope };
}
