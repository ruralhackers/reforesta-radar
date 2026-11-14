// Etiqueta de la fuente de una convocatoria (BDNS, UE · Funding & Tenders…), enlazada a la ficha original.
const FUENTES: Record<string, { etiqueta: string; clase: string }> = {
  bdns: { etiqueta: 'BDNS', clase: 'bg-fondo-suave text-tinta ring-linea' },
  fundacion: { etiqueta: 'Fundación', clase: 'bg-aviso-suave text-aviso ring-aviso-borde' },
  eu_cascada: { etiqueta: 'UE · en cascada', clase: 'bg-blue-50 text-blue-800 ring-blue-200' },
  eu_ft: { etiqueta: 'UE · Funding & Tenders', clase: 'bg-blue-50 text-blue-800 ring-blue-200' },
};

export function etiquetaFuente(fuente: string): string {
  return FUENTES[fuente]?.etiqueta ?? fuente.toUpperCase();
}

/** Lo que significa una convocatoria en cascada, para tarjeta y ficha. */
export const TEXTO_CASCADA = 'Convocatoria de un proyecto europeo para terceros: no hace falta consorcio';

export function OrigenFuente({ fuente, url }: { fuente: string; url?: string }) {
  const clase = `rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${FUENTES[fuente]?.clase ?? FUENTES.bdns.clase}`;
  return url
    ? <a href={url} target="_blank" rel="noreferrer" className={`${clase} hover:underline`} title="Abrir en la fuente original">{etiquetaFuente(fuente)}</a>
    : <span className={clase}>{etiquetaFuente(fuente)}</span>;
}
