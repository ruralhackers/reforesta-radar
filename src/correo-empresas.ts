// Sección "Empresas nuevas de la semana" del correo del lunes (punto de extensión `seccionesExtra` de src/resumen.ts).
// Solo empresas vistas por primera vez en los últimos 7 días (hoy incluido, como "Esta semana"); una ya vista antes, aunque una DIA nueva la
// vuelva a señalar, no repite. Como máximo 5, por prioridad (DIA primero, luego registro con compensación); las de baja confianza no entran.
// Con motivo y enlace a la fuente; nada de personas de contacto.
import type { DatabaseSync } from 'node:sqlite';
import { acortar, type SeccionCorreo } from './correo.ts';
import { sumarDias } from './dates.ts';
import { empresasNuevasEntre } from './db/empresas.ts';

export const MAX_EMPRESAS_CORREO = 5;

export function seccionEmpresasNuevas({ db, hoy }: { db: DatabaseSync; hoy: string; urlPublica: string }): SeccionCorreo[] {
  const nuevas = empresasNuevasEntre(db, sumarDias(hoy, -6), hoy);
  if (nuevas.length === 0) return [];
  const mostradas = nuevas.slice(0, MAX_EMPRESAS_CORREO);
  return [{
    titulo: 'Empresas nuevas de la semana',
    intro: `Las más claras: obligadas por una declaración de impacto ambiental a restaurar o compensar, o que ya compensan emisiones con proyectos de absorción${nuevas.length > mostradas.length ? ` (${mostradas.length} de ${nuevas.length}; el resto, en la web)` : ''}.`,
    items: mostradas.map((e) => ({
      titulo: acortar(e.nombre, 140),
      url: e.enlace,
      porQue: acortar(e.motivo, 300),
      detalles: e.provincia ? [e.provincia] : [],
    })),
  }];
}
