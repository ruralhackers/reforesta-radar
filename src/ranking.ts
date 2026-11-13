// "Esta semana": el ranking por secciones a partir de las candidatas en juego, sus plazos y sus puntuaciones.
// Función pura (la BD se lee fuera). Reglas:
//   · Se listan TODAS las abiertas en juego (nunca se pierde una que encaja): lo que no es ni "cierran pronto" ni
//     "nuevas" (cierre lejano o desconocido, vista hace más de `nuevasDias`) va a "abiertas".
//   · Fuera: las ya cerradas (días hasta el cierre < 0 con el reloj de ahora) y las excluidas por la puntuación.
//   · "cierran pronto": cierre dentro de `cierranProntoDias` días (hoy incluido).
//   · "nuevas": vistas por primera vez en los últimos `nuevasDias` días (hoy incluido) y que no cierran pronto.
//   · Una convocatoria sale en UNA sección: cierran pronto > nuevas > abiertas (lo urgente manda; sin duplicados).
//   · Dentro de cada sección, por puntuación descendente; empate: cierre más próximo, publicación más reciente, id.
//   · Una candidata sin puntuación guardada (aún no hubo pasada) va al final de su sección.
import { diaLocal, sumarDias } from './dates.ts';
import type { FilaRanking } from './db/repo.ts';

export type Seccion = 'cierran_pronto' | 'nuevas' | 'abiertas';

export interface ParametrosRanking {
  nuevasDias: number;
  cierranProntoDias: number;
}

export function construirRanking(filas: FilaRanking[], hoy: string, p: ParametrosRanking): (FilaRanking & { seccion: Seccion })[] {
  const desdeNuevas = sumarDias(hoy, -(p.nuevasDias - 1));
  const resultado: (FilaRanking & { seccion: Seccion })[] = [];
  for (const f of filas) {
    const dias = f.plazo?.diasHastaCierre ?? null;
    if (dias !== null && dias < 0) continue;
    if (f.puntuacion?.excluida) continue;
    if (dias !== null && dias <= p.cierranProntoDias) resultado.push({ ...f, seccion: 'cierran_pronto' });
    else if (diaLocal(new Date(f.primeraVez)) >= desdeNuevas) resultado.push({ ...f, seccion: 'nuevas' });
    else resultado.push({ ...f, seccion: 'abiertas' });
  }
  const orden: Record<Seccion, number> = { cierran_pronto: 0, nuevas: 1, abiertas: 2 };
  return resultado.sort((a, b) =>
    orden[a.seccion] - orden[b.seccion]
    || (b.puntuacion?.total ?? -1) - (a.puntuacion?.total ?? -1)
    || (a.plazo?.fechaCierre ?? '9999').localeCompare(b.plazo?.fechaCierre ?? '9999')
    || b.fechaPublicacion.localeCompare(a.fechaPublicacion)
    || a.id.localeCompare(b.id));
}
