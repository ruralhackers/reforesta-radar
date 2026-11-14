// Fuente EU Funding & Tenders Portal (convocatorias de la UE: LIFE, Horizon Europe, Erasmus+…), por la API pública de búsqueda (SEDIA).
//
// Petición (verificada en vivo): POST https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA&text=<términos>&pageSize=50&pageNumber=N
// con un cuerpo MULTIPART con una parte `query` (application/json). Un cuerpo JSON normal se ignora en silencio (devuelve todo el índice).
//   · type = 1: topics (las convocatorias de subvención del portal). 2 = Prospect (acción exterior) no se piden. 8 = convocatorias en cascada (FSTP):
//     las trae la fuente `eu_cascada` (src/sources/eu-cascada.ts).
//   · status = 31094501 (forthcoming, "próxima") y 31094502 (open, "abierta"); language = en (el índice trae una copia por idioma).
//   · range sobre deadlineDate >= hoy: el índice tiene fichas antiguas del portal (p. ej. LIFE 2023) marcadas aún como abiertas.
//   · text: términos de la lista TERMINOS unidos con OR; la API es de texto libre, así que además se filtra en código (ver `esRelevante`).
// El servidor se sobrecarga con facilidad: pausa entre páginas (RADAR_PAUSA_FT_MS) y tope de peticiones (RADAR_MAX_PETICIONES_FT).
import { diaLocal } from '../dates.ts';
import { config } from '../config.ts';
import { htmlATexto } from '../texto.ts';
import type { DatosPlazo } from '../plazos.ts';
import type { Convocatoria, Cribada } from '../types.ts';
import type { ContextoFuente, DocumentoFuente, Enlace, Fuente, ResultadoFuente } from './source.ts';

export const SEDIA_API = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search';
export const PORTAL_TOPIC = 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/';
export const ESTADO_PROXIMA = '31094501';
export const ESTADO_ABIERTA = '31094502';
export const TAM_PAGINA = 50;
export const TIMEOUT_MS = 60_000;

/** Términos de la búsqueda de texto libre (en inglés, como el portal). */
export const TERMINOS = ['biodiversity', 'restoration', 'reforestation', 'forest', 'forests', 'ecosystem', 'ecosystems', 'nature', 'adaptation', 'LIFE'];

/** Programas por el prefijo del identificador del topic. */
export const PROGRAMAS: Record<string, string> = {
  HORIZON: 'Horizon Europe', LIFE: 'LIFE', ERASMUS: 'Erasmus+', CERV: 'CERV (Ciudadanía, Igualdad, Derechos y Valores)', CREA: 'Europa Creativa',
  EU4H: 'EU4Health', CEF: 'Mecanismo Conectar Europa', DIGITAL: 'Europa Digital', JUST: 'Justicia', EMFAF: 'FEMPA', ESF: 'FSE+', ISF: 'ISF',
};

/**
 * Palabras que hacen relevante un topic para restauración, biodiversidad, naturaleza, bosque, adaptación y educación ambiental.
 * Deliberadamente sin "ecosystem" ni "nature" sueltos: casi todo topic digital habla de "innovation ecosystems" y "the nature of…".
 */
export const RELEVANTE = /biodiversit|restor|rewild|re-?forest|afforest|\bforest|woodland|agroforest|wildfire|nature[- ](?:positive|restoration|based|conservation|protection)|urban nature|nature and biodiversity|natura 2000|habitat|wildlife|\bspecies\b|invasive alien|climate adaptation|climate resilien|environmental education|environmental awareness|citizen science/i;

export interface Topic {
  identifier: string;
  title: string;
  programa: string;
  /** Prefijo del identificador (HORIZON, LIFE…). */
  prefijo: string;
  estado: 'abierta' | 'proxima';
  apertura: string | null;
  /** Todas las fechas límite (YYYY-MM-DD, hora de Bruselas), ordenadas. */
  fechasLimite: string[];
  /** La que cuenta para el plazo: la primera que no ha pasado. */
  fechaLimite: string | null;
  modeloPlazo: string | null;
  convocatoria: { identificador: string | null; titulo: string | null };
  tiposDeAccion: string[];
  palabrasClave: string[];
  etiquetas: string[];
  presupuesto: { total: number | null; subvenciones: number | null; minimo: number | null; maximo: number | null } | null;
  descripcion: string;
  condiciones: string;
}

