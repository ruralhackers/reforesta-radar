import type { EdicionPrevia, GanadoresPrevios } from './api.ts';

const euros = (n: number | null) =>
  n === null ? '—' : `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

function Marca({ e }: { e: EdicionPrevia }) {
  if (e.reforesta === 'gano') return <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">Reforesta la ganó: {euros(e.importeReforesta)}</span>;
  if (e.reforesta === 'no_figura') return <span className="text-xs text-stone-500">Reforesta no figura entre los ganadores</span>;
  return <span className="text-xs text-stone-500">Sin concesiones publicadas todavía</span>;
}

export function SeccionGanadores({ ganadores }: { ganadores: GanadoresPrevios }) {
  const { ediciones, reforestaGano } = ganadores;
  if (ediciones.length === 0) {
    return (
      <section className="mb-4 rounded-lg bg-white p-4 text-sm text-stone-600 shadow-sm ring-1 ring-stone-200">
        <h2 className="mb-1 font-semibold text-stone-800">Quién la ganó antes</h2>
        Sin ganadores previos conocidos (BDNS solo publica concesiones desde 2022).
      </section>
    );
  }
  return (
    <section className="mb-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
      <h2 className="mb-1 font-semibold">Quién la ganó antes</h2>
      {reforestaGano.length > 0 && (
        <p className="mb-2 rounded-md bg-emerald-50 p-2 text-sm text-emerald-900">
          Reforesta ganó {reforestaGano.length === 1 ? 'la edición' : 'las ediciones'}{' '}
          {reforestaGano.map((g) => `${g.anio ?? g.numeroConvocatoria} (${euros(g.importe)})`).join(', ')}.
        </p>
      )}
      <p className="mb-3 text-xs text-stone-500">BDNS solo publica a los ganadores: «no figura» no quiere decir que se presentara y la perdiera.</p>
      <div className="space-y-4">
        {ediciones.map((e) => (
          <div key={e.numeroConvocatoria}>
            <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <a href={e.url} target="_blank" rel="noreferrer" className="font-medium text-emerald-800 hover:underline">
                {e.propia ? 'Esta convocatoria' : `Edición ${e.anio ?? e.numeroConvocatoria}`}
              </a>
              <Marca e={e} />
            </div>
            {e.ganadores.length > 0 && (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-stone-500">
                  <tr><th className="py-1 pr-2 font-medium">Año</th><th className="py-1 pr-2 font-medium">Beneficiario</th><th className="py-1 text-right font-medium">Importe</th></tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {e.ganadores.map((g, i) => (
                    <tr key={i} className={g.esReforesta ? 'bg-emerald-50 font-semibold' : ''}>
                      <td className="py-1 pr-2 align-top">{e.anio ?? '—'}</td>
                      <td className="py-1 pr-2 [overflow-wrap:anywhere]">
                        {g.nombre}
                        {g.esParecida && <span className="ml-2 rounded bg-stone-100 px-1.5 text-xs font-normal text-stone-600">parecida</span>}
                      </td>
                      <td className="py-1 text-right align-top whitespace-nowrap">{euros(g.importe)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={2} className="pt-1 text-xs text-stone-500">Total concedido</td><td className="pt-1 text-right text-xs text-stone-500">{euros(e.importeTotal)}</td></tr></tfoot>
              </table>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
