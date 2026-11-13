// Piezas puras de las concesiones (ganadores) de BDNS: leer el beneficiario, año de una edición y "serie" de
// convocatorias que se repiten cada año (mismo órgano y mismo título salvo el año).

export interface Beneficiario {
  /** NIF de una entidad; null si BDNS lo anonimiza (personas físicas: "***7841** NOMBRE") o no viene. */
  nif: string | null;
  nombre: string;
  esPersona: boolean;
}

// Letras iniciales de NIF de entidad (personas jurídicas y similares). X/Y/Z, K/L/M y dígitos son personas físicas.
const NIF_ENTIDAD = /^([ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])\s+(.*)$/;

/** "G78456118 GREFA" → entidad; "***7841** JUAN PÉREZ" → persona anonimizada. */
export function leerBeneficiario(bruto: string): Beneficiario {
  const t = bruto.trim().replace(/\s+/g, ' ');
  const m = NIF_ENTIDAD.exec(t);
  if (m) return { nif: m[1], nombre: m[2].trim(), esPersona: false };
  return { nif: null, nombre: t, esPersona: true };
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '');

/** Minúsculas, sin acentos, solo letras y números separados por un espacio. */
export function normalizar(s: string): string {
  return sinAcentos(s).toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
}

const ANIO = /\b(19|20)\d{2}\b/g;

/** Título sin los años ("… PROYECTOS AMBIENTALES 2025" → "… PROYECTOS AMBIENTALES"), tal cual salvo espacios; sirve para buscar ediciones. */
export function tituloSinAnio(titulo: string): string {
  return titulo.replace(ANIO, ' ').replace(/\s+/g, ' ').trim();
}

/** Año que lleva el título (el último), si lo lleva. */
export function anioDelTitulo(titulo: string): number | null {
  const m = titulo.match(ANIO);
  return m ? Number(m[m.length - 1]) : null;
}

export interface OrganoSerie {
  nivel1: string | null;
  nivel2: string | null;
  nivel3: string | null;
}

/**
 * Clave de serie: título normalizado sin años + órgano. Dos convocatorias con la misma clave son ediciones de la misma serie.
 * null si el título (sin años) es demasiado genérico (menos de dos palabras) para fiarse.
 */
export function claveSerie(titulo: string, organo: OrganoSerie): string | null {
  const t = normalizar(tituloSinAnio(titulo));
  if (t.split(' ').filter(Boolean).length < 2) return null;
  return [t, normalizar(organo.nivel1 ?? ''), normalizar(organo.nivel2 ?? ''), normalizar(organo.nivel3 ?? '')].join('|');
}

/** Año de una edición: el del título; si no lleva, el de la fecha de referencia (YYYY-MM-DD). */
export function anioEdicion(titulo: string, fecha: string | null): number | null {
  return anioDelTitulo(titulo) ?? (fecha ? Number(fecha.slice(0, 4)) : null);
}
