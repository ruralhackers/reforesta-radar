import type { Plazo } from './api.ts';

const fecha = (dia: string) =>
  new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

export function restan(dias: number): string {
  if (dias < 0) return dias === -1 ? 'cerró ayer' : `cerró hace ${-dias} días`;
  if (dias === 0) return 'cierra hoy';
  return dias === 1 ? 'cierra mañana' : `faltan ${dias} días`;
}

function Insignia({ plazo }: { plazo: Plazo }) {
  const calculada = plazo.tipo === 'calculada';
  const texto = plazo.tipo === 'literal' ? 'literal' : plazo.aproximada ? 'calculada · aproximada' : 'calculada';
  return (
    <span
      title={plazo.detalle}
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${calculada ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'}`}
    >
      {texto}
    </span>
  );
}

/** Cierre en una línea de la lista (junto a fecha y fuente). Sin fecha de cierre no pone nada. */
export function Cierre({ plazo }: { plazo: Plazo | null }) {
  if (!plazo || !plazo.fechaCierre || plazo.diasHastaCierre === null) return null;
  return (
    <span title={plazo.detalle} className={plazo.diasHastaCierre >= 0 && plazo.diasHastaCierre <= 7 ? 'font-medium text-amber-800' : ''}>
      Cierre {fecha(plazo.fechaCierre)}{plazo.tipo === 'calculada' ? (plazo.aproximada ? ' (calculado, aprox.)' : ' (calculado)') : ''} · {restan(plazo.diasHastaCierre)}
    </span>
  );
}

/** Sección de la ficha: fecha de cierre, si es literal o calculada, cómo se calculó y el texto original. */
export function SeccionPlazo({ plazo }: { plazo: Plazo | null }) {
  return (
    <section className="mb-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
      <h2 className="text-sm font-medium text-stone-500">Plazo de solicitud</h2>
      {!plazo || plazo.fechaCierre === null ? (
        <div className="mt-1">
          <span title={plazo?.detalle} className="inline-block rounded bg-stone-200 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-stone-600">
            desconocido
          </span>
          {plazo?.detalle && <p className="mt-2 text-sm text-stone-600">{plazo.detalle}.</p>}
        </div>
      ) : (
        <>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">{fecha(plazo.fechaCierre)}</span>
            <Insignia plazo={plazo} />
            {plazo.diasHastaCierre !== null && <span className="text-sm text-stone-600">{restan(plazo.diasHastaCierre)}</span>}
          </p>
          {plazo.tipo === 'calculada' && <p className="mt-2 text-sm text-stone-600">{plazo.detalle}.</p>}
        </>
      )}
      {plazo?.textoOriginal && (
        <blockquote className="mt-2 border-l-2 border-stone-300 pl-3 text-sm italic text-stone-600 [overflow-wrap:anywhere]">
          Texto original: «{plazo.textoOriginal}»
        </blockquote>
      )}
    </section>
  );
}
