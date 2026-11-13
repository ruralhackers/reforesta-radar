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

/** Días de calendario entre dos días (`hasta` - `desde`); negativo si `hasta` es anterior. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
}

/** Día de la semana: 0 = domingo … 6 = sábado. */
export function diaDeLaSemana(dia: string): number {
  return new Date(`${dia}T00:00:00Z`).getUTCDay();
}

/**
 * Suma `n` meses de fecha a fecha: el mismo número de día del mes de vencimiento; si ese mes no tiene ese día
 * (p. ej. 31 de enero + 1 mes), el último día del mes (art. 30.4 de la Ley 39/2015).
 */
export function sumarMeses(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number);
  const indice = y * 12 + (m - 1) + n;
  const anio = Math.floor(indice / 12);
  const mes = (indice % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}

/** Lunes de la semana (ISO) del día dado. */
export function lunesDeLaSemana(dia: string): string {
  return sumarDias(dia, -((diaDeLaSemana(dia) + 6) % 7));
}

/** Semana ISO 8601 del día dado, p. ej. "2026-W47". */
export function semanaIso(dia: string): string {
  const jueves = sumarDias(lunesDeLaSemana(dia), 3);
  const anio = jueves.slice(0, 4);
  return `${anio}-W${String(Math.floor(diasEntre(`${anio}-01-01`, jueves) / 7) + 1).padStart(2, '0')}`;
}
