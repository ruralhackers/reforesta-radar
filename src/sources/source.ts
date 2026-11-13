// Contrato de una fuente de convocatorias. Cada fuente nueva (UE, fundaciones…) implementa `Fuente`
// y se añade a la lista del motor.
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

export interface Fuente {
  nombre: string;
  recoger(ctx: ContextoFuente): Promise<ResultadoFuente>;
}
