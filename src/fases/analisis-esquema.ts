// Esquema del análisis (Sonnet) y la regla "cita o desconocido", aplicada en código: un campo sin cita, con una
// cita que no aparece en los textos leídos o (importes, plazo, cofinanciación) cuyas cifras no están en su cita,
// se guarda como desconocido aunque el LLM haya dado un valor.
import type { Perfil } from '../types.ts';
import { validarTituloCorto } from '../titulo.ts';
import { citaEnTexto, normalizarParaCita, valorEnCita } from '../texto.ts';

/** Campo extraído con su cita literal. `valor === null` ⇒ desconocido (y `motivo` dice por qué). */
export interface CampoCitado<T extends string = string> {
  valor: T | null;
  cita: string | null;
  /** Título del documento donde está la cita. */
  documento: string | null;
  /** Solo si es desconocido. */
  motivo?: string;
  /** Solo en `elegibilidadSede` con valor "no": por qué (p. ej. "Exige sede social en el Distrito de Usera; la entidad está en Tres Cantos"). */
  razon?: string;
}

export interface LineaEncaje {
  linea: string;
  motivo: string;
  cita: string | null;
  documento: string | null;
}

/** Lo que se guarda en `convocatoria_fases.datos` de la fase `analisis` (campo `analisis`). */
export interface Analisis {
  elegibilidadEsfl: CampoCitado<'si' | 'no'>;
  /** "no" si los documentos exigen sede, domicilio o inscripción en un territorio donde la entidad no está domiciliada; ausente en análisis anteriores. */
  elegibilidadSede?: CampoCitado<'si' | 'no'>;
  importeMaximoProyecto: CampoCitado;
  importeTotal: CampoCitado;
  plazo: CampoCitado;
  cofinanciacion: CampoCitado;
  /** Solo los requisitos con cita comprobada. */
  requisitos: CampoCitado[];
  lineas: LineaEncaje[];
  /** Título corto y legible (≤ 90 caracteres, en frase normal) para listas y tarjetas; ausente en análisis anteriores. */
  tituloCorto?: string | null;
  /** 3–4 líneas; no necesita cita, pero no puede traer importes que no estén en los textos. */
  ideaProyecto: string | null;
  /** Lo que el código quitó o dejó como desconocido (para que se vea en la ficha y en la API). */
  correcciones: string[];
}

export const CAMPOS_SIMPLES = ['elegibilidadEsfl', 'importeMaximoProyecto', 'importeTotal', 'plazo', 'cofinanciacion'] as const;

// La salida estructurada admite como mucho 16 parámetros con uniones (anyOf / tipos nulables). Por eso el esquema
// no usa null: "desconocido" es la cadena vacía, y `aplicarCitas` la convierte (str() trata "" como ausente).
const texto = { type: 'string' };

function esquemaCampo(valor: Record<string, unknown> = texto) {
  return {
    type: 'object',
    properties: { valor, cita: texto, documento: texto },
    required: ['valor', 'cita', 'documento'],
    additionalProperties: false,
  };
}

/** JSON Schema de la salida estructurada (sin uniones). Las líneas posibles salen del perfil (nada fijo en el código). */
export function esquemaAnalisis(perfil: Perfil): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      elegibilidadEsfl: esquemaCampo({ type: 'string', enum: ['si', 'no', ''] }),
      elegibilidadSede: {
        type: 'object',
        properties: { valor: { type: 'string', enum: ['si', 'no', ''] }, cita: texto, documento: texto, razon: texto },
        required: ['valor', 'cita', 'documento', 'razon'],
        additionalProperties: false,
      },
      importeMaximoProyecto: esquemaCampo(),
      importeTotal: esquemaCampo(),
      plazo: esquemaCampo(),
      cofinanciacion: esquemaCampo(),
      requisitos: { type: 'array', items: esquemaCampo() },
      lineas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            linea: { type: 'string', enum: perfil.lineas.map((l) => l.nombre) },
            motivo: texto,
            cita: texto,
            documento: texto,
          },
          required: ['linea', 'motivo', 'cita', 'documento'],
          additionalProperties: false,
        },
      },
      ideaProyecto: texto,
      tituloCorto: texto,
    },
    required: ['elegibilidadEsfl', 'elegibilidadSede', 'importeMaximoProyecto', 'importeTotal', 'plazo', 'cofinanciacion', 'requisitos', 'lineas', 'ideaProyecto', 'tituloCorto'],
    additionalProperties: false,
  };
}

/** Parámetros con uniones (anyOf/oneOf o `type` con varios tipos) de un JSON Schema: la API admite 16 como mucho. */
export function contarUniones(esquema: unknown): number {
  if (Array.isArray(esquema)) return esquema.reduce((t: number, x) => t + contarUniones(x), 0);
  if (!esquema || typeof esquema !== 'object') return 0;
  const o = esquema as Record<string, unknown>;
  const propia = Array.isArray(o.type) || 'anyOf' in o || 'oneOf' in o ? 1 : 0;
  return propia + Object.values(o).reduce((t: number, v) => t + contarUniones(v), 0);
}

export interface TextoLeido {
  titulo: string;
  texto: string;
}

type Bruto = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Convierte la respuesta del LLM en un `Analisis` aplicando la regla de citas contra los textos que se le enviaron.
 * No lanza: lo que no encaja en el esquema se queda como desconocido.
 */
