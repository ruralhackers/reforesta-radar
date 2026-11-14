import type { ReactNode } from 'react';

/** Bloque plegado (details) con el estilo de las listas secundarias de «Esta semana» y «Licitaciones». */
export function Plegable({ id, titulo, ayuda, abiertaInicial = false, children }: { id?: string; titulo: string; ayuda?: string; abiertaInicial?: boolean; children: ReactNode }) {
  return (
    <details id={id} open={abiertaInicial} className="group mb-6 rounded-[var(--radio)] bg-superficie ring-1 ring-linea">
      <summary className="cursor-pointer list-none rounded-[var(--radio)] px-4 py-3 text-sm font-medium text-marca-fuerte hover:bg-fondo-suave [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>{titulo}
      </summary>
      <div className="px-4 pb-3">
        {ayuda && <p className="mb-2 text-sm text-tinta-suave">{ayuda}</p>}
        {children}
      </div>
    </details>
  );
}
