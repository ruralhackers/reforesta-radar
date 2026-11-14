// Fuente "placsp": licitaciones de la Plataforma de Contratación del Sector Público (PLACSP), por su sindicación ATOM de datos abiertos.
//
// Feed (verificado en vivo, 2026-11-14): https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom
// «Licitaciones publicadas en la Plataforma» (perfiles de contratante, formato CODICE/UBL «Completo v3»). Las licitaciones de plataformas agregadas
// (sindicacion_1044…) piden certificado de cliente y responden «Su certificado no está autorizado»: no se pueden leer. Es un feed paginado hacia atrás:
//   · la primera página es el propio .atom; `<link rel="next">` apunta a la página anterior en el tiempo (…_20261113_202142.atom, luego …_1.atom…);
//   · cada página trae ~500 entradas (todas las versiones de las licitaciones tocadas en esas horas: ~1 hora en el pico, ~7 de tarde) y pesa ~14 MB;
//   · cada entrada es una licitación con su estado (`ContractFolderStatusCode`: PRE anuncio previo, PUB en plazo, EV pendiente de adjudicación, ADJ, RES, ANUL),
//     CPV, lugar de ejecución (NUTS), presupuesto (TaxExclusiveAmount = sin IVA; EstimatedOverallContractAmount = valor estimado), plazo de ofertas
//     (TenderSubmissionDeadlinePeriod), procedimiento, lotes, solvencia, criterios de adjudicación y enlaces a los pliegos (GetDocumentByIdServlet).
//   · `at:deleted-entry` marca las anuladas (se ignoran: una licitación anulada deja de aparecer, y la vigente sale del ranking al pasar su plazo).
// Las páginas son enormes: se pagina hacia atrás solo hasta la última entrada ya leída (cobertura guardada por el motor en `fuente_estado`, con los huecos de las pasadas interrumpidas), con tope de páginas, de bytes por
// página y totales y pausa entre ellas. No se bajan los ZIP mensuales en cada pasada: para rellenar atrás una vez, `npm run licitaciones`.
// Los PDF de los pliegos (PCAP/PPT) los lee el análisis con la descarga segura; la plataforma los rechaza a veces con una página «Request Rejected» (ver documentos.ts).
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { config } from '../config.ts';
import { diaLocal, sumarDias } from '../dates.ts';
import { leerEstadoFuente } from '../db/repo.ts';
import { fetchSeguro } from '../fetch-seguro.ts';
import type { DatosPlazo } from '../plazos.ts';
import { ubicacionEnAmbito } from '../rules.ts';
import type { Convocatoria, Cribada } from '../types.ts';
import { dormirReal } from './eu-ft.ts';
import type { ContextoFuente, DocumentoFuente, Enlace, Fuente, ResultadoFuente } from './source.ts';

export const FUENTE_PLACSP = 'placsp';
export const PREFIJO_ID = 'licitacion:';
const USER_AGENT = 'reforesta-radar/0.1 (+https://github.com/ruralhackers/reforesta-radar)';
/** Los enlaces `next` salen de datos: solo se siguen si apuntan a este host y a la sindicación. */
const HOST_PLACSP = /^(?:www\.)?contrataciondelestado\.es$/i;

// --- XML mínimo ---
// Las entradas son XML de máquina, bien formado y con prefijos fijos: un lector pequeño basta (sin dependencias nuevas). Los nombres se guardan sin prefijo.

export interface Nodo { n: string; a: Record<string, string>; h: Nodo[]; t: string }

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** Entidades XML: total, nunca lanza. Un código numérico inválido (fuera de rango, sustituto UTF-16, no número) se convierte en U+FFFD. */
const decodificar = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
  if (e[0] === '#') {
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\uFFFD';
  }
  return ENTIDADES[e.toLowerCase()] ?? m;
});

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s>/]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATRIBUTO = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const local = (n: string) => n.slice(n.indexOf(':') + 1);

export function parsearXml(xml: string): Nodo {
  const raiz: Nodo = { n: '#raiz', a: {}, h: [], t: '' };
  const pila: Nodo[] = [raiz];
  for (const m of xml.matchAll(TOKEN)) {
    const actual = pila[pila.length - 1];
    if (m[1] !== undefined) actual.t += m[1];
    else if (m[3] !== undefined) {
      if (m[2]) { if (pila.length > 1) pila.pop(); continue; }
      const nodo: Nodo = { n: local(m[3]), a: {}, h: [], t: '' };
      for (const x of m[4].matchAll(ATRIBUTO)) nodo.a[local(x[1])] = decodificar(x[2] ?? x[3] ?? '');
      actual.h.push(nodo);
      if (!m[5]) pila.push(nodo);
    } else if (m[6] !== undefined) actual.t += decodificar(m[6]);
  }
  return raiz;
}

