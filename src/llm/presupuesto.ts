// Presupuesto en USD de una ejecución, común a todas las fases con LLM. El motor envuelve el LLM una vez por ejecución (`conPresupuesto`):
// antes de cada llamada se mira lo gastado y, si se ha llegado al límite, la llamada no se hace (PresupuestoAgotado) y la fase lo cuenta como
// "sin hacer por el tope". Después se suma el coste, también el de las llamadas que fallan tras cobrarse (ErrorLlm con uso).
// Las llamadas ya en vuelo (hay fases en paralelo) terminan: el gasto puede pasarse del límite en unas pocas llamadas.
import { ErrorLlm, type Llm, type UsoLlm } from './llm.ts';
import { coste, PRECIOS } from './precios.ts';

export class PresupuestoAgotado extends Error {
  constructor(limiteUsd: number) {
    super(`Presupuesto de ${limiteUsd.toFixed(2)} USD por ejecución agotado`);
  }
}

export interface Presupuesto {
  limiteUsd: number;
  gastadoUsd: number;
}

/** Coste para el presupuesto: un modelo sin precio en la tabla se cuenta al precio del más caro (mejor pasarse de prudente). */
export function costePresupuesto(modelo: string, uso: UsoLlm): number {
  const c = coste(modelo, uso);
  if (c !== null) return c;
  return Math.max(...Object.keys(PRECIOS).map((m) => coste(m, uso) ?? 0));
}

export function conPresupuesto(llm: Llm, p: Presupuesto): Llm {
  return {
    async generar(peticion) {
      if (p.gastadoUsd >= p.limiteUsd) throw new PresupuestoAgotado(p.limiteUsd);
      try {
        const r = await llm.generar(peticion);
        p.gastadoUsd += costePresupuesto(r.modelo, r.uso);
        return r;
      } catch (e) {
        if (e instanceof ErrorLlm && e.uso) p.gastadoUsd += costePresupuesto(e.modelo ?? peticion.modelo, e.uso);
        throw e;
      }
    },
  };
}
