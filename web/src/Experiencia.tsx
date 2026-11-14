import type { ExperienciaRelacionada, YaFinanciador } from './api.ts';
import { TARJETA } from './ficha-comun.tsx';

/** «Experiencia relacionada» de la ficha: proyectos propios parecidos a la convocatoria, con enlace a la memoria donde constan. No se muestra si no hay. */
export function SeccionExperiencia({ experiencia }: { experiencia: ExperienciaRelacionada[] | undefined }) {
  if (!experiencia || experiencia.length === 0) return null;
  return (
    <section className={TARJETA} aria-label="Experiencia relacionada">
      <h2 className="text-lg font-semibold">Experiencia relacionada</h2>
      <p className="mt-0.5 text-xs text-tinta-suave">Proyectos propios parecidos, según las memorias anuales (por palabras, línea de trabajo y lugar; sin IA).</p>
      <ul className="mt-2 space-y-2">
        {experiencia.map((e) => (
          <li key={`${e.memoriaUrl}|${e.nombre}`}>
            <span className="font-semibold">{e.nombre}</span>
            <span className="text-tinta-suave">{[e.anio ? ` (${e.anio})` : '', e.lugar ? ` · ${e.lugar}` : '', e.linea ? ` · ${e.linea}` : ''].join('')} · </span>
            <a href={e.memoriaUrl} target="_blank" rel="noreferrer" className="text-marca-fuerte hover:underline">Memoria {e.memoriaAnio ?? ''}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const anios = (a: number[]) => a.join(', ');

/** Chip «Ya financiador» (con los años en el título y el texto): la entidad figura en las memorias como financiadora; si solo colaboró, «Ya colaboró». */
export function ChipYaFinanciador({ ya }: { ya: YaFinanciador | null | undefined }) {
  if (!ya) return null;
  const financio = ya.relacion === 'financiacion';
  const texto = `${financio ? 'Ya os financió' : 'Ya colaboró'}${ya.anios.length ? ` en ${anios(ya.anios)}` : ''}`;
  return (
    <span title={`${texto} (según las memorias de la entidad)`} className="ml-1 rounded bg-marca-suave px-1.5 py-0.5 align-middle text-[11px] font-medium text-marca-fuerte ring-1 ring-marca-borde">
      {financio ? 'Ya financiador' : 'Ya colaboró'}{ya.anios.length ? ` · ${anios(ya.anios)}` : ''}
    </span>
  );
}