interface ResultadoSedia {
  reference?: string;
  summary?: string;
  metadata?: Record<string, string[] | undefined>;
}

interface RespuestaSedia {
  totalResults?: number;
  results?: ResultadoSedia[];
}

const primero = (m: Record<string, string[] | undefined>, k: string): string | null => m[k]?.[0]?.trim() || null;

function presupuestoDe(bruto: string | null): Topic['presupuesto'] {
  if (!bruto) return null;
  try {
    const b = JSON.parse(bruto) as { budgetTopicActionMap?: Record<string, { expectedGrants?: number; minContribution?: number; maxContribution?: number; budgetYearMap?: Record<string, string | number> }[]> };
    const acciones = Object.values(b.budgetTopicActionMap ?? {}).flat();
    if (!acciones.length) return null;
    const suma = (xs: (number | undefined)[]) => { const n = xs.filter((x): x is number => typeof x === 'number'); return n.length ? n.reduce((a, c) => a + c, 0) : null; };
    const totales = acciones.map((a) => suma(Object.values(a.budgetYearMap ?? {}).map(Number).filter(Number.isFinite)) ?? undefined);
    const minimos = acciones.map((a) => a.minContribution).filter((x): x is number => typeof x === 'number');
    const maximos = acciones.map((a) => a.maxContribution).filter((x): x is number => typeof x === 'number');
    return {
      total: suma(totales), subvenciones: suma(acciones.map((a) => a.expectedGrants)),
      minimo: minimos.length ? Math.min(...minimos) : null, maximo: maximos.length ? Math.max(...maximos) : null,
    };
  } catch {
    return null;
  }
}

/** Un resultado de SEDIA → topic, o null si no es una ficha vigente del portal (ficha antigua, sin fecha límite o ya pasada). */
export function aTopic(r: ResultadoSedia, hoy: string): Topic | null {
  const m = r.metadata ?? {};
  const identifier = primero(m, 'identifier');
  const title = primero(m, 'title') ?? r.summary?.trim() ?? null;
  if (!identifier || !title) return null;
  const estado = primero(m, 'status');
  if (estado !== ESTADO_ABIERTA && estado !== ESTADO_PROXIMA) return null;
  const limites = [...new Set((m.deadlineDate ?? []).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime())).map((d) => diaLocal(d)))].sort();
  const vigentes = limites.filter((d) => d >= hoy);
  if (vigentes.length === 0) return null; // el índice conserva fichas viejas "abiertas" (p. ej. LIFE 2023): sin fecha límite futura no hay convocatoria
  const prefijo = identifier.split('-')[0].toUpperCase();
  const apertura = m.startDate?.[0] ? diaLocal(new Date(m.startDate[0])) : null;
  return {
    identifier, title, prefijo, programa: PROGRAMAS[prefijo] ?? prefijo,
    estado: estado === ESTADO_ABIERTA ? 'abierta' : 'proxima',
    apertura, fechasLimite: limites, fechaLimite: vigentes[0], modeloPlazo: primero(m, 'deadlineModel'),
    convocatoria: { identificador: primero(m, 'callIdentifier'), titulo: primero(m, 'callTitle') },
    tiposDeAccion: m.typesOfAction ?? [], palabrasClave: (m.keywords ?? []).filter((k) => k !== identifier && k !== primero(m, 'callIdentifier')),
    etiquetas: m.tags ?? [], presupuesto: presupuestoDe(primero(m, 'budgetOverview')),
    descripcion: htmlATexto(m.descriptionByte?.[0] ?? ''), condiciones: htmlATexto(m.topicConditions?.[0] ?? ''),
  };
}