const hijos = (n: Nodo | null | undefined, nombre: string): Nodo[] => n?.h.filter((x) => x.n === nombre) ?? [];
const hijo = (n: Nodo | null | undefined, ...ruta: string[]): Nodo | null => ruta.reduce<Nodo | null>((a, r) => hijos(a, r)[0] ?? null, n ?? null);
const texto = (n: Nodo | null | undefined): string | null => { const t = n?.t.replace(/\s+/g, ' ').trim(); return t || null; };
const textoDe = (n: Nodo | null | undefined, ...ruta: string[]): string | null => texto(hijo(n, ...ruta));
const numero = (n: Nodo | null | undefined, ...ruta: string[]): number | null => { const v = Number(textoDe(n, ...ruta)); return Number.isFinite(v) && textoDe(n, ...ruta) !== null ? v : null; };
/** Todos los descendientes con ese nombre, en orden de documento (sin entrar en los que ya han coincidido). */
function descendientes(n: Nodo | null | undefined, nombre: string, salida: Nodo[] = []): Nodo[] {
  for (const x of n?.h ?? []) {
    if (x.n === nombre) salida.push(x);
    else descendientes(x, nombre, salida);
  }
  return salida;
}
const todos = (n: Nodo | null | undefined, nombre: string, salida: Nodo[] = []): Nodo[] => {
  for (const x of n?.h ?? []) { if (x.n === nombre) salida.push(x); todos(x, nombre, salida); }
  return salida;
};

// --- Licitación ---

export const TIPOS_CONTRATO: Record<string, string> = {
  '1': 'Suministros', '2': 'Servicios', '3': 'Obras', '21': 'Gestión de servicios públicos', '22': 'Concesión de servicios', '31': 'Concesión de obras públicas',
  '32': 'Concesión de obras', '40': 'Colaboración público-privada', '7': 'Administrativo especial', '8': 'Privado', '50': 'Patrimonial',
};
export const PROCEDIMIENTOS: Record<string, string> = {
  '1': 'Abierto', '2': 'Restringido', '3': 'Negociado sin publicidad', '4': 'Negociado con publicidad', '5': 'Diálogo competitivo', '6': 'Contrato menor',
  '7': 'Derivado de acuerdo marco', '8': 'Concurso de proyectos', '9': 'Abierto simplificado', '10': 'Asociación para la innovación',
  '11': 'Derivado de asociación para la innovación', '12': 'Basado en un sistema dinámico de adquisición', '13': 'Licitación con negociación', '100': 'Normas internas', '999': 'Otros',
};
/** Tipos de contrato que una ONG de servicios puede ejecutar: servicios y obras (las concesiones y los suministros quedan fuera). */
const TIPOS_EJECUTABLES = new Set(['Servicios', 'Obras', 'Administrativo especial']);
const UNIDADES: Record<string, [string, string]> = { MON: ['mes', 'meses'], ANN: ['año', 'años'], DAY: ['día', 'días'], WEE: ['semana', 'semanas'], HUR: ['hora', 'horas'] };
const NIVEL_ORGANO: Record<string, string> = { '1': 'ESTADO', '2': 'AUTONOMICA', '3': 'LOCAL' };

export interface LoteLicitacion { id: string | null; nombre: string | null; presupuestoSinIva: number | null; cpv: string[]; nuts: string[] }
export interface CriterioLicitacion { tipo: string; descripcion: string; peso: number | null; lote: string | null }
export interface DocumentoLicitacion { titulo: string; url: string; clase: 'pliego_administrativo' | 'pliego_tecnico' | 'documento' }

export interface Licitacion {
  /** Número de la entrada (…/licitacionesPerfilContratante/<id>): estable entre las versiones de la misma licitación. */
  id: string;
  expediente: string | null;
  /** Código de estado de la Plataforma: PUB = en plazo. */
  estado: string;
  titulo: string;
  /** Última actualización de la entrada (ISO con zona). */
  actualizada: string;
  /** Primer día de publicación de un anuncio (YYYY-MM-DD) o, sin él, el de la actualización. */
  publicada: string;
  /** Enlace a la ficha en la Plataforma. */
  url: string;
  organo: string | null;
  organoNif: string | null;
  organoCiudad: string | null;
  /** Nivel de la administración por el tipo de órgano: ESTADO, AUTONOMICA, LOCAL u OTROS. */
  nivelOrgano: string;
  tipoContrato: string | null;
  procedimiento: string | null;
  cpv: string[];
  /** Lugar de ejecución: códigos NUTS y nombres (del proyecto y de sus lotes). */
  nuts: string[];
  lugares: string[];
  presupuestoSinIva: number | null;
  valorEstimado: number | null;
  presupuestoConIva: number | null;
  duracion: string | null;
  /** Plazo de presentación de ofertas: YYYY-MM-DD y hora. */
  plazoOfertas: { fecha: string; hora: string | null } | null;
  lotes: LoteLicitacion[];
  solvenciaEconomica: string[];
  solvenciaTecnica: string[];
  criterios: CriterioLicitacion[];
  documentos: DocumentoLicitacion[];
  /** Dónde se ejecuta frente al ámbito del perfil cuando se leyó: 'dentro' o 'parcial' (la criba LLM lo comprueba). */
  ambito: 'dentro' | 'parcial';
  /** Resumen de lo que, si cambia en una versión posterior (presupuestos, plazo, lotes, CPV, lugar), obliga a volver a cribar y analizar. */
  huella: string;
}

