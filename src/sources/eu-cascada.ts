// Fuente "eu_cascada": convocatorias en cascada de la UE (financial support to third parties, FSTP). Proyectos financiados por Horizon Europe,
// LIFE, Digital Europe, CERV… que abren sus propias convocatorias para que terceros (ONG, pymes, ayuntamientos) reciban subvenciones pequeñas:
// una entidad sola puede presentarse, sin liderar ni integrar un consorcio.
//
// Petición (verificada en vivo, misma API SEDIA que `eu_ft`): POST https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=***&pageSize=50&pageNumber=N
// con cuerpo MULTIPART (parte `query`, application/json). `type = 8` son las "competitive calls" (pestaña "Calls for proposals from EU-funded projects"
// del portal): una ficha por convocatoria del proyecto, con `status` 31094501/31094502, `language = en` (hay una copia por idioma) y `deadlineDate`.
//   · `reference` = `<callccm2Id>COMPETITIVE_CALLen`. El `identifier` NO sirve de id: es el del topic de la UE que financia al proyecto y lo comparten
//     decenas de convocatorias; el id estable es `callccm2Id` → `cascada:<callccm2Id>`. La URL del portal usa `ccm2Id` (la ficha del proyecto).
//   · Metadatos: title, callTitle, projectName, projectAcronym, programmePeriod, budget (total de la convocatoria), deadlineDate (varios cortes),
//     description / beneficiaryAdministration (quién puede pedirla) / furtherInformation (importes, plazos). No hay campo de países elegibles:
//     se deduce del texto (ver `paisesRestringidos`). El importe por tercero también va en el texto: lo extrae el análisis, con cita.
//   · El índice repite resultados entre páginas: se deduplica por `callccm2Id`. Con `text=***` la búsqueda devuelve todo (el filtro es el de la consulta).
// Pausa entre páginas (RADAR_PAUSA_CASCADA_MS) y tope de peticiones (RADAR_MAX_PETICIONES_CASCADA), como `eu_ft`.
import { diaLocal } from '../dates.ts';
import { config } from '../config.ts';
import { htmlATexto } from '../texto.ts';
import type { DatosPlazo } from '../plazos.ts';
import type { Convocatoria, Cribada, Descarte } from '../types.ts';
import { dormirReal, ESTADO_ABIERTA, ESTADO_PROXIMA, PROGRAMAS, RELEVANTE, SEDIA_API, TAM_PAGINA, TIMEOUT_MS } from './eu-ft.ts';
import type { ContextoFuente, DocumentoFuente, Enlace, Fuente, ResultadoFuente } from './source.ts';

/** Temas del perfil vistos en una convocatoria en cascada (los de `eu_ft` más agroecología y soluciones basadas en la naturaleza). */
const TEMA = new RegExp(`${RELEVANTE.source}|agroecolog|nature[- ]based solution|ecological restoration|ecosystem restoration|regenerative agricultur|soil health|biosphere|marine protected|coastal ecosystem|blue carbon|pollinator`, 'i');
/** Una convocatoria en cascada es corta y específica: con 3 menciones en el cuerpo basta. */
const MENCIONES_CUERPO = 3;

export interface Cascada {
  /** `callccm2Id`: id estable de la convocatoria. */
  id: string;
  titulo: string;
  tituloConvocatoria: string | null;
  proyecto: string;
  acronimo: string | null;
  programa: string;
  /** Identificador del topic de la UE que financia al proyecto (no único por convocatoria). */
  topic: string | null;
  estado: 'abierta' | 'proxima';
  apertura: string | null;
  fechasLimite: string[];
  fechaLimite: string | null;
  /** Presupuesto total de la convocatoria (no por tercero). */
  presupuesto: number | null;
  duracion: string | null;
  url: string;
  descripcion: string;
  quienPuede: string;
  masInformacion: string;
}

