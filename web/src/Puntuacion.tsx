import type { FactorPuntuacion, Puntuacion as TPuntuacion } from './api.ts';

/** Insignia con la puntuación 0-100. */
export function Nota({ puntuacion }: { puntuacion: TPuntuacion | null }) {
  if (!puntuacion) return null;
  const t = puntuacion.total;
  const color = t >= 70 ? 'bg-emerald-700 text-white' : t >= 50 ? 'bg-emerald-100 text-emerald-900' : 'bg-stone-200 text-stone-700';
  return (
    <span title="Puntuación de 0 a 100" className={`shrink-0 rounded-full px-2.5 py-1 text-sm font-semibold tabular-nums ${color}`}>
      {t}
    </span>
  );
}

function Barra({ f }: { f: FactorPuntuacion }) {
  const pct = Math.round(f.subpuntuacion * 100);
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{f.nombre}</span>
        <span className="text-xs text-stone-500 tabular-nums">
          {pct} % · peso {f.peso}
          {!f.conocido && <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 uppercase tracking-wide text-stone-600">desconocido</span>}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-stone-100" role="img" aria-label={`${f.nombre}: ${pct} de 100`}>
        <div className={`h-full rounded-full ${f.conocido ? 'bg-emerald-600' : 'bg-stone-400'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-sm text-stone-600 [overflow-wrap:anywhere]">{f.explicacion}</p>
    </li>
  );
}

/** "Por qué está arriba": cada factor con su barra y su explicación. */
export function SeccionPuntuacion({ puntuacion }: { puntuacion: (TPuntuacion & { excluida?: string | null }) | null }) {
  if (!puntuacion) return null;
  return (
    <section className="mb-4 rounded-lg bg-white px-4 py-4 shadow-sm ring-1 ring-stone-200">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Por qué está donde está</h2>
        <Nota puntuacion={puntuacion} />
      </div>
      {puntuacion.excluida && <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900">Fuera del ranking: {puntuacion.excluida}.</p>}
      {!puntuacion.analizada && <p className="mt-2 text-sm text-stone-600">Aún sin analizar: el encaje, el importe y el esfuerzo cuentan como desconocidos.</p>}
      <ul className="mt-1 divide-y divide-stone-100">{puntuacion.factores.map((f) => <Barra key={f.id} f={f} />)}</ul>
    </section>
  );
}