const ISO_DIA = /^\d{4}-\d{2}-\d{2}/;

function duracionTexto(p: Nodo | null): string | null {
  const d = hijo(p, 'PlannedPeriod', 'DurationMeasure');
  const v = Number(texto(d));
  if (!d || !Number.isFinite(v) || v <= 0) return null;
  const u = UNIDADES[d.a.unitCode ?? ''];
  return u ? `${v} ${v === 1 ? u[0] : u[1]}` : `${v} ${d.a.unitCode ?? ''}`.trim();
}

function claseDocumento(nombre: string): DocumentoLicitacion['clase'] {
  if (nombre === 'LegalDocumentReference') return 'pliego_administrativo';
  if (nombre === 'TechnicalDocumentReference') return 'pliego_tecnico';
  return 'documento';
}

/** Una entrada ATOM (ya parseada) → licitación; null si le falta el id o el título. */
export function aLicitacion(entrada: Nodo): Licitacion | null {
  const idUrl = textoDe(entrada, 'id') ?? '';
  const id = /(\d+)\s*$/.exec(idUrl)?.[1];
  const carpeta = hijo(entrada, 'ContractFolderStatus');
  const proyecto = hijo(carpeta, 'ProcurementProject');
  const titulo = textoDe(proyecto, 'Name') ?? textoDe(entrada, 'title');
  if (!id || !carpeta || !titulo) return null;
  const actualizada = textoDe(entrada, 'updated') ?? '';
  const publicaciones = todos(carpeta, 'IssueDate').map((n) => texto(n)).filter((d): d is string => !!d && ISO_DIA.test(d)).map((d) => d.slice(0, 10)).sort();
  const parte = hijo(carpeta, 'LocatedContractingParty', 'Party');
  const lotesNodos = hijos(carpeta, 'ProcurementProjectLot');
  const proyectos = [proyecto, ...lotesNodos.map((l) => hijo(l, 'ProcurementProject'))].filter((p): p is Nodo => p !== null);
  const unicos = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const cpv = unicos(proyectos.flatMap((p) => descendientes(p, 'ItemClassificationCode').map((n) => texto(n))));
  const nuts = unicos(proyectos.flatMap((p) => descendientes(p, 'CountrySubentityCode').map((n) => texto(n)?.toUpperCase() ?? null)));
  const lugares = unicos(proyectos.flatMap((p) => descendientes(p, 'CountrySubentity').map((n) => texto(n))));
  const presupuesto = hijo(proyecto, 'BudgetAmount');
  const fin = hijo(carpeta, 'TenderingProcess', 'TenderSubmissionDeadlinePeriod');
  const fechaFin = textoDe(fin, 'EndDate');
  const terminos = [hijo(carpeta, 'TenderingTerms'), ...lotesNodos.map((l) => hijo(l, 'TenderingTerms'))];
  const lotes: LoteLicitacion[] = lotesNodos.map((l) => {
    const p = hijo(l, 'ProcurementProject');
    return {
      id: textoDe(l, 'ID'), nombre: textoDe(p, 'Name'), presupuestoSinIva: numero(p, 'BudgetAmount', 'TaxExclusiveAmount'),
      cpv: unicos(descendientes(p, 'ItemClassificationCode').map((n) => texto(n))), nuts: unicos(descendientes(p, 'CountrySubentityCode').map((n) => texto(n)?.toUpperCase() ?? null)),
    };
  });
  const criterios: CriterioLicitacion[] = [];
  terminos.forEach((t, i) => {
    const lote = i === 0 ? null : (lotes[i - 1]?.id ?? String(i));
    for (const c of descendientes(t, 'AwardingCriteria')) {
      const descripcion = textoDe(c, 'Description') ?? textoDe(c, 'Note');
      if (descripcion) criterios.push({ tipo: textoDe(c, 'AwardingCriteriaTypeCode') ?? '', descripcion, peso: numero(c, 'WeightNumeric'), lote });
    }
  });
  const descripciones = (nombre: string) => unicos(terminos.flatMap((t) => descendientes(t, nombre).map((c) => textoDe(c, 'Description'))));
  const documentos: DocumentoLicitacion[] = [];
  for (const nombre of ['LegalDocumentReference', 'TechnicalDocumentReference', 'AdditionalDocumentReference', 'GeneralDocument', 'TechnicalDocument']) {
    for (const d of todos(carpeta, nombre)) {
      const url = textoDe(d, 'Attachment', 'ExternalReference', 'URI');
      if (!url || documentos.some((x) => x.url === url)) continue;
      documentos.push({ titulo: textoDe(d, 'ID') ?? 'Documento', url, clase: claseDocumento(nombre) });
    }
  }
  const tipo = textoDe(proyecto, 'TypeCode');
  const proc = textoDe(carpeta, 'TenderingProcess', 'ProcedureCode');
  const enlace = hijos(entrada, 'link').find((l) => l.a.href && (!l.a.rel || l.a.rel === 'alternate'))?.a.href ?? idUrl;
  return {
    id, expediente: textoDe(carpeta, 'ContractFolderID'), estado: textoDe(carpeta, 'ContractFolderStatusCode') ?? '', titulo, actualizada,
    publicada: publicaciones[0] ?? (actualizada.slice(0, 10) || ''), url: enlace,
    organo: textoDe(parte, 'PartyName', 'Name'), organoNif: descendientes(parte, 'PartyIdentification').map((p) => hijo(p, 'ID')).find((n) => n?.a.schemeName === 'NIF')?.t.trim() ?? null,
    organoCiudad: textoDe(parte, 'PostalAddress', 'CityName'), nivelOrgano: NIVEL_ORGANO[textoDe(hijo(carpeta, 'LocatedContractingParty'), 'ContractingPartyTypeCode') ?? ''] ?? 'OTROS',
    tipoContrato: tipo ? (TIPOS_CONTRATO[tipo] ?? tipo) : null, procedimiento: proc ? (PROCEDIMIENTOS[proc] ?? proc) : null,
    cpv, nuts, lugares, presupuestoSinIva: numero(presupuesto, 'TaxExclusiveAmount'), valorEstimado: numero(presupuesto, 'EstimatedOverallContractAmount'),
    presupuestoConIva: numero(presupuesto, 'TotalAmount'), duracion: duracionTexto(proyecto),
    plazoOfertas: fechaFin && ISO_DIA.test(fechaFin) ? { fecha: fechaFin.slice(0, 10), hora: textoDe(fin, 'EndTime')?.slice(0, 5) ?? null } : null,
    lotes, solvenciaEconomica: descripciones('FinancialEvaluationCriteria'), solvenciaTecnica: descripciones('TechnicalEvaluationCriteria'), criterios, documentos,
    ambito: 'dentro',
    huella: '',
  };
}