interface ResultadoSedia { metadata?: Record<string, string[] | undefined>; summary?: string }
interface RespuestaSedia { totalResults?: number; results?: ResultadoSedia[] }

const primero = (m: Record<string, string[] | undefined>, k: string): string | null => m[k]?.[0]?.trim() || null;

/** Programa por el prefijo del identificador del topic (los de eu_ft más los que traen las cascadas). */
const PROGRAMAS_CASCADA: Record<string, string> = {
  ...PROGRAMAS, SMP: 'Mercado Único (SMP)', EDF: 'Fondo Europeo de Defensa', EURATOM: 'Euratom', I3: 'Instrumento de Inversiones Interregionales', INTERREG: 'Interreg', EIT: 'EIT',
};

/** Un resultado de SEDIA → convocatoria en cascada vigente, o null (sin fecha límite futura, estado cerrado, sin id o sin título). */
export function aCascada(r: ResultadoSedia, hoy: string): Cascada | null {
  const m = r.metadata ?? {};
  const id = primero(m, 'callccm2Id');
  const ccm2 = primero(m, 'ccm2Id');
  const titulo = primero(m, 'callTitle') ?? primero(m, 'title') ?? r.summary?.trim() ?? null;
  if (!id || !ccm2 || !titulo) return null;
  const estado = primero(m, 'status');
  if (estado !== ESTADO_ABIERTA && estado !== ESTADO_PROXIMA) return null;
  const limites = [...new Set((m.deadlineDate ?? []).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime())).map((d) => diaLocal(d)))].sort();
  const vigentes = limites.filter((d) => d >= hoy);
  if (vigentes.length === 0) return null;
  const topic = primero(m, 'identifier');
  const prefijo = (topic ?? '').split('-')[0].toUpperCase();
  const presupuesto = Number(primero(m, 'budget'));
  return {
    id, titulo: titulo.replace(/\s+/g, ' ').trim(), tituloConvocatoria: primero(m, 'title'),
    proyecto: (primero(m, 'projectName') ?? primero(m, 'projectAcronym') ?? '').replace(/\s+/g, ' ').trim(), acronimo: primero(m, 'projectAcronym'),
    programa: PROGRAMAS_CASCADA[prefijo] ?? (prefijo || 'UE'), topic,
    estado: estado === ESTADO_ABIERTA ? 'abierta' : 'proxima',
    apertura: m.startDate?.[0] ? diaLocal(new Date(m.startDate[0])) : null,
    fechasLimite: limites, fechaLimite: vigentes[0],
    presupuesto: Number.isFinite(presupuesto) && presupuesto > 0 ? presupuesto : null, duracion: primero(m, 'duration'),
    url: primero(m, 'url') ?? `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/competitive-calls-cs/${ccm2}`,
    descripcion: htmlATexto(m.description?.[0] ?? ''), quienPuede: htmlATexto(m.beneficiaryAdministration?.[0] ?? ''), masInformacion: htmlATexto(m.furtherInformation?.[0] ?? ''),
  };
}

// --- Países elegibles ---