/** Filtro de relevancia (en código, para no depender de la búsqueda de texto libre): título, etiquetas, palabras clave o texto del topic, o programa LIFE. */
export function esRelevante(t: Topic): boolean {
  if (/CANCELLED/i.test(t.identifier) || /\bCANCELLED\b/.test(t.title)) return false;
  if (t.prefijo === 'LIFE') return true;
  if (RELEVANTE.test([t.title, t.convocatoria.titulo ?? '', ...t.etiquetas, ...t.palabrasClave].join(' | '))) return true;
  // Solo en el cuerpo: hace falta que insista (5 menciones) (un topic digital puede nombrar "ecosystem" de pasada).
  const coincidencias = t.descripcion.match(new RegExp(RELEVANTE.source, 'gi')) ?? [];
  return coincidencias.length >= 5;
}

function aConvocatoria(t: Topic, ahora: Date): Convocatoria {
  // Fecha de publicación = la apertura real del topic (también si es futura); sin ella, el día de hoy. La criba y el análisis no la usan
  // para decidir si una ficha de la UE está pendiente: ver FUENTES_VIGENTES en db/repo.ts.
  return {
    id: `ft:${t.identifier}`, fuente: 'eu_ft', fuenteId: t.identifier, titulo: t.title,
    organo: { nivel1: 'UE', nivel2: t.programa, nivel3: t.convocatoria.titulo },
    fechaPublicacion: t.apertura ?? diaLocal(ahora), url: PORTAL_TOPIC + t.identifier, tipo: t.tiposDeAccion[0] ?? null, finalidad: null, regiones: [],
    abierto: t.estado === 'abierta' ? true : null, datos: { ft: t },
  };
}