/** Huella de lo material de una licitación (ver `Licitacion.huella`): no incluye el estado ni la fecha de actualización. */
export function huellaLicitacion(l: Licitacion): string {
  return createHash('sha1').update(JSON.stringify([
    l.titulo, l.presupuestoSinIva, l.valorEstimado, l.plazoOfertas, l.cpv, l.nuts, l.lotes.map((x) => [x.id, x.nombre, x.presupuestoSinIva]), l.criterios.map((k) => [k.tipo, k.peso]),
  ])).digest('hex').slice(0, 16);
}

// --- Pre-filtro: CPV y palabras del título (seed/licitaciones.json). Pasa con un CPV de la lista o con una palabra en el título (o en el de un lote). ---

export interface FiltroPlacsp { cpv: string[]; palabras: string[] }

const sinTildes = (t: string) => t.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
/** 77200000 → 772: un CPV es un prefijo, sin sus ceros finales. */
const prefijoCpv = (c: string) => c.trim().replace(/0+$/, '');

export function leerFiltroPlacsp(cfg: { rutaFiltro: string; cpvExtra: string[]; palabrasExtra: string[] } = config.placsp): FiltroPlacsp {
  const j = JSON.parse(readFileSync(cfg.rutaFiltro, 'utf8')) as Record<string, unknown>;
  const lista = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
  const f = { cpv: [...lista(j.cpv), ...cfg.cpvExtra], palabras: [...lista(j.palabras), ...cfg.palabrasExtra] };
  if (f.cpv.length === 0 && f.palabras.length === 0) throw new Error(`${cfg.rutaFiltro}: faltan las listas "cpv" y "palabras"`);
  return f;
}

const regexPalabras = (palabras: string[]) => new RegExp(palabras.map((p) => {
  const entera = p.endsWith('$');
  const cuerpo = sinTildes(entera ? p.slice(0, -1) : p).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return `(?<![a-z0-9])${cuerpo}${entera ? '(?![a-z0-9])' : ''}`;
}).join('|'), 'i');

export type MotivoTema = 'cpv' | 'palabra' | null;

/** ¿Pasa el pre-filtro de tema? Devuelve por qué (CPV o palabra del título) o null. */
export function temaDeLicitacion(l: Pick<Licitacion, 'cpv' | 'titulo' | 'lotes'>, f: FiltroPlacsp): MotivoTema {
  if (l.cpv.some((c) => f.cpv.some((p) => c.startsWith(prefijoCpv(p))))) return 'cpv';
  if (f.palabras.length > 0 && regexPalabras(f.palabras).test(sinTildes([l.titulo, ...l.lotes.map((x) => x.nombre ?? '')].join(' | ')))) return 'palabra';
  return null;
}

// --- Recogida ---

export interface OpcionesFuentePlacsp {
  urlFeed: string; maxPaginas: number; maxBytesPagina: number; maxBytesTotal: number; pausaMs: number; timeoutMs: number;
  /** Pagina hasta el tope sin parar en lo ya cubierto ni guardar cobertura (relleno puntual: `npm run licitaciones`). */
  ignorarCursor?: boolean;
  filtro?: FiltroPlacsp;
}

export interface PaginaFeed { entradas: string[]; siguiente: string | null; actualizacionMasReciente: string | null; actualizacionMasAntigua: string | null }

