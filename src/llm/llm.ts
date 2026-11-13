// Contrato del LLM que usa el motor. La implementación real es Anthropic (src/llm/anthropic.ts);
// los tests inyectan una falsa. El motor no sabe de SDKs: pide un JSON con un esquema y recibe datos + uso.

export interface PeticionLlm {
  /** Para qué es (criba, analisis): solo para el registro y los tests. */
  tarea: 'criba' | 'analisis';
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

export interface Llm {
  generar(p: PeticionLlm): Promise<RespuestaLlm>;
}

/** Modelos y topes de las fases LLM (ver config.ts). */
export interface ConfigLlm {
  modeloCriba: string;
  modeloAnalisis: string;
  /** Máximo de llamadas reales a Sonnet (análisis) por ejecución; las de caché no cuentan. */
  maxAnalisis: number;
}

export const CONFIG_LLM_POR_DEFECTO: ConfigLlm = {
  modeloCriba: 'claude-haiku-5-5',
  modeloAnalisis: 'claude-sonnet-5-5',
  maxAnalisis: 20,
};
