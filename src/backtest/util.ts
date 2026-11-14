import type { EjemploDecision } from '../db/decisiones.ts';

/** El backtest no aprende de las decisiones del equipo: los prompts van sin ejemplos, igual que en una BD nueva. */
export const ejemplosVacios = (): EjemploDecision[] => [];
