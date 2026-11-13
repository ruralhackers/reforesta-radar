// Etiqueta de la fuente de una convocatoria (BDNS, UE · Funding & Tenders…), enlazada a la ficha original.
const FUENTES: Record<string, { etiqueta: string; clase: string }> = {
  bdns: { etiqueta: 'BDNS', clase: 'bg-stone-100 text-stone-700 ring-stone-200' },
  eu_ft: { etiqueta: 'UE · Funding & Tenders', clase: 'bg-blue-50 text-blue-800 ring-blue-200' },
};

export function etiquetaFuente(fuente: string): string {
  return FUENTES[fuente]?.etiqueta ?? fuente.toUpperCase();
}

export function OrigenFuente({ fuente, url }: { fuente: string; url?: string }) {
  const clase = `rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${FUENTES[fuente]?.clase ?? FUENTES.bdns.clase}`;
  return url
    ? <a href={url} target="_blank" rel="noreferrer" className={`${clase} hover:underline`} title="Abrir en la fuente original">{etiquetaFuente(fuente)}</a>
    : <span className={clase}>{etiquetaFuente(fuente)}</span>;
}
