// Esquema del análisis (Sonnet) y la regla "cita o desconocido", aplicada en código: un campo sin cita, o con una
// cita que no aparece en los textos leídos, se guarda como desconocido aunque el LLM haya dado un valor.
import type { Perfil } from '../types.ts';
import { citaEnTexto, normalizarParaCita } from '../texto.ts';

/** Campo extraído con su cita literal. `valor === null` ⇒ desconocido (y `motivo` dice por qué). */
export interface CampoCitado<T extends string = string> {
  valor: T | null;
  cita: string | null;
  /** Título del documento donde está la cita. */
  documento: string | null;
  /** Solo si es desconocido. */
  motivo?: string;
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
  importeMaximoProyecto: CampoCitado;
  importeTotal: CampoCitado;
  plazo: CampoCitado;
  cofinanciacion: CampoCitado;
  /** Solo los requisitos con cita comprobada. */
  requisitos: CampoCitado[];
  lineas: LineaEncaje[];
  /** 3–4 líneas; no necesita cita, pero no puede traer importes que no estén en los textos. */
  ideaProyecto: string | null;
  /** Lo que el código quitó o dejó como desconocido (para que se vea en la ficha y en la API). */
  correcciones: string[];
}

export const CAMPOS_SIMPLES = ['elegibilidadEsfl', 'importeMaximoProyecto', 'importeTotal', 'plazo', 'cofinanciacion'] as const;

const nulable = (s: Record<string, unknown>) => ({ anyOf: [s, { type: 'null' }] });

function esquemaCampo(valor: Record<string, unknown> = { type: 'string' }) {
  return {
    type: 'object',
    properties: { valor: nulable(valor), cita: nulable({ type: 'string' }), documento: nulable({ type: 'string' }) },
    required: ['valor', 'cita', 'documento'],
    additionalProperties: false,
  };
}

/** JSON Schema de la salida estructurada. Las líneas posibles salen del perfil (nada fijo en el código). */
export function esquemaAnalisis(perfil: Perfil): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      elegibilidadEsfl: esquemaCampo({ type: 'string', enum: ['si', 'no'] }),
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
            motivo: { type: 'string' },
            cita: nulable({ type: 'string' }),
            documento: nulable({ type: 'string' }),
          },
          required: ['linea', 'motivo', 'cita', 'documento'],
          additionalProperties: false,
        },
      },
      ideaProyecto: nulable({ type: 'string' }),
    },
    required: ['elegibilidadEsfl', 'importeMaximoProyecto', 'importeTotal', 'plazo', 'cofinanciacion', 'requisitos', 'lineas', 'ideaProyecto'],
    additionalProperties: false,
  };
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

  const campo = <T extends string>(nombre: string, v: unknown, validos?: readonly T[]): CampoCitado<T> => {
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

  return {
    elegibilidadEsfl: campo('elegibilidadEsfl', r.elegibilidadEsfl, ['si', 'no'] as const),
    importeMaximoProyecto: campo('importeMaximoProyecto', r.importeMaximoProyecto),
    importeTotal: campo('importeTotal', r.importeTotal),
    plazo: campo('plazo', r.plazo),
    cofinanciacion: campo('cofinanciacion', r.cofinanciacion),
    requisitos,
    lineas,
    ideaProyecto: limpiarIdea(str(r.ideaProyecto), normalizados.map((t) => t.n).join('\n'), correcciones),
    correcciones,
  };
}

const IMPORTE = /\d[\d.,]*\s*(?:€|euros?|eur\b)|(?:€|eur)\s*\d[\d.,]*/gi;

/** La idea no lleva cita, pero no puede inventar importes: los que no están en los textos se sustituyen. */
function limpiarIdea(idea: string | null, todo: string, correcciones: string[]): string | null {
  if (!idea) return null;
  const cifras = new Set((todo.match(/\d[\d.,]*\d|\d/g) ?? []).map((n) => n.replace(/\D/g, '')));
  return idea.replace(IMPORTE, (m) => {
    const cifra = (m.match(/\d[\d.,]*\d|\d/) ?? [''])[0].replace(/\D/g, '');
    if (cifra && cifras.has(cifra)) return m;
    correcciones.push(`ideaProyecto: importe "${m.trim()}" no aparece en los textos; se quita`);
    return '(importe por confirmar)';
  });
}
