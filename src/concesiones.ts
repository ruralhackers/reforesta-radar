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

const sinAcentos = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/\p{M}+/gu, '');

/** Minúsculas, sin acentos, solo letras y números separados por un espacio. */
export function normalizar(s: string | null | undefined): string {
  return sinAcentos(s).toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
}

const ANIO = /\b(19|20)\d{2}\b/g;

/** Título sin los años ("… PROYECTOS AMBIENTALES 2025" → "… PROYECTOS AMBIENTALES"), tal cual salvo espacios; sirve para buscar ediciones. */
export function tituloSinAnio(titulo: string): string {
  return titulo.replace(ANIO, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Texto con el que buscar en BDNS las otras ediciones de una convocatoria. La búsqueda por descripción es de frase: un año quitado del
 * medio ("… ESTATAL. ANUALIDAD 2026.") deja un hueco que no encuentra nada, así que se busca el principio del título hasta el primer
 * año ("… ESTATAL. ANUALIDAD"). Si ese principio es demasiado corto (el año va al comienzo) se cae a `tituloSinAnio`, que puede no encontrar nada.
 */
export function textoBusquedaSerie(titulo: string): string {
  const limpiar = (t: string) => t.replace(/[\s.,;:\-–]+$/, '').trim();
  const i = titulo.search(/\b(19|20)\d{2}\b/);
  const prefijo = i > 0 ? limpiar(titulo.slice(0, i)) : '';
  const significativas = (t: string) => normalizar(t).split(' ').filter((w) => w && !PALABRAS_VACIAS.has(w)).length;
  return prefijo && significativas(prefijo) >= MIN_PALABRAS_SERIE ? prefijo : limpiar(tituloSinAnio(titulo));
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

const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'lo', 'y', 'e', 'o', 'u', 'a', 'al', 'en', 'con', 'por', 'para', 'sin', 'un', 'una', 'que', 'se']);
/** Palabras significativas mínimas del título (sin años ni palabras vacías) para fiarse de una serie. */
export const MIN_PALABRAS_SERIE = 4;

/**
 * Clave de serie: título normalizado sin años + órgano. Dos convocatorias con la misma clave son candidatas a ser ediciones de la misma serie
 * (ver `edicionesComparables`). null si el título es demasiado genérico: menos de MIN_PALABRAS_SERIE palabras significativas.
 */
export function claveSerie(titulo: string, organo: OrganoSerie): string | null {
  const t = normalizar(tituloSinAnio(titulo));
  if (t.split(' ').filter((w) => w && !PALABRAS_VACIAS.has(w)).length < MIN_PALABRAS_SERIE) return null;
  return [t, normalizar(organo.nivel1 ?? ''), normalizar(organo.nivel2 ?? ''), normalizar(organo.nivel3 ?? '')].join('|');
}

/**
 * De las ediciones con la misma clave de serie, las que de verdad se pueden enlazar con la convocatoria `propia`: años conocidos,
 * anteriores al suyo, y un solo número de convocatoria por año (si dos convocatorias distintas comparten año y título, no se sabe cuál
 * es "la edición" de ese año y no se enlaza ninguna). Nunca se enlazan dos convocatorias del mismo año.
 */
export function edicionesComparables<T extends { numeroConvocatoria: string; anio: number | null }>(
  ediciones: T[], propia: { numeroConvocatoria: string; anio: number | null },
): T[] {
  if (propia.anio === null) return [];
  const otras = ediciones.filter((e) => e.numeroConvocatoria !== propia.numeroConvocatoria && e.anio !== null && e.anio < propia.anio!);
  const porAnio = new Map<number, number>();
  for (const e of otras) porAnio.set(e.anio!, (porAnio.get(e.anio!) ?? 0) + 1);
  return otras.filter((e) => porAnio.get(e.anio!) === 1);
}

/** Año de una edición: el del título; si no lleva, el de la fecha de referencia (YYYY-MM-DD). */
export function anioEdicion(titulo: string, fecha: string | null): number | null {
  return anioDelTitulo(titulo) ?? (fecha ? Number(fecha.slice(0, 4)) : null);
}
