// Esquema del análisis de una licitación (Sonnet) y la regla "cita o desconocido", como en analisis-esquema.ts: un campo sin cita, con una cita que no aparece en los
// textos leídos o (presupuesto, plazo, ponderaciones) cuyas cifras no están en su cita, se guarda como desconocido aunque el LLM haya dado un valor.
// Se guarda en `convocatoria_fases.datos.analisis` de la fase `analisis` con `tipo: 'licitacion'`. Comparte con el análisis de convocatorias los campos que otras
// piezas leen de cualquier análisis (`plazo`, `lineas`, `requisitos`, `ideaProyecto`, `tituloCorto`, `correcciones`).
import { citaEnTexto, normalizarParaCita, valorEnCita } from '../texto.ts';
import { validarTituloCorto } from '../titulo.ts';
import type { Perfil } from '../types.ts';
import { type CampoCitado, limpiarIdea, type LineaEncaje, type TextoLeido } from './analisis-esquema.ts';

export interface AnalisisLicitacion {
  tipo: 'licitacion';
  /** Presupuesto base de licitación sin IVA, con su cifra. */
  presupuestoBase: CampoCitado;
  /** Plazo de presentación de ofertas, literal (con este nombre lo lee la fase de plazos). */
  plazo: CampoCitado;
  duracion: CampoCitado;
  lotes: CampoCitado;
  solvenciaEconomica: CampoCitado;
  solvenciaTecnica: CampoCitado;
  /** Clasificación empresarial exigida (grupo/subgrupo/categoría); desconocido = no consta o no se exige. */
  clasificacion: CampoCitado;
  /** Puntos (sobre 100) del precio: solo el número. */
  ponderacionPrecio: CampoCitado;
  /** Puntos (sobre 100) de lo que no es precio (juicio de valor y demás): solo el número. */
  ponderacionTecnica: CampoCitado;
  /** "si" = contrato reservado a centros especiales de empleo, empresas de inserción u otra entidad que la organización no es. */
  reservaSocial: CampoCitado<'si' | 'no'>;
  requisitos: CampoCitado[];
  lineas: LineaEncaje[];
  tituloCorto?: string | null;
  ideaProyecto: string | null;
  correcciones: string[];
}

const texto = { type: 'string' };
const campo = (valor: Record<string, unknown> = texto) => ({
  type: 'object', properties: { valor, cita: texto, documento: texto }, required: ['valor', 'cita', 'documento'], additionalProperties: false,
});

const CAMPOS = ['presupuestoBase', 'plazo', 'duracion', 'lotes', 'solvenciaEconomica', 'solvenciaTecnica', 'clasificacion', 'ponderacionPrecio', 'ponderacionTecnica', 'reservaSocial'] as const;

/** JSON Schema de la salida estructurada (sin uniones: "desconocido" es la cadena vacía). Las líneas posibles salen del perfil. */
export function esquemaAnalisisLicitacion(perfil: Perfil): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ...Object.fromEntries(CAMPOS.map((k) => [k, k === 'reservaSocial' ? campo({ type: 'string', enum: ['si', 'no', ''] }) : campo()])),
      requisitos: { type: 'array', items: campo() },
      lineas: {
        type: 'array',
        items: {
          type: 'object',
          properties: { linea: { type: 'string', enum: perfil.lineas.map((l) => l.nombre) }, motivo: texto, cita: texto, documento: texto },
          required: ['linea', 'motivo', 'cita', 'documento'], additionalProperties: false,
        },
      },
      ideaProyecto: texto,
      tituloCorto: texto,
    },
    required: [...CAMPOS, 'requisitos', 'lineas', 'ideaProyecto', 'tituloCorto'],
    additionalProperties: false,
  };
}