const PAISES: Record<string, RegExp> = {
  Austria: /\bAustria(?:n)?\b/, Bélgica: /\bBelgi(?:um|an)\b/, Bulgaria: /\bBulgaria(?:n)?\b/, Croacia: /\bCroatia(?:n)?\b/, Chipre: /\bCyprus\b|\bCypriot\b/,
  Chequia: /\bCzech(?:ia| Republic)?\b/, Dinamarca: /\bDenmark\b|\bDanish\b/, Estonia: /\bEstonia(?:n)?\b/, Finlandia: /\bFinland\b|\bFinnish\b/,
  Francia: /\bFrance\b|\bFrench\b/, Alemania: /\bGermany\b|\bGerman\b/, Grecia: /\bGreece\b|\bGreek\b/, Hungría: /\bHungary\b|\bHungarian\b/,
  Irlanda: /\bIreland\b|\bIrish\b/, Italia: /\bItaly\b|\bItalian\b/, Letonia: /\bLatvia(?:n)?\b/, Lituania: /\bLithuania(?:n)?\b/,
  Luxemburgo: /\bLuxembourg(?:ish)?\b/, Malta: /\bMalta\b|\bMaltese\b/, 'Países Bajos': /\bNetherlands\b|\bDutch\b/, Polonia: /\bPoland\b|\bPolish\b/,
  Portugal: /\bPortugal\b|\bPortuguese\b/, Rumanía: /\bRomania(?:n)?\b/, Eslovaquia: /\bSlovak(?:ia)?\b/, Eslovenia: /\bSlovenia(?:n)?\b/,
  Suecia: /\bSweden\b|\bSwedish\b/, Noruega: /\bNorway\b|\bNorwegian\b/, Islandia: /\bIceland(?:ic)?\b/, Suiza: /\bSwitzerland\b|\bSwiss\b/,
  'Reino Unido': /\bUnited Kingdom\b|\bUK\b|\bBritish\b/, Serbia: /\bSerbia(?:n)?\b/, Turquía: /\bTurk(?:ey|ish)\b/, Ucrania: /\bUkrain(?:e|ian)\b/,
  Moldavia: /\bMoldova(?:n)?\b/, Albania: /\bAlbania(?:n)?\b/, Georgia: /\bGeorgian\b/, Israel: /\bIsrael(?:i)?\b/,
};
const ESPANA = /\bSpain\b|\bSpanish\b|\bEspaña\b/;
/** "Toda la UE": si el texto de elegibilidad lo dice, un país suelto en el texto no restringe (solo el título lo haría). */
const UE_ABIERTA = /member states?|european union|\bEU\b|\beurope(?:an)?\b|associated countr|any country|all countries|worldwide|internationally/i;
/** "… must be based/established/registered in <países>": lo que dice dónde tiene que estar el solicitante. */
const DONDE = /\b(?:based|established|registered|located|resident|residing|domiciled|incorporated|headquartered|legal seat|registered office|seat)\b[^.\n;]{0,60}?\b(?:in|within|from)\b([^.\n;]{0,200})/gi;

const paisesEn = (texto: string): string[] => Object.entries(PAISES).filter(([, re]) => re.test(texto)).map(([n]) => n);

/**
 * Países a los que se limita una convocatoria, o [] si es de toda España/UE o el texto no limita. Dos señales:
 * (1) el título (convocatoria, topic o proyecto) nombra un país («Slovenian seas», «National Coordination Centre - Hungary»): es de ese país;
 * (2) la condición de dónde debe estar el solicitante nombra países y ninguno es España, sin decir «Estados miembros»/«UE». Si España aparece, no restringe.
 */
export function paisesRestringidos(c: Pick<Cascada, 'titulo' | 'tituloConvocatoria' | 'proyecto' | 'quienPuede' | 'descripcion' | 'masInformacion'>): string[] {
  const nombres = [c.titulo, c.tituloConvocatoria ?? '', c.proyecto].join(' | ');
  const enTitulo = paisesEn(nombres);
  if (enTitulo.length > 0 && !ESPANA.test(nombres)) return enTitulo;
  const textos = [c.quienPuede, c.descripcion, c.masInformacion].join('\n');
  const colas = [...textos.matchAll(DONDE)].map((x) => x[1]);
  const cola = colas.join(' | ');
  const hits = paisesEn(cola);
  if (hits.length === 0 || ESPANA.test(cola)) return [];
  if (colas.some((x) => UE_ABIERTA.test(x)) || UE_ABIERTA.test(c.quienPuede.slice(0, 600))) return [];
  return hits;
}

/** ¿Trata de los temas del perfil? Título, convocatoria o proyecto; o el cuerpo con insistencia (3 menciones). */
export function esRelevante(c: Cascada): boolean {
  if (TEMA.test([c.titulo, c.tituloConvocatoria ?? '', c.proyecto].join(' | '))) return true;
  const cuerpo = [c.descripcion, c.quienPuede, c.masInformacion].join('\n');
  return (cuerpo.match(new RegExp(TEMA.source, 'gi')) ?? []).length >= MENCIONES_CUERPO;
}

