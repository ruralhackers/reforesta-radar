// Fechas de calendario (YYYY-MM-DD) en la zona horaria del radar.

export const ZONA = 'Europe/Madrid';

/** Día de calendario en Europe/Madrid para un instante. */
export function diaLocal(instante: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instante);
}

export function sumarDias(dia: string, n: number): string {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → dd/MM/yyyy (formato de la API de BDNS). */
export function aFechaBdns(dia: string): string {
  const [y, m, d] = dia.split('-');
  return `${d}/${m}/${y}`;
}