type Bruto = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Convierte la respuesta del LLM en un `AnalisisLicitacion` aplicando la regla de citas contra los textos que se le enviaron. No lanza. */
export function aplicarCitasLicitacion(bruto: unknown, textos: TextoLeido[], perfil: Perfil): AnalisisLicitacion {
  const r = (bruto && typeof bruto === 'object' ? bruto : {}) as Bruto;
  const normalizados = textos.map((t) => ({ titulo: t.titulo, n: normalizarParaCita(t.texto) }));
  const correcciones: string[] = [];
  const localizar = (cita: string, documento: string | null): string | null => {
    const orden = [...normalizados].sort((a, b) => Number(b.titulo === documento) - Number(a.titulo === documento));
    return orden.find((t) => citaEnTexto(cita, t.n))?.titulo ?? null;
  };
  const crear = <T extends string>(nombre: string, v: unknown, validos?: readonly T[], numerico = false): CampoCitado<T> => {
    const o = (v && typeof v === 'object' ? v : {}) as Bruto;
    const valor = str(o.valor);
    const cita = str(o.cita);
    const desconocido = (motivo: string): CampoCitado<T> => {
      if (valor) correcciones.push(`${nombre}: ${motivo}; se descarta el valor "${valor}"`);
      return { valor: null, cita: null, documento: null, motivo };
    };
    if (!valor) return { valor: null, cita: null, documento: null, motivo: 'No consta en los textos' };
    if (validos && !validos.includes(valor as T)) return desconocido('valor no válido');
    if (!cita) return desconocido('sin cita literal');
    const documento = localizar(cita, str(o.documento));
    if (!documento) return desconocido('la cita no aparece en los textos leídos');
    if (numerico && !valorEnCita(valor, cita)) return desconocido('el valor no está en la cita');
    return { valor: valor as T, cita, documento };
  };
  const nombresLineas = new Set(perfil.lineas.map((l) => l.nombre));
  const lineas: LineaEncaje[] = [];
  for (const l of Array.isArray(r.lineas) ? r.lineas : []) {
    const o = (l && typeof l === 'object' ? l : {}) as Bruto;
    const linea = str(o.linea);
    if (!linea || !nombresLineas.has(linea)) { if (linea) correcciones.push(`lineas: "${linea}" no es una línea del perfil`); continue; }
    if (lineas.some((x) => x.linea === linea)) continue;
    const cita = str(o.cita);
    const documento = cita ? localizar(cita, str(o.documento)) : null;
    if (cita && !documento) correcciones.push(`lineas: la cita de "${linea}" no aparece en los textos; se quita la cita`);
    lineas.push({ linea, motivo: str(o.motivo) ?? '', cita: documento ? cita : null, documento });
  }
  const requisitos = (Array.isArray(r.requisitos) ? r.requisitos : []).map((q, i) => crear(`requisitos[${i}]`, q)).filter((q) => q.valor !== null);
  return {
    tipo: 'licitacion',
    presupuestoBase: crear('presupuestoBase', r.presupuestoBase, undefined, true),
    plazo: crear('plazo', r.plazo, undefined, true),
    duracion: crear('duracion', r.duracion),
    lotes: crear('lotes', r.lotes),
    solvenciaEconomica: crear('solvenciaEconomica', r.solvenciaEconomica),
    solvenciaTecnica: crear('solvenciaTecnica', r.solvenciaTecnica),
    clasificacion: crear('clasificacion', r.clasificacion),
    ponderacionPrecio: crear('ponderacionPrecio', r.ponderacionPrecio, undefined, true),
    ponderacionTecnica: crear('ponderacionTecnica', r.ponderacionTecnica, undefined, true),
    reservaSocial: crear('reservaSocial', r.reservaSocial, ['si', 'no'] as const),
    requisitos, lineas,
    tituloCorto: validarTituloCorto(r.tituloCorto),
    ideaProyecto: limpiarIdea(str(r.ideaProyecto), normalizados.map((t) => t.n).join('\n'), correcciones),
    correcciones,
  };
}

/** ¿Es el análisis de una licitación? (el de una convocatoria no lleva `tipo`). */
export const esAnalisisLicitacion = (a: unknown): a is AnalisisLicitacion => (a as { tipo?: string } | null)?.tipo === 'licitacion';
