// Contrato de una fuente de convocatorias. Cada fuente nueva (UE, fundaciones…) implementa `Fuente`
// y se añade a la lista del motor.
import type { DatosPlazo } from '../plazos.ts';
import type { Convocatoria, Cribada, Descarte, Perfil } from '../types.ts';

export interface ContextoFuente {
  fetch: typeof globalThis.fetch;
  ahora: Date;
  perfil: Perfil;
  /** Días hacia atrás (incluido hoy) que se revisan. */
  diasAtras: number;
  /** Reglas deterministas; la fuente las aplica para no pedir detalle de lo que ya está descartado. */
  cribar: (c: Convocatoria) => Descarte | null;
}

export interface ResultadoFuente {
  cribadas: Cribada[];
  /** Fallos parciales (p. ej. un detalle que no se pudo leer). Un fallo total se lanza como excepción. */
  errores: string[];
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