const ENTRADA = /<entry>[\s\S]*?<\/entry>/g;

/** Las entradas de una página, una a una (sin construir el array entero: una página son ~14 MB). */
export function* iterarEntradas(xml: string): Generator<string> {
  let i = 0;
  for (;;) {
    const a = xml.indexOf('<entry>', i);
    if (a < 0) return;
    const b = xml.indexOf('</entry>', a);
    if (b < 0) return;
    i = b + '</entry>'.length;
    yield xml.slice(a, i);
  }
}

/** El enlace `rel="next"` de la cabecera de la página (antes de la primera entrada). */
export function enlaceSiguiente(xml: string): string | null {
  const cabecera = xml.slice(0, Math.max(0, xml.indexOf('<entry>')) || 20_000);
  const l = [...cabecera.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).find((x) => /rel="next"/.test(x));
  const href = l ? /href="([^"]+)"/.exec(l)?.[1] ?? null : null;
  return href ? decodificar(href) : null;
}

/** Trocea una página del feed en entradas (sin parsearlas) y saca su enlace `next`. */
export function trocearFeed(xml: string): PaginaFeed {
  const entradas = xml.match(ENTRADA) ?? [];
  const fechas = entradas.map((e) => /<updated>([^<]+)<\/updated>/.exec(e)?.[1] ?? '').filter(Boolean).map((d) => Date.parse(d)).filter(Number.isFinite);
  return {
    entradas, siguiente: enlaceSiguiente(xml),
    actualizacionMasReciente: fechas.length ? new Date(Math.max(...fechas)).toISOString() : null,
    actualizacionMasAntigua: fechas.length ? new Date(Math.min(...fechas)).toISOString() : null,
  };
}

function urlSindicacionValida(u: string | null): u is string {
  if (!u) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && HOST_PLACSP.test(url.hostname) && url.pathname.startsWith('/sindicacion/');
  } catch {
    return false;
  }
}

const KB = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

function aConvocatoria(l: Licitacion): Convocatoria {
  return {
    id: `${PREFIJO_ID}${l.id}`, fuente: FUENTE_PLACSP, fuenteId: l.id, titulo: l.titulo,
    organo: { nivel1: l.nivelOrgano, nivel2: l.organo, nivel3: null },
    fechaPublicacion: l.publicada, url: l.url, tipo: 'licitacion', finalidad: null, regiones: l.nuts, abierto: l.estado === 'PUB', datos: { licitacion: l },
  };
}

export interface ContadoresPlacsp {
  paginas: number; bytes: number; entradas: number; publicadas: number; enPlazo: number; pasanTema: number; enTerritorio: number; yaLeidas: number; actualizadas: number;
}

/**
 * Qué parte del feed está leída. El feed solo se puede recorrer hacia atrás, así que la cobertura es una ventana continua que llega hasta `hasta` (lo más
 * reciente ya leído) más, si una pasada paró antes de tiempo (error, tope de páginas o de bytes), los HUECOS que quedaron sin leer: cada uno con la URL de la página
 * por la que seguir (la `next` a la que se llegó) y el límite inferior hasta el que hay que leer (lo que ya estaba cubierto antes de esa pasada, o el horizonte de la
 * primera carga). La siguiente pasada lee desde arriba hasta `hasta`, y después cada hueco desde su URL hasta su límite; solo así se cierran. Nunca se da por leído lo que no se leyó.
 */
export interface Cobertura { hasta: string | null; huecos: { url: string; hasta: string }[] }

export const CLAVE_COBERTURA = 'cobertura';

/** Cobertura guardada (o la del cursor antiguo, solo con `hasta`); sin nada, vacía. */
export function leerCobertura(db: DatabaseSync | undefined): Cobertura {
  if (!db) return { hasta: null, huecos: [] };
  const crudo = leerEstadoFuente(db, FUENTE_PLACSP, CLAVE_COBERTURA);
  if (crudo) {
    try {
      const c = JSON.parse(crudo) as Cobertura;
      if ((c.hasta === null || typeof c.hasta === 'string') && Array.isArray(c.huecos)) return { hasta: c.hasta, huecos: c.huecos.filter((h) => typeof h.url === 'string' && typeof h.hasta === 'string') };
    } catch { /* estado ilegible: se trata como primera carga */ }
    return { hasta: null, huecos: [] };
  }
  return { hasta: leerEstadoFuente(db, FUENTE_PLACSP, 'cursor'), huecos: [] };
}

const ETIQUETA_ESTADO: Record<string, string> = { ANUL: 'anulada', ADJ: 'adjudicada', RES: 'resuelta', EV: 'en evaluación (ya no admite ofertas)', PRE: 'solo con anuncio previo' };

