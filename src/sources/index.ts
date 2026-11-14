// Fuentes del radar. Una fuente nueva implementa `Fuente` y se añade aquí.
import { bdns } from './bdns.ts';
import { euCascada } from './eu-cascada.ts';
import { euFt } from './eu-ft.ts';
import { fundaciones } from './fundaciones.ts';
import type { Fuente } from './source.ts';

export const FUENTES: Fuente[] = [bdns, euFt, euCascada, fundaciones];

export function fuentePorNombre(nombre: string, fuentes: Fuente[] = FUENTES): Fuente | null {
  return fuentes.find((f) => f.nombre === nombre) ?? null;
}
