import type { FactorPuntuacion, Puntuacion as TPuntuacion } from './api.ts';

/** Insignia con la puntuación 0-100. */
export function Nota({ puntuacion }: { puntuacion: TPuntuacion | null }) {
  if (!puntuacion) return null;
  const t = puntuacion.total;
  const color = t >= 70 ? 'bg-marca text-white' : t >= 50 ? 'bg-marca-suave text-marca-fuerte' : 'bg-linea text-tinta';
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
        <span className="text-xs text-tinta-suave tabular-nums">
          {pct} % · peso {f.peso}
          {!f.conocido && <span className="ml-2 rounded bg-linea px-1.5 py-0.5 uppercase tracking-wide text-tinta-suave">desconocido</span>}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-fondo-suave" role="img" aria-label={`${f.nombre}: ${pct} de 100`}>
        <div className={`h-full rounded-full ${f.conocido ? 'bg-marca' : 'bg-tinta-suave'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-sm text-tinta-suave [overflow-wrap:anywhere]">{f.explicacion}</p>
    </li>
  );
}

/** Desglose de la puntuación, plegado por defecto: cada factor con su barra y su explicación. */
export function SeccionPuntuacion({ puntuacion }: { puntuacion: (TPuntuacion & { excluida?: string | null }) | null }) {
  if (!puntuacion) return null;
  return (
    <details className="group mb-5 rounded-[var(--radio)] bg-superficie ring-1 ring-linea">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--radio)] px-4 py-3 hover:bg-fondo-suave [&::-webkit-details-marker]:hidden">
        <span className="font-semibold"><span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>Puntuación: por qué está donde está</span>
        <Nota puntuacion={puntuacion} />
      </summary>
      <div className="px-4 pb-3">
        {puntuacion.excluida && <p className="mt-1 rounded bg-aviso-suave p-2 text-sm text-aviso">Fuera del ranking: {puntuacion.excluida}.</p>}
        {!puntuacion.analizada && <p className="mt-2 text-sm text-tinta-suave">Aún sin analizar: el encaje, el importe y el esfuerzo cuentan como desconocidos.</p>}
        <ul className="mt-1 divide-y divide-linea">{puntuacion.factores.map((f) => <Barra key={f.id} f={f} />)}</ul>
      </div>
    </details>
  );
}
