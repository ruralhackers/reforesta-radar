// "Esta semana": el ranking por secciones a partir de las candidatas en juego, sus plazos y sus puntuaciones.
// Función pura (la BD se lee fuera). Reglas:
//   · Se listan TODAS las abiertas en juego (nunca se pierde una que encaja): lo que no es ni "cierran pronto" ni
//     "nuevas" (cierre lejano o desconocido, vista hace más de `nuevasDias`) va a "abiertas".
//   · Fuera: las ya cerradas (días hasta el cierre < 0 con el reloj de ahora) y las excluidas por la puntuación.
//   · "cierran pronto": cierre dentro de `cierranProntoDias` días (hoy incluido).
//   · "nuevas": vistas por primera vez en los últimos `nuevasDias` días (hoy incluido) y que no cierran pronto.
//   · Una convocatoria sale en UNA sección: cierran pronto > nuevas > abiertas (lo urgente manda; sin duplicados).
//   · Dentro de cada sección, por puntuación descendente; empate: cierre más próximo, publicación más reciente, id.
//   · Las de programas de consorcio (Horizon Europe; `puntuacion.consorcio`) van a su propia sección `consorcio`, al final, por puntuación: no compiten con el resto.
//   · Aparte, `seccionParecidas` saca una lista paralela con las que ganan organizaciones parecidas (puede repetir convocatorias de las anteriores).
//   · Una candidata sin puntuación guardada (aún no hubo pasada) va al final de su sección.
import { diaLocal, sumarDias } from './dates.ts';
import type { FilaRanking } from './db/repo.ts';

export type Seccion = 'cierran_pronto' | 'nuevas' | 'abiertas' | 'consorcio';

export interface ParametrosRanking {
  nuevasDias: number;
  cierranProntoDias: number;
}

export function construirRanking<F extends FilaRanking>(filas: F[], hoy: string, p: ParametrosRanking): (F & { seccion: Seccion })[] {
  const desdeNuevas = sumarDias(hoy, -(p.nuevasDias - 1));
  const resultado: (F & { seccion: Seccion })[] = [];
  for (const f of filas) {
    const dias = f.plazo?.diasHastaCierre ?? null;
    if (dias !== null && dias < 0) continue;
    if (f.puntuacion?.excluida) continue;
    if (f.puntuacion?.consorcio) resultado.push({ ...f, seccion: 'consorcio' });
    else if (dias !== null && dias <= p.cierranProntoDias) resultado.push({ ...f, seccion: 'cierran_pronto' });
    else if (diaLocal(new Date(f.primeraVez)) >= desdeNuevas) resultado.push({ ...f, seccion: 'nuevas' });
    else resultado.push({ ...f, seccion: 'abiertas' });
  }
  const orden: Record<Seccion, number> = { cierran_pronto: 0, nuevas: 1, abiertas: 2, consorcio: 3 };
  return resultado.sort((a, b) => orden[a.seccion] - orden[b.seccion] || porPuntuacion(a, b));
}

const porPuntuacion = (a: FilaRanking, b: FilaRanking) =>
  (b.puntuacion?.total ?? -1) - (a.puntuacion?.total ?? -1)
  || (a.plazo?.fechaCierre ?? '9999').localeCompare(b.plazo?.fechaCierre ?? '9999')
  || b.fechaPublicacion.localeCompare(a.fechaPublicacion)
  || a.id.localeCompare(b.id);

/**
 * Sección "las ganan organizaciones como vosotros": lista PARALELA, no una cuarta sección excluyente. Toma, del ranking ya construido
 * (abiertas, en juego y no excluidas), las convocatorias con `parecidas` no nulo (descubiertas por una parecida o con una parecida activa
 * entre sus ganadores previos) y las ordena por puntuación. Una convocatoria puede salir aquí y además en su sección principal:
 * "cierran pronto" no debe perder una urgente por ser también de parecidas, y el equipo ve de un vistazo qué ganan las suyas.
 */
export function seccionParecidas<F extends FilaRanking & { parecidas: unknown | null; seccion?: Seccion }>(ranking: F[]): F[] {
  return ranking.filter((f) => f.parecidas !== null && f.seccion !== 'consorcio').sort(porPuntuacion);
}