export function crearFuentePlacsp(opciones: () => OpcionesFuentePlacsp = () => config.placsp): Fuente {
  async function recoger(ctx: ContextoFuente): Promise<ResultadoFuente> {
    const o = opciones();
    const filtro = o.filtro ?? leerFiltroPlacsp();
    const dormir = ctx.dormir ?? dormirReal;
    const hoy = diaLocal(ctx.ahora);
    const usaCobertura = !!ctx.db && !o.ignorarCursor;
    const previa = usaCobertura ? leerCobertura(ctx.db) : { hasta: null, huecos: [] };
    // Sin cobertura (primera vez o relleno): hasta `diasAtras` días hacia atrás. El límite inferior de la lectura desde arriba es lo ya cubierto o ese horizonte.
    const horizonte = new Date(`${sumarDias(hoy, -ctx.diasAtras)}T00:00:00Z`).toISOString();
    const tareas = [{ url: o.urlFeed, hasta: previa.hasta ?? horizonte, arriba: true }, ...previa.huecos.map((h) => ({ ...h, arriba: false }))];
    const licitaciones = new Map<string, Licitacion>();
    const cierres = new Map<string, { l: Licitacion; estado: string }>();
    const errores: string[] = [];
    const avisos: string[] = [];
    const n: ContadoresPlacsp = { paginas: 0, bytes: 0, entradas: 0, publicadas: 0, enPlazo: 0, pasanTema: 0, enTerritorio: 0, yaLeidas: 0, actualizadas: 0 };
    const almacenada = ctx.db ? ctx.db.prepare(`SELECT json_extract(datos, '$.licitacion.actualizada') AS a FROM convocatorias WHERE id = ?`) : null;
    const yaTieneAlgoMasReciente = (id: string, actualizada: number) => {
      const f = almacenada?.get(`${PREFIJO_ID}${id}`) as { a: string | null } | undefined;
      return f !== undefined && f.a !== null && Date.parse(f.a) >= actualizada;
    };
    const esta = (id: string) => almacenada?.get(`${PREFIJO_ID}${id}`) !== undefined;
    let masReciente: string | null = null;
    let motivoParada = '';
    const huecosNuevos: Cobertura['huecos'] = [];
    let paradaGlobal = false; // tope de páginas/bytes o error: las tareas que quedan se conservan tal cual

    for (const [t, tarea] of tareas.entries()) {
      if (paradaGlobal) { if (!tarea.arriba) huecosNuevos.push({ url: tarea.url, hasta: tarea.hasta }); continue; }
      const limiteMs = Date.parse(tarea.hasta);
      let url: string | null = tarea.url;
      let llegoAlLimite = false;
      while (url) {
        if (n.paginas >= o.maxPaginas) { motivoParada = `tope de ${o.maxPaginas} páginas`; paradaGlobal = true; break; }
        if (n.bytes >= o.maxBytesTotal) { motivoParada = `tope de ${KB(o.maxBytesTotal)} descargados`; paradaGlobal = true; break; }
        if (n.paginas > 0 && o.pausaMs > 0) await dormir(o.pausaMs);
        let xml: string;
        try {
          if (!urlSindicacionValida(url)) throw new Error(`enlace "next" no permitido: ${url}`);
          const r = await fetchSeguro(ctx.fetch, url, { timeoutMs: o.timeoutMs, maxBytes: o.maxBytesPagina, headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml, application/xml;q=0.9', 'Accept-Encoding': 'gzip' }, resolver: ctx.resolver });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          n.bytes += r.bytes.byteLength;
          xml = new TextDecoder().decode(r.bytes); // r (los bytes) sale de ámbito aquí: solo queda una copia de la página
          if (!xml.includes('<feed')) throw new Error('la respuesta no es un feed ATOM');
        } catch (e) {
          if (t === 0 && n.paginas === 0) throw new Error(`Feed de licitaciones: ${(e as Error).message}`); // sin la primera página no hay nada: fallo total (aislado de las demás fuentes)
          errores.push(`Página ${n.paginas + 1} del feed de licitaciones: ${(e as Error).message}`);
          motivoParada = 'error';
          paradaGlobal = true;
          break;
        }
        n.paginas++;
        let masAntigua = Infinity;
        let hubo = false;
        for (const e of iterarEntradas(xml)) {
          hubo = true;
          n.entradas++;
          const actualizada = Date.parse(/<updated>([^<]+)<\/updated>/.exec(e)?.[1] ?? '');
          if (Number.isFinite(actualizada)) {
            masAntigua = Math.min(masAntigua, actualizada);
            if (tarea.arriba && n.paginas === 1 && (masReciente === null || actualizada > Date.parse(masReciente))) masReciente = new Date(actualizada).toISOString();
            if (actualizada <= limiteMs) { n.yaLeidas++; continue; }
          }
          try {
            const estado = /ContractFolderStatusCode[^>]*>\s*([A-Z]+)\s*</.exec(e)?.[1] ?? '';
            if (estado !== 'PUB') {
              // Una versión posterior (anulada, adjudicada, en evaluación) de una licitación ya guardada la retira de la lista de abiertas.
              if (!ctx.db) continue;
              const id = /licitacionesPerfilContratante\/(\d+)/.exec(e)?.[1];
              if (!id || !esta(id) || cierres.has(id) || yaTieneAlgoMasReciente(id, actualizada)) continue;
              const l = aLicitacion(parsearXml(e).h[0]);
              if (l) { cierres.set(l.id, { l: { ...l, huella: huellaLicitacion(l) }, estado: l.estado || estado }); n.actualizadas++; }
              continue;
            }
            n.publicadas++;
            const l0 = aLicitacion(parsearXml(e).h[0]);
            if (!l0 || licitaciones.has(l0.id) || cierres.has(l0.id)) continue; // la primera vista es la más reciente: una versión anterior no la pisa
            if (yaTieneAlgoMasReciente(l0.id, actualizada)) continue; // lo guardado ya es esta versión o una posterior (p. ej. anulada)
            const l = { ...l0, huella: huellaLicitacion(l0) };
            if (l.plazoOfertas && l.plazoOfertas.fecha < hoy) continue;
            n.enPlazo++;
            // Suministros, concesiones y contratos privados o patrimoniales no son servicios ni obras que la entidad pueda ejecutar.
            if (l.tipoContrato !== null && !TIPOS_EJECUTABLES.has(l.tipoContrato)) continue;
            if (temaDeLicitacion(l, filtro) === null) continue;
            n.pasanTema++;
            const ubicacion = ubicacionEnAmbito(l.nuts, ctx.perfil);
            if (ubicacion === 'fuera') continue;
            n.enTerritorio++;
            licitaciones.set(l.id, { ...l, ambito: ubicacion });
          } catch (x) {
            errores.push(`Entrada ilegible: ${(x as Error).message}`);
          }
        }
        if (!hubo) { motivoParada = 'página sin entradas'; llegoAlLimite = true; break; }
        if (masAntigua <= limiteMs) { llegoAlLimite = true; motivoParada = tarea.arriba ? (previa.hasta ? 'llegó a lo ya leído' : `llegó a ${ctx.diasAtras} días atrás`) : 'cerró un hueco'; break; }
        url = enlaceSiguiente(xml);
        if (!url) { llegoAlLimite = true; motivoParada = 'fin del feed'; }
        else if (!urlSindicacionValida(url)) { errores.push(`Página ${n.paginas + 1} del feed de licitaciones: enlace "next" no permitido: ${url}`); motivoParada = 'error'; paradaGlobal = true; llegoAlLimite = true; break; } // no se puede seguir por un enlace así: el hueco no se podría retomar nunca
      }
      // Esta tarea no llegó a su límite: queda un hueco desde la página por la que seguir (la que no se pudo leer o no se llegó a pedir).
      if (!llegoAlLimite && url) huecosNuevos.push({ url, hasta: tarea.hasta });
    }

    avisos.push(
      `Licitaciones (PLACSP): ${n.paginas} páginas (${KB(n.bytes)}), ${n.entradas} entradas leídas${n.yaLeidas ? ` (${n.yaLeidas} ya vistas)` : ''}, ${n.publicadas} en plazo (PUB), `
      + `${n.enPlazo} con plazo de ofertas vigente, ${n.pasanTema} pasan el pre-filtro de tema (CPV o palabras), ${n.enTerritorio} en el territorio del perfil`
      + `${n.actualizadas ? `, ${n.actualizadas} actualizaciones de estado de licitaciones guardadas` : ''}; parada: ${motivoParada || 'fin del feed'}`,
    );
    if (huecosNuevos.length > 0) avisos.push(`El feed de licitaciones quedó sin leer en ${huecosNuevos.length} ${huecosNuevos.length === 1 ? 'tramo' : 'tramos'} (${motivoParada}): la siguiente pasada los retoma desde donde se quedó (la cobertura es continua; sube RADAR_MAX_PAGINAS_PLACSP o usa npm run licitaciones si van acumulándose)`);

    const cribadas: Cribada[] = [...licitaciones.values()].map((l) => {
      const conv = aConvocatoria(l);
      return { convocatoria: conv, descarte: ctx.cribar(conv) };
    });
    for (const { l, estado } of cierres.values()) {
      const conv = aConvocatoria(l);
      cribadas.push({ convocatoria: conv, descarte: { regla: 'estado', motivo: `Licitación ${ETIQUETA_ESTADO[estado] ?? `con estado ${estado}`} (ya no se puede ofertar)` } });
    }
    // La cobertura nueva la guarda el motor en la misma transacción que las licitaciones; nunca se da por leído lo que no se leyó.
    const estadoNuevo = usaCobertura && n.paginas > 0
      ? [{ clave: CLAVE_COBERTURA, valor: JSON.stringify({ hasta: masReciente && (!previa.hasta || Date.parse(masReciente) > Date.parse(previa.hasta)) ? masReciente : previa.hasta ?? masReciente, huecos: huecosNuevos } satisfies Cobertura) }]
      : undefined;
    return { cribadas, errores, avisos, ...(estadoNuevo ? { estado: estadoNuevo } : {}) };
  }
  return { nombre: FUENTE_PLACSP, recoger, documentos, enlaces, datosPlazo };
}

// --- Lo que las fases leen de una licitación guardada ---

export const licitacionDe = (c: Convocatoria): Licitacion | null => ((c.datos as { licitacion?: Licitacion } | null)?.licitacion) ?? null;

const euros = (n: number) => `${n.toLocaleString('es-ES', { maximumFractionDigits: 2 })} €`;
const fechaES = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Texto plano del anuncio (todo lo que el feed sabe): sirve a la criba y al análisis, y es contra lo que se comprueban las citas. */
export function fichaLicitacion(c: Convocatoria, l: Licitacion): string {
  const lineas = [
    `Título: ${l.titulo}`,
    l.expediente && `Expediente: ${l.expediente}`,
    `Órgano de contratación: ${l.organo ?? 'desconocido'}${l.organoCiudad ? ` (${l.organoCiudad})` : ''}`,
    l.tipoContrato && `Tipo de contrato: ${l.tipoContrato}`,
    l.procedimiento && `Procedimiento: ${l.procedimiento}`,
    l.presupuestoSinIva != null && `Presupuesto base de licitación sin IVA: ${euros(l.presupuestoSinIva)}`,
    l.presupuestoConIva != null && `Presupuesto base de licitación con IVA: ${euros(l.presupuestoConIva)}`,
    l.valorEstimado != null && `Valor estimado del contrato: ${euros(l.valorEstimado)}`,
    l.duracion && `Duración del contrato: ${l.duracion}`,
    l.plazoOfertas && `Plazo de presentación de ofertas: hasta el ${fechaES(l.plazoOfertas.fecha)}${l.plazoOfertas.hora ? ` a las ${l.plazoOfertas.hora}` : ''}`,
    l.lugares.length || l.nuts.length ? `Lugar de ejecución: ${[...l.lugares, ...l.nuts].join(', ')}` : null,
    l.cpv.length && `CPV: ${l.cpv.join(', ')}`,
    l.lotes.length ? `Lotes (${l.lotes.length}):\n${l.lotes.map((x) => `- Lote ${x.id ?? '?'}: ${x.nombre ?? 'sin nombre'}${x.presupuestoSinIva != null ? ` (presupuesto sin IVA ${euros(x.presupuestoSinIva)})` : ''}`).join('\n')}` : 'Sin lotes.',
    l.solvenciaEconomica.length ? `Solvencia económica y financiera exigida:\n${l.solvenciaEconomica.map((s) => `- ${s}`).join('\n')}` : null,
    l.solvenciaTecnica.length ? `Solvencia técnica o profesional exigida:\n${l.solvenciaTecnica.map((s) => `- ${s}`).join('\n')}` : null,
    l.criterios.length ? `Criterios de adjudicación:\n${l.criterios.map((k) => `- ${k.tipo === 'OBJ' ? 'Automático' : k.tipo === 'SUBJ' ? 'Juicio de valor' : k.tipo}${k.lote ? ` (lote ${k.lote})` : ''}: ${k.descripcion}${k.peso != null ? ` — ponderación ${k.peso}` : ''}`).join('\n')}` : null,
    `Enlace: ${c.url}`,
  ];
  return lineas.filter(Boolean).join('\n');
}

const MAX_DOCUMENTOS_PLIEGO = 4;

function documentos(c: Convocatoria): DocumentoFuente[] {
  const l = licitacionDe(c);
  if (!l) return [{ titulo: 'Anuncio de licitación', url: c.url, texto: `Título: ${c.titulo}` }];
  const docs: DocumentoFuente[] = [{ titulo: 'Anuncio de licitación (PLACSP)', url: c.url, texto: fichaLicitacion(c, l) }];
  const orden = { pliego_administrativo: 0, pliego_tecnico: 1, documento: 2 } as const;
  const etiqueta = { pliego_administrativo: 'Pliego administrativo (PCAP)', pliego_tecnico: 'Pliego técnico (PPT)', documento: 'Documento' } as const;
  for (const d of [...l.documentos].sort((a, b) => orden[a.clase] - orden[b.clase]).slice(0, MAX_DOCUMENTOS_PLIEGO)) docs.push({ titulo: `${etiqueta[d.clase]}: ${d.titulo}`, url: d.url });
  return docs;
}

function enlaces(c: Convocatoria): Enlace[] {
  const l = licitacionDe(c);
  const lista: Enlace[] = [{ tipo: 'ficha', titulo: 'Ficha en la Plataforma de Contratación del Sector Público', url: c.url }];
  for (const d of l?.documentos ?? []) lista.push({ tipo: d.clase === 'pliego_administrativo' ? 'bases' : 'documento', titulo: d.titulo, url: d.url });
  return lista;
}

function datosPlazo(c: Convocatoria): DatosPlazo {
  const l = licitacionDe(c);
  return {
    fechaFin: l?.plazoOfertas?.fecha ?? null,
    textoFin: l?.plazoOfertas ? `Plazo de presentación de ofertas: hasta el ${fechaES(l.plazoOfertas.fecha)}${l.plazoOfertas.hora ? ` a las ${l.plazoOfertas.hora}` : ''}` : null,
    textoInicio: null,
    publicaciones: [],
    registro: c.fechaPublicacion,
  };
}

export const placsp: Fuente = crearFuentePlacsp();