export const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pagina(f: typeof fetch, texto: string, numero: number, hoy: string): Promise<RespuestaSedia> {
  const consulta = {
    bool: {
      must: [
        { terms: { type: ['1'] } },
        { terms: { status: [ESTADO_PROXIMA, ESTADO_ABIERTA] } },
        { terms: { language: ['en'] } },
        { range: { deadlineDate: { gte: `${hoy}T00:00:00.000+0000` } } },
      ],
    },
  };
  const cuerpo = new FormData();
  cuerpo.append('query', new Blob([JSON.stringify(consulta)], { type: 'application/json' }), 'blob');
  const qs = new URLSearchParams({ apiKey: 'SEDIA', text: texto, pageSize: String(TAM_PAGINA), pageNumber: String(numero) });
  const res = await f(`${SEDIA_API}?${qs}`, { method: 'POST', body: cuerpo, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Funding & Tenders ${res.status}`);
  return (await res.json()) as RespuestaSedia;
}

export interface OpcionesFuenteFt {
  pausaMs: number;
  maxPeticiones: number;
}

export function crearFuenteEuFt(opciones: () => OpcionesFuenteFt = () => config.euFt): Fuente {
  async function recoger(ctx: ContextoFuente): Promise<ResultadoFuente> {
    const { pausaMs, maxPeticiones } = opciones();
    const dormir = ctx.dormir ?? dormirReal;
    const hoy = diaLocal(ctx.ahora);
    const texto = TERMINOS.join(' OR ');
    const topics = new Map<string, Topic>();
    const errores: string[] = [];
    let total = Infinity;
    let vistos = 0;
    for (let n = 1; n <= maxPeticiones && vistos < total; n++) {
      if (n > 1 && pausaMs > 0) await dormir(pausaMs);
      let r: RespuestaSedia;
      try {
        r = await pagina(ctx.fetch, texto, n, hoy);
      } catch (e) {
        if (n === 1) throw e; // sin la primera página no hay nada: fallo total de la fuente
        errores.push(`Página ${n}: ${(e as Error).message}`);
        break;
      }
      const resultados = r.results ?? [];
      total = r.totalResults ?? 0;
      vistos += resultados.length;
      if (resultados.length === 0) break;
      for (const x of resultados) {
        const t = aTopic(x, hoy);
        if (t && !topics.has(t.identifier)) topics.set(t.identifier, t);
      }
      if (n === maxPeticiones && vistos < total) errores.push(`Tope de ${maxPeticiones} peticiones: ${total - vistos} de ${total} resultados sin leer`);
    }
    const cribadas: Cribada[] = [];
    for (const t of topics.values()) {
      if (esRelevante(t)) {
        const c = aConvocatoria(t, ctx.ahora);
        cribadas.push({ convocatoria: c, descarte: ctx.cribar(c) });
      } else {
        // Se guarda con su motivo (auditable) pero sin los textos largos: son cientos de topics ajenos.
        const c = aConvocatoria({ ...t, descripcion: '', condiciones: '' }, ctx.ahora);
        cribadas.push({ convocatoria: c, descarte: { regla: 'tema', motivo: 'Fuera de los temas del perfil (restauración, biodiversidad, naturaleza, bosque, adaptación, educación ambiental, LIFE)' } });
      }
    }
    return { cribadas, errores };
  }
  return { nombre: 'eu_ft', recoger, documentos, enlaces, datosPlazo };
}

const topicDe = (c: Convocatoria): Topic | null => ((c.datos as { ft?: Topic } | null)?.ft) ?? null;

const euros = (n: number) => `${n.toLocaleString('es-ES')} €`;

function ficha(c: Convocatoria, t: Topic): string {
  const p = t.presupuesto;
  const lineas = [
    `Título: ${t.title}`,
    `Convocatoria de la UE (Funding & Tenders Portal): ${t.programa} · ${t.convocatoria.titulo ?? ''}`.trim(),
    `Identificador del topic: ${t.identifier}`,
    t.convocatoria.identificador && `Identificador de la convocatoria: ${t.convocatoria.identificador}`,
    `Estado: ${t.estado === 'abierta' ? 'abierta' : 'próxima (aún no abierta)'}`,
    t.apertura && `Apertura: ${t.apertura}`,
    t.fechasLimite.length && `Fecha límite (hora de Bruselas): ${t.fechasLimite.join(', ')}${t.fechasLimite.length > 1 ? ' (varios cortes)' : ''}`,
    t.modeloPlazo && `Modelo de presentación: ${t.modeloPlazo}`,
    t.tiposDeAccion.length && `Tipo de acción: ${t.tiposDeAccion.join('; ')}`,
    p?.total != null && `Presupuesto indicativo del topic: ${euros(p.total)}`,
    p?.subvenciones != null && `Subvenciones previstas: ${p.subvenciones}`,
    p?.minimo != null && p.maximo != null && `Contribución de la UE por proyecto: ${p.minimo === p.maximo ? euros(p.minimo) : `${euros(p.minimo)} – ${euros(p.maximo)}`}`,
    t.etiquetas.length && `Etiquetas: ${t.etiquetas.join(', ')}`,
    t.palabrasClave.length && `Palabras clave: ${t.palabrasClave.join(', ')}`,
    `Enlace: ${c.url}`,
  ];
  return lineas.filter(Boolean).join('\n');
}

const MAX_CONDICIONES = 30_000;

function documentos(c: Convocatoria): DocumentoFuente[] {
  const t = topicDe(c);
  if (!t) return [{ titulo: 'Ficha Funding & Tenders', url: c.url, texto: `Título: ${c.titulo}` }];
  const docs: DocumentoFuente[] = [{ titulo: 'Ficha Funding & Tenders', url: c.url, texto: ficha(c, t) }];
  if (t.descripcion) docs.push({ titulo: 'Descripción del topic (inglés)', url: c.url, texto: t.descripcion });
  if (t.condiciones) docs.push({ titulo: 'Condiciones del topic (inglés)', url: c.url, texto: t.condiciones.slice(0, MAX_CONDICIONES) });
  return docs;
}

function enlaces(c: Convocatoria): Enlace[] {
  return [{ tipo: 'ficha', titulo: 'Ficha en el portal Funding & Tenders', url: c.url }];
}

function datosPlazo(c: Convocatoria): DatosPlazo {
  const t = topicDe(c);
  return {
    fechaFin: t?.fechaLimite ?? null,
    textoFin: t?.fechasLimite.length ? `Fecha límite: ${t.fechasLimite.join(', ')}` : null,
    textoInicio: null,
    publicaciones: [],
    registro: c.fechaPublicacion,
  };
}

export const euFt: Fuente = crearFuenteEuFt();
