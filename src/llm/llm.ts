// Contrato del LLM que usa el motor. La implementación real es Anthropic (src/llm/anthropic.ts);
// los tests inyectan una falsa. El motor no sabe de SDKs: pide un JSON con un esquema y recibe datos + uso.

export interface PeticionLlm {
  /** Para qué es (criba, analisis, extraccion de fundaciones): solo para el registro y los tests. */
  tarea: 'criba' | 'analisis' | 'extraccion' | 'titulo';
  modelo: string;
  sistema: string;
  mensaje: string;
  /** JSON Schema de la respuesta (salida estructurada). */
  esquema: Record<string, unknown>;
  maxTokens: number;
}

export interface UsoLlm {
  entrada: number;
  salida: number;
  cacheLectura: number;
  cacheEscritura: number;
}

export interface RespuestaLlm {
  /** JSON ya parseado; el motor lo valida antes de usarlo. */
  datos: unknown;
  /** Modelo que respondió de verdad (puede ser el de reserva si el principal rechazó). */
  modelo: string;
  uso: UsoLlm;
}

/**
 * Fallo del LLM con la respuesta ya cobrada (cortada por max_tokens, rechazo, JSON o esquema no válido): lleva el uso para que el coste se
 * cuente en el registro y en el presupuesto de la ejecución, y cuenta como intento fallido de la convocatoria (ver RADAR_MAX_INTENTOS_LLM).
 */
export class ErrorLlm extends Error {
  uso: UsoLlm | null;
  modelo: string | null;
  constructor(mensaje: string, uso: UsoLlm | null = null, modelo: string | null = null) {
    super(mensaje);
    this.uso = uso;
    this.modelo = modelo;
  }
}

export interface Llm {
  generar(p: PeticionLlm): Promise<RespuestaLlm>;
}

/** Modelos y topes de las fases LLM (ver config.ts). */
export interface ConfigLlm {
  modeloCriba: string;
  modeloAnalisis: string;
  /** Máximo de llamadas reales a Sonnet (análisis) por ejecución; las de caché no cuentan. */
  maxAnalisis: number;
  /**
   * Días hacia atrás (por fecha de publicación) en los que se buscan convocatorias aún sin criba o sin análisis,
   * las haya devuelto o no la fuente en esta ejecución.
   */
  diasPendientes: number;
  /**
   * Presupuesto en USD de una ejecución, común a TODAS las fases con LLM (criba, análisis, extracción de fundaciones, DIA, huella). Cuentan
   * también las llamadas fallidas que se cobran (max_tokens, rechazo, JSON no válido). Al alcanzarlo no se hacen más llamadas: lo que falta
   * queda como "sin hacer por el tope" para la siguiente. Las llamadas ya en vuelo terminan (puede pasarse por unas pocas).
   */
  presupuestoUsd: number;
  /** Tope de caracteres de documentos en el prompt de UN análisis; lo que sobra se recorta con una nota. */
  maxCaracteresAnalisis: number;
  /** Intentos fallidos por error del LLM, sumados entre ejecuciones, tras los que una convocatoria deja de reintentarse en esa fase. */
  maxIntentos: number;
}

export const CONFIG_LLM_POR_DEFECTO: ConfigLlm = {
  modeloCriba: 'claude-haiku-5-5',
  modeloAnalisis: 'claude-sonnet-5-5',
  maxAnalisis: 20,
  diasPendientes: 30,
  presupuestoUsd: 1,
  maxCaracteresAnalisis: 300_000,
  maxIntentos: 3,
};