export function descarteCascada(c: Cascada): Descarte | null {
  if (!esRelevante(c)) {
    return { regla: 'tema', motivo: 'Fuera de los temas del perfil (restauración, biodiversidad, soluciones basadas en la naturaleza, bosque, rewilding, adaptación, educación ambiental, ciencia ciudadana, agroecología)' };
  }
  const paises = paisesRestringidos(c);
  if (paises.length > 0) return { regla: 'pais', motivo: `Convocatoria limitada a ${paises.join(', ')}: no incluye España ni está abierta a toda la UE` };
  return null;
}

export const PREFIJO_ID = 'cascada:';

function aConvocatoria(c: Cascada, ahora: Date): Convocatoria {
  return {
    id: `${PREFIJO_ID}${c.id}`, fuente: 'eu_cascada', fuenteId: c.id, titulo: c.titulo,
    organo: { nivel1: 'UE', nivel2: c.acronimo ?? c.proyecto, nivel3: c.programa },
    fechaPublicacion: c.apertura ?? diaLocal(ahora), url: c.url, tipo: 'Convocatoria en cascada (terceros)', finalidad: null, regiones: [],
    abierto: c.estado === 'abierta' ? true : null, datos: { cascada: c },
  };
}

async function pagina(f: typeof fetch, numero: number, hoy: string): Promise<RespuestaSedia> {
  const consulta = {
    bool: {
      must: [
        { terms: { type: ['8'] } },
        { terms: { status: [ESTADO_PROXIMA, ESTADO_ABIERTA] } },
        { terms: { language: ['en'] } },
        { range: { deadlineDate: { gte: `${hoy}T00:00:00.000+0000` } } },
      ],
    },
  };
  const cuerpo = new FormData();
  cuerpo.append('query', new Blob([JSON.stringify(consulta)], { type: 'application/json' }), 'blob');
  const qs = new URLSearchParams({ apiKey: 'SEDIA', text: '***', pageSize: String(TAM_PAGINA), pageNumber: String(numero) });
  const res = await f(`${SEDIA_API}?${qs}`, { method: 'POST', body: cuerpo, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Funding & Tenders (cascada) ${res.status}`);
  return (await res.json()) as RespuestaSedia;
}

export interface OpcionesFuenteCascada { pausaMs: number; maxPeticiones: number }

export function crearFuenteEuCascada(opciones: () => OpcionesFuenteCascada = () => config.euCascada): Fuente {
  async function recoger(ctx: ContextoFuente): Promise<ResultadoFuente> {
    const { pausaMs, maxPeticiones } = opciones();
    const dormir = ctx.dormir ?? dormirReal;
    const hoy = diaLocal(ctx.ahora);
    const cascadas = new Map<string, Cascada>();
    const errores: string[] = [];
    let total = Infinity;
    let vistos = 0;
    for (let n = 1; n <= maxPeticiones && vistos < total; n++) {
      if (n > 1 && pausaMs > 0) await dormir(pausaMs);
      let r: RespuestaSedia;
      try {
        r = await pagina(ctx.fetch, n, hoy);
      } catch (e) {
        if (n === 1) throw e; // sin la primera página no hay nada: fallo total de la fuente (aislado de las demás por el motor)
        errores.push(`Página ${n}: ${(e as Error).message}`);
        break;
      }
      const resultados = r.results ?? [];
      total = r.totalResults ?? 0;
      vistos += resultados.length;
      if (resultados.length === 0) break;
      for (const x of resultados) {
        const c = aCascada(x, hoy);
        if (c && !cascadas.has(c.id)) cascadas.set(c.id, c);
      }
      if (n === maxPeticiones && vistos < total) errores.push(`Tope de ${maxPeticiones} peticiones: ${total - vistos} de ${total} resultados sin leer`);
    }
    const cribadas: Cribada[] = [];
    for (const c of cascadas.values()) {
      const d = descarteCascada(c);
      // Se guarda todo con su motivo (auditable); de lo ajeno al tema sin los textos largos.
      const guardada = d?.regla === 'tema' ? { ...c, descripcion: '', quienPuede: '', masInformacion: '' } : c;
      const conv = aConvocatoria(guardada, ctx.ahora);
      cribadas.push({ convocatoria: conv, descarte: d ?? ctx.cribar(conv) });
    }
    return { cribadas, errores };
  }
  return { nombre: 'eu_cascada', recoger, documentos, enlaces, datosPlazo };
}

const cascadaDe = (c: Convocatoria): Cascada | null => ((c.datos as { cascada?: Cascada } | null)?.cascada) ?? null;
const euros = (n: number) => `${n.toLocaleString('es-ES')} €`;

function ficha(c: Convocatoria, x: Cascada): string {
  return [
    `Título: ${x.titulo}`,
    'Tipo: convocatoria en cascada (financial support to third parties, FSTP): la publica un proyecto financiado por la UE para dar subvenciones a terceros; se solicita a ese proyecto, no a la Comisión, y no hace falta consorcio.',
    `Proyecto europeo que la financia: ${x.proyecto}${x.acronimo ? ` (${x.acronimo})` : ''}`,
    `Programa de la UE: ${x.programa}${x.topic ? ` · topic ${x.topic}` : ''}`,
    `Estado: ${x.estado === 'abierta' ? 'abierta' : 'próxima (aún no abierta)'}`,
    x.apertura && `Apertura: ${x.apertura}`,
    x.fechasLimite.length && `Fecha límite (hora de Bruselas): ${x.fechasLimite.join(', ')}${x.fechasLimite.length > 1 ? ' (varios cortes)' : ''}`,
    x.presupuesto != null && `Presupuesto total de la convocatoria (el importe por tercero va en el texto de abajo): ${euros(x.presupuesto)}`,
    x.duracion && `Duración: ${x.duracion}`,
    `Enlace: ${c.url}`,
  ].filter(Boolean).join('\n');
}

const MAX_TEXTO = 30_000;

function documentos(c: Convocatoria): DocumentoFuente[] {
  const x = cascadaDe(c);
  if (!x) return [{ titulo: 'Ficha Funding & Tenders', url: c.url, texto: `Título: ${c.titulo}` }];
  const docs: DocumentoFuente[] = [{ titulo: 'Ficha Funding & Tenders', url: c.url, texto: ficha(c, x) }];
  if (x.descripcion) docs.push({ titulo: 'Descripción de la convocatoria (inglés)', url: c.url, texto: x.descripcion.slice(0, MAX_TEXTO) });
  if (x.quienPuede) docs.push({ titulo: 'Quién puede presentarse y cómo (inglés)', url: c.url, texto: x.quienPuede.slice(0, MAX_TEXTO) });
  if (x.masInformacion) docs.push({ titulo: 'Más información: importes y condiciones (inglés)', url: c.url, texto: x.masInformacion.slice(0, MAX_TEXTO) });
  return docs;
}

function enlaces(c: Convocatoria): Enlace[] {
  return [{ tipo: 'ficha', titulo: 'Ficha en el portal Funding & Tenders', url: c.url }];
}

function datosPlazo(c: Convocatoria): DatosPlazo {
  const x = cascadaDe(c);
  return {
    fechaFin: x?.fechaLimite ?? null,
    textoFin: x?.fechasLimite.length ? `Fecha límite: ${x.fechasLimite.join(', ')}` : null,
    textoInicio: null,
    publicaciones: [],
    registro: c.fechaPublicacion,
  };
}

export const euCascada: Fuente = crearFuenteEuCascada();
