import type { EdicionSerie, SerieFicha } from './api.ts';
import { rutaFicha } from './api.ts';

export const euros = (n: number) => `${n.toLocaleString('es-ES', { maximumFractionDigits: 0 })} €`;
export const dia = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const diaCorto = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function Reforesta({ e }: { e: EdicionSerie }) {
  if (e.reforesta === 'gano') return <span className="rounded bg-marca-suave px-2 py-0.5 text-xs font-medium text-marca-fuerte">Ganó{e.importeReforesta !== null ? ` · ${euros(e.importeReforesta)}` : ''}</span>;
  if (e.reforesta === 'no_figura') return <span className="text-xs text-tinta-suave">No figura</span>;
  if (e.reforesta === 'sin_concesiones') return <span className="text-xs text-tinta-suave">BDNS aún no publica concesiones</span>;
  return <span className="text-xs text-tinta-suave">Concesiones aún no consultadas</span>;
}

/** Línea de tiempo de la serie (una fila por edición, cada una enlazada a su ficha) y, debajo, qué se espera de la siguiente. */
export function SeccionSerie({ serie }: { serie: SerieFicha }) {
  if (!serie.esSerie || serie.ediciones.length < 2) return null;
  const p = serie.prediccion;
  const r = serie.resumen;
  return (
    <section className="mb-4 rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea" aria-label="Serie de ediciones">
      <h2 className="mb-1 font-semibold">Ediciones de esta convocatoria</h2>
      <p className="mb-3 text-xs text-tinta-suave">BDNS solo publica a los ganadores: «No figura» no quiere decir que se presentara y la perdiera.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-tinta-suave">
            <tr>
              <th className="py-1 pr-3 font-medium">Año</th><th className="py-1 pr-3 font-medium">Abrió</th><th className="py-1 pr-3 font-medium">Cerró</th>
              <th className="py-1 pr-3 text-right font-medium">Presupuesto</th><th className="py-1 pr-3 text-right font-medium">Ganadores</th>
              <th className="py-1 pr-3 text-right font-medium">Media</th><th className="py-1 font-medium">Reforesta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-fondo-suave">
            {[...serie.ediciones].reverse().map((e) => (
              <tr key={e.numeroConvocatoria} className={e.propia ? 'bg-fondo-suave font-medium' : ''}>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  {e.convocatoriaId && !e.propia
                    ? <a href={rutaFicha(e.convocatoriaId)} className="text-marca-fuerte hover:underline">{e.anio}</a>
                    : e.propia ? <span>{e.anio} <span className="text-xs font-normal text-tinta-suave">(esta)</span></span>
                      : <a href={e.url} target="_blank" rel="noreferrer" className="text-marca-fuerte hover:underline" title="Ficha en BDNS">{e.anio} ↗</a>}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  {dia(e.apertura)}
                  {e.aperturaTipo === 'registro' && <span className="block text-[11px] font-normal text-tinta-suave" title="BDNS no da el inicio de solicitudes: es la fecha en que se registró la convocatoria">registrada</span>}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{dia(e.cierre)}</td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap">{e.presupuesto !== null ? euros(e.presupuesto) : '—'}</td>
                <td className="py-1.5 pr-3 text-right">{e.ganadores ?? '—'}</td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap">{e.importeMedio !== null ? euros(e.importeMedio) : '—'}</td>
                <td className="py-1.5"><Reforesta e={e} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p ? (
        <div className="mt-3 rounded-md bg-marca-suave p-3 text-sm text-marca-fuerte">
          <p>
            <strong>Edición {serie.anioSiguiente}:</strong> {p.texto.charAt(0).toUpperCase() + p.texto.slice(1)}
            {p.duracionDias !== null && <>; el plazo de solicitud suele durar unos {p.duracionDias} días</>}.
          </p>
          <p className="mt-1 text-xs">
            Basado en cuándo abrieron {p.basadaEn.map((b) => `${b.anio} (${diaCorto(b.apertura)})`).join(', ')}.
            {r.ultimoPresupuesto !== null && <> Última dotación: {euros(r.ultimoPresupuesto)}.</>}
            {r.ganadoresTipicos !== null && <> Suele haber unos {r.ganadoresTipicos} ganadores{r.premioMedioTipico !== null && <> de unos {euros(r.premioMedioTipico)} de media</>}.</>}
            {' '}Es un hábito pasado, no una fecha anunciada.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-tinta-suave">Aún no hay dos ediciones pasadas con fecha de apertura conocida: no se predice cuándo abrirá la siguiente.</p>
      )}
    </section>
  );
}
