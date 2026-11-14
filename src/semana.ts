// "Esta semana" como dato: las candidatas en juego, puntuadas con el reloj de ahora y repartidas en secciones.
// Lo usan la API (/api/semana) y el correo del lunes, para que ambos cuenten lo mismo.
import type { DatabaseSync } from 'node:sqlite';
import { diaLocal } from './dates.ts';
import { filasRanking, leerConvocatoria, leerPerfil } from './db/repo.ts';
import { puntuarConvocatoria } from './fases/puntuacion.ts';
import { infoParecidas } from './parecidas.ts';
import type { ConfigPuntuacion, ProveedorProbabilidad } from './puntuacion.ts';
import { construirRanking } from './ranking.ts';

/** Ranking con secciones y marca de "parecidas". Ya excluye cerradas, excluidas por puntuación y descartadas por el equipo. */
export function calcularRanking(db: DatabaseSync, ahora: Date, cfg: ConfigPuntuacion, probabilidad: ProveedorProbabilidad) {
  const hoy = diaLocal(ahora);
  const perfil = leerPerfil(db);
  const importeMinimo = perfil?.importeMinimo ?? null;
  // La puntuación se calcula aquí, con el reloj de la petición (función pura y barata): total, explicación de cierre y secciones coherentes.
  const conParecidas = filasRanking(db, hoy, (conv, plazo) => puntuarConvocatoria(db, conv, plazo, importeMinimo, cfg, probabilidad, hoy), ahora)
    .map((f) => ({ ...f, parecidas: infoParecidas(db, leerConvocatoria(db, f.id)!.convocatoria, perfil) }));
  return construirRanking(conParecidas, hoy, { nuevasDias: cfg.nuevasDias, cierranProntoDias: cfg.cierranProntoDias });
}
