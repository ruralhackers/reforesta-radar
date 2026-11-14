// Piezas que comparten la ficha de una convocatoria y la de una licitación: el panel de datos con su cita, las citas y el «desconocido».
import type { CampoCitado } from './api.ts';

export const fecha = (dia: string) =>
  new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

export const euros = (n: number | null) => (n === null ? null : `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);

export function Desconocido({ motivo }: { motivo?: string }) {
  return <span title={motivo} className="inline-block rounded bg-fondo-suave px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-tinta-suave">desconocido</span>;
}

export function Cita({ cita, documento }: { cita: string; documento: string | null }) {
  return (
    <blockquote className="mt-1 border-l-2 border-marca-borde pl-3 text-sm italic text-tinta-suave [overflow-wrap:anywhere]">
      «{cita}»{documento && <span className="not-italic"> — {documento}</span>}
    </blockquote>
  );
}

/** Un dato del panel fijo: nombre, valor y, debajo, su cita (o "desconocido"). */
export function Dato({ nombre, valor, cita, documento, resaltar }: { nombre: string; valor: string | null; cita?: string | null; documento?: string | null; resaltar?: 'bien' | 'mal' | 'aviso' }) {
  const color = resaltar === 'bien' ? 'text-marca-fuerte' : resaltar === 'mal' ? 'text-peligro' : resaltar === 'aviso' ? 'text-aviso' : 'text-tinta';
  return (
    <div className="py-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-tinta-suave">{nombre}</dt>
      <dd className="mt-0.5">
        {valor === null ? <Desconocido /> : <span className={`text-base font-semibold [overflow-wrap:anywhere] ${color}`}>{valor}</span>}
        {cita && <Cita cita={cita} documento={documento ?? null} />}
      </dd>
    </div>
  );
}

export const citado = (c: CampoCitado | undefined) => ({ valor: c?.valor ?? null, cita: c?.cita ?? null, documento: c?.documento ?? null });

export const TARJETA = 'mb-5 rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea sm:p-5';