export function aplicarCitas(bruto: unknown, textos: TextoLeido[], perfil: Perfil): Analisis {
  const r = (bruto && typeof bruto === 'object' ? bruto : {}) as Bruto;
  const normalizados = textos.map((t) => ({ titulo: t.titulo, n: normalizarParaCita(t.texto) }));
  const correcciones: string[] = [];

  /** Documento donde aparece la cita (primero el que dijo el LLM), o null si no aparece en ninguno. */
  const localizar = (cita: string, documento: string | null): string | null => {
    const orden = [...normalizados].sort((a, b) => Number(b.titulo === documento) - Number(a.titulo === documento));
    return orden.find((t) => citaEnTexto(cita, t.n))?.titulo ?? null;
  };

  /** `numerico`: importes, porcentajes, plazos y fechas: las cifras del valor tienen que estar en la cita. */
  const campo = <T extends string>(nombre: string, v: unknown, validos?: readonly T[], numerico = false): CampoCitado<T> => {
    const o = (v && typeof v === 'object' ? v : {}) as Bruto;
    const valor = str(o.valor);
    const cita = str(o.cita);
    const desconocido = (motivo: string): CampoCitado<T> => {
      if (valor) correcciones.push(`${nombre}: ${motivo}; se descarta el valor "${valor}"`);
      return { valor: null, cita: null, documento: null, motivo };
    };
    if (!valor) return { valor: null, cita: null, documento: null, motivo: 'No consta en los textos' };
    if (validos && !validos.includes(valor as T)) return desconocido(`valor no válido`);
    if (!cita) return desconocido('sin cita literal');
    const documento = localizar(cita, str(o.documento));
    if (!documento) return desconocido('la cita no aparece en los textos leídos');
    if (numerico && !valorEnCita(valor, cita)) return desconocido('el valor no está en la cita');
    return { valor: valor as T, cita, documento };
  };

  const requisitosBrutos = Array.isArray(r.requisitos) ? r.requisitos : [];
  const requisitos = requisitosBrutos
    .map((q, i) => campo(`requisitos[${i}]`, q))
    .filter((q) => q.valor !== null);

  const nombresLineas = new Set(perfil.lineas.map((l) => l.nombre));
  const lineas: LineaEncaje[] = [];
  for (const l of Array.isArray(r.lineas) ? r.lineas : []) {
    const o = (l && typeof l === 'object' ? l : {}) as Bruto;
    const linea = str(o.linea);
    if (!linea || !nombresLineas.has(linea)) {
      if (linea) correcciones.push(`lineas: "${linea}" no es una línea del perfil`);
      continue;
    }
    if (lineas.some((x) => x.linea === linea)) continue;
    const cita = str(o.cita);
    const documento = cita ? localizar(cita, str(o.documento)) : null;
    if (cita && !documento) correcciones.push(`lineas: la cita de "${linea}" no aparece en los textos; se quita la cita`);
    lineas.push({ linea, motivo: str(o.motivo) ?? '', cita: documento ? cita : null, documento });
  }

  /** Sede: solo cuenta un "no" con cita comprobada y razón; sin domicilio en el perfil no se evalúa. */
  const sede = (): CampoCitado<'si' | 'no'> => {
    const c = campo('elegibilidadSede', r.elegibilidadSede, ['si', 'no'] as const);
    if (!perfil.domicilio) return { valor: null, cita: null, documento: null, motivo: 'La entidad no tiene domicilio en el perfil' };
    if (c.valor !== 'no') return c;
    const o = (r.elegibilidadSede && typeof r.elegibilidadSede === 'object' ? r.elegibilidadSede : {}) as Bruto;
    const razon = str(o.razon);
    if (!razon) { correcciones.push('elegibilidadSede: sin razón; se descarta el valor "no"'); return { valor: null, cita: null, documento: null, motivo: 'sin razón' }; }
    return { ...c, razon };
  };

  return {
    elegibilidadEsfl: campo('elegibilidadEsfl', r.elegibilidadEsfl, ['si', 'no'] as const),
    elegibilidadSede: sede(),
    importeMaximoProyecto: campo('importeMaximoProyecto', r.importeMaximoProyecto, undefined, true),
    importeTotal: campo('importeTotal', r.importeTotal, undefined, true),
    plazo: campo('plazo', r.plazo, undefined, true),
    cofinanciacion: campo('cofinanciacion', r.cofinanciacion, undefined, true),
    requisitos,
    lineas,
    tituloCorto: validarTituloCorto(r.tituloCorto),
    ideaProyecto: limpiarIdea(str(r.ideaProyecto), normalizados.map((t) => t.n).join('\n'), correcciones),
    correcciones,
  };
}

const IMPORTE = /\d[\d.,]*\s*(?:€|euros?|eur\b)|(?:€|eur)\s*\d[\d.,]*/gi;

/** La idea no lleva cita, pero no puede inventar importes: los que no están en los textos se sustituyen. */
export function limpiarIdea(idea: string | null, todo: string, correcciones: string[]): string | null {
  if (!idea) return null;
  const cifras = new Set((todo.match(/\d[\d.,]*\d|\d/g) ?? []).map((n) => n.replace(/\D/g, '')));
  return idea.replace(IMPORTE, (m) => {
    const cifra = (m.match(/\d[\d.,]*\d|\d/) ?? [''])[0].replace(/\D/g, '');
    if (cifra && cifras.has(cifra)) return m;
    correcciones.push(`ideaProyecto: importe "${m.trim()}" no aparece en los textos; se quita`);
    return '(importe por confirmar)';
  });
}
