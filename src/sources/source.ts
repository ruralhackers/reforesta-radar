// Contrato de una fuente de convocatorias. Cada fuente nueva (UE, fundaciones…) implementa `Fuente`
// y se añade a la lista del motor.
import type { DatabaseSync } from 'node:sqlite';
import type { Llm } from '../llm/llm.ts';
import type { DatosPlazo } from '../plazos.ts';
import type { RegistroFase } from '../db/repo.ts';
import type { Convocatoria, Cribada, Descarte, Perfil } from '../types.ts';

export interface ContextoFuente {
  fetch: typeof globalThis.fetch;
  ahora: Date;
  perfil: Perfil;
  /** Espera entre peticiones (los tests la inyectan para no esperar de verdad). */
  dormir?: (ms: number) => Promise<void>;
  /** BD, LLM y modelo de la criba (Haiku): solo las fuentes que vigilan páginas (fundaciones) los usan. */
  db?: DatabaseSync;
  llm?: Llm | null;
  modeloLlm?: string;
  /** DNS para la descarga segura de páginas (solo tests; por defecto el del sistema con el fetch real). */
  resolver?: ((host: string) => Promise<string[]>) | null;
  /** Días hacia atrás (incluido hoy) que se revisan. */
  diasAtras: number;
  /** Reglas deterministas; la fuente las aplica para no pedir detalle de lo que ya está descartado. */
  cribar: (c: Convocatoria) => Descarte | null;
}

export interface ResultadoFuente {
  cribadas: Cribada[];
  /** Fallos parciales (p. ej. un detalle que no se pudo leer). Un fallo total se lanza como excepción. */
  errores: string[];
  /** Avisos que no son fallos (p. ej. sin LLM no se puede extraer): van al registro, no marcan la ejecución con errores. */
  avisos?: string[];
  /** Estado propio de la fuente (clave → valor) que el motor guarda en la MISMA transacción que lo recogido: si esta falla, no avanza (p. ej. la cobertura del feed de licitaciones). */
  estado?: { clave: string; valor: string }[];
  /** Registro de la llamada LLM propia de la fuente (extracción), para el coste de la ejecución. */
  fase?: RegistroFase | null;
}

/** Un texto que las fases LLM pueden leer: ya disponible (`texto`) o por descargar (`url`, PDF o HTML). */
export interface DocumentoFuente {
  /** Nombre con el que el LLM lo cita y la ficha lo muestra, p. ej. "Extracto BOE-B-2026-26402". */
  titulo: string;
  url: string | null;
  /** Texto ya disponible sin descargar (extracto, ficha de metadatos…). */
  texto?: string;
}

export interface Enlace {
  tipo: 'ficha' | 'bases' | 'extracto' | 'sede' | 'documento';
  titulo: string;
  url: string;
}

export interface Fuente {
  nombre: string;
  recoger(ctx: ContextoFuente): Promise<ResultadoFuente>;
  /**
   * Textos de una convocatoria guardada para la criba y el análisis. Nunca incluye metadatos poco fiables
   * (p. ej. tipos de beneficiario de BDNS): la elegibilidad se decide por el texto.
   */
  documentos?(c: Convocatoria): DocumentoFuente[];
  /** Enlaces para la ficha: bases, extracto, sede electrónica… */
  enlaces?(c: Convocatoria): Enlace[];
  /** Lo que la fuente sabe del plazo de solicitud (fecha explícita, textos, publicaciones del extracto) para calcular el cierre. */
  datosPlazo?(c: Convocatoria): DatosPlazo;
}
