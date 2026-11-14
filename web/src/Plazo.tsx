import type { Plazo } from './api.ts';

const fecha = (dia: string) =>
  new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

/** Cuánto falta, en palabras. Una cerrada no lleva días (nunca "faltan -159 días"): la fecha va en `textoCierre`. */
export function restan(dias: number): string {
  if (dias < 0) return 'cerrada';
  if (dias === 0) return 'cierra hoy';
  return dias === 1 ? 'cierra mañana' : `faltan ${dias} días`;
}

function Insignia({ plazo }: { plazo: Plazo }) {
  const calculada = plazo.tipo === 'calculada';
  const texto = plazo.tipo === 'literal' ? 'literal' : plazo.aproximada ? 'calculada · aproximada' : 'calculada';
  return (
    <span
      title={plazo.detalle}
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${calculada ? 'bg-aviso-suave text-aviso' : 'bg-marca-suave text-marca-fuerte'}`}
    >
      {texto}
    </span>
  );
}

/** "Cierra el 5 jun 2026 · faltan 12 días" o, si ya pasó, "Cerrada el 5 jun 2026". */
export function textoCierre(plazo: Plazo): string | null {
  if (!plazo.fechaCierre || plazo.diasHastaCierre === null) return null;
  if (plazo.diasHastaCierre < 0) return `Cerrada el ${fecha(plazo.fechaCierre)}`;
  const calc = plazo.tipo === 'calculada' ? (plazo.aproximada ? ' (calculado, aprox.)' : ' (calculado)') : '';
  return `Cierra el ${fecha(plazo.fechaCierre)}${calc} · ${restan(plazo.diasHastaCierre)}`;
}

/** Cierre en una línea de la lista (junto a fecha y fuente). Sin fecha de cierre no pone nada. */
export function Cierre({ plazo }: { plazo: Plazo | null }) {
  const t = plazo && textoCierre(plazo);
  if (!plazo || !t) return null;
  return (
    <span title={plazo.detalle} className={plazo.diasHastaCierre! >= 0 && plazo.diasHastaCierre! <= 7 ? 'font-medium text-aviso' : ''}>
      {t}
    </span>
  );
}

/** Sección de la ficha: fecha de cierre, si es literal o calculada, cómo se calculó y el texto original. */
export function SeccionPlazo({ plazo }: { plazo: Plazo | null }) {
  return (
    <section className="mb-4 rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
      <h2 className="text-sm font-medium text-tinta-suave">Plazo de solicitud</h2>
      {!plazo || plazo.fechaCierre === null ? (
        <div className="mt-1">
          <span title={plazo?.detalle} className="inline-block rounded bg-linea px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-tinta-suave">
            desconocido
          </span>
          {plazo?.detalle && <p className="mt-2 text-sm text-tinta-suave">{plazo.detalle}.</p>}
        </div>
      ) : (
        <>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">{fecha(plazo.fechaCierre)}</span>
            <Insignia plazo={plazo} />
            {plazo.diasHastaCierre !== null && <span className="text-sm text-tinta-suave">{plazo.diasHastaCierre < 0 ? 'cerrada' : restan(plazo.diasHastaCierre)}</span>}
          </p>
          {plazo.tipo === 'calculada' && <p className="mt-2 text-sm text-tinta-suave">{plazo.detalle}.</p>}
        </>
      )}
      {plazo?.textoOriginal && (
        <blockquote className="mt-2 border-l-2 border-linea-fuerte pl-3 text-sm italic text-tinta-suave [overflow-wrap:anywhere]">
          Texto original: «{plazo.textoOriginal}»
        </blockquote>
      )}
    </section>
  );
}
