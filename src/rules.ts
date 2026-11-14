// Reglas deterministas de criba. Puras: solo miran la convocatoria y el perfil.
// Un campo desconocido (null) nunca descarta: los metadatos de las fuentes no son fiables.
import type { Convocatoria, Descarte, Perfil } from './types.ts';

export function normalizar(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

type Regla = (c: Convocatoria, p: Perfil) => Descarte | null;

const nominativa: Regla = (c) => {
  if (/nominativ/i.test(c.titulo)) return { regla: 'nominativa', motivo: 'Subvención nominativa (ya adjudicada a nombre de alguien)' };
  if (c.tipo && /concesi[oó]n directa/i.test(c.tipo)) return { regla: 'nominativa', motivo: `Concesión directa: ${c.tipo}` };
  return null;
};

/** Comparación de nombres de territorio: sin tildes, mayúsculas ni signos ("CASTILLA - LA MANCHA" = "Castilla-La Mancha"). */
const clave = (s: string | null | undefined) => normalizar(s).replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * Dónde se ejecuta una licitación (códigos NUTS del lugar de ejecución) frente a las `regiones` NUTS del perfil. Un código dentro de una región admitida (o
 * una región admitida dentro de él, p. ej. ES411 = Ávila) es 'dentro'; un código más amplio que una región admitida (ES41, Castilla y León) o sin concretar (ES,
 * ESZZZ, vacío) es 'parcial' (la criba LLM comprueba dónde se hará); si todos están en otro sitio, 'fuera'. Una licitación de varios lugares vale si alguno está dentro.
 */
export function ubicacionEnAmbito(nuts: string[], p: Pick<Perfil, 'ambito'>): 'dentro' | 'parcial' | 'fuera' {
  const regiones = p.ambito.regiones.map((r) => r.toUpperCase());
  let parcial = nuts.length === 0;
  for (const c0 of nuts) {
    const c = c0.toUpperCase();
    if (c === 'ESZZZ' || c.length < 3) { parcial = true; continue; }
    if (regiones.some((r) => c.startsWith(r))) return 'dentro';
    if (regiones.some((r) => r.startsWith(c))) parcial = true;
  }
  return parcial ? 'parcial' : 'fuera';
}

type Ambito =
  | { tipo: 'dentro' }
  | { tipo: 'parcial'; comunidad: string; provincias: string[] }
  | { tipo: 'fuera'; motivo: string };

const orgLegible = (c: Convocatoria) => [c.organo.nivel1, c.organo.nivel2].filter(Boolean).join(' · ');

/**
 * Lo que importa es DÓNDE SE EJECUTA el proyecto (`perfil.ambito.territorios`), no la sede de la entidad:
 *  - UE, fundaciones y niveles siempre admitidos (ESTADO): dentro (el proyecto puede hacerse en el ámbito).
 *  - Autonómica: solo de comunidades con algún territorio admitido. Si la comunidad está entera: dentro. Si solo algunas provincias: dentro si la
 *    convocatoria declara una región admitida; fuera si solo declara provincias de otro sitio; si no se sabe, "parcial" (la criba LLM lo comprueba).
 *  - Local (y otros): dentro si declara una región admitida o es la diputación de una provincia admitida; si no, fuera.
 */
function clasificarAmbito(c: Convocatoria, p: Perfil): Ambito {
  const { nivel1, nivel2 } = c.organo;
  const n1 = normalizar(nivel1);
  // Programas de la UE (fuente Funding & Tenders): sin límite territorial; si exigen entidades de ciertos países lo decide el análisis.
  if (n1 === 'UE') return { tipo: 'dentro' };
  // Licitaciones (PLACSP): lo que cuenta es el lugar de ejecución del contrato (NUTS), no el nivel del órgano que licita.
  if (c.fuente === 'placsp') {
    return ubicacionEnAmbito(c.regiones, p) === 'fuera'
      ? { tipo: 'fuera', motivo: `Licitación ejecutada fuera del ámbito de actuación (${c.regiones.join(', ')})` }
      : { tipo: 'dentro' };
  }
  // Fundaciones privadas y agregadores: donaciones y ayudas sin límite territorial en el sentido administrativo; lo decide la criba y el análisis por el texto.
  if (n1 === 'FUNDACION') return { tipo: 'dentro' };
  if (p.ambito.nivelesSiempre.some((n) => normalizar(n) === n1)) return { tipo: 'dentro' };
  const territorios = p.ambito.territorios ?? [];
  const regionAdmitida = c.regiones.some((r) => p.ambito.regiones.includes(r));
  if (n1 === 'AUTONOMICA') {
    const t = nivel2 ? territorios.find((x) => clave(x.comunidad) === clave(nivel2)) : undefined;
    if (!t) return { tipo: 'fuera', motivo: `Autonómica de una comunidad sin territorios admitidos: ${nivel2 ?? 'sin comunidad'}` };
    if (t.provincias.length === 0 || regionAdmitida) return { tipo: 'dentro' };
    // Códigos NUTS3 (ES + 3 cifras) = provincias concretas; ninguna es admitida.
    if (c.regiones.length > 0 && c.regiones.every((r) => r.length >= 5)) {
      return { tipo: 'fuera', motivo: `Autonómica de ${nivel2} limitada a provincias fuera del ámbito (${c.regiones.join(', ')})` };
    }
    return { tipo: 'parcial', comunidad: nivel2!, provincias: t.provincias };
  }
  if (regionAdmitida) return { tipo: 'dentro' };
  const dip = n1 === 'LOCAL' && nivel2 ? /^DIPUTACION (?:PROV(?:INCIAL)? )?DE (.+)$/.exec(clave(nivel2)) : null;
  if (dip && territorios.some((t) => t.provincias.some((x) => clave(x) === dip[1].trim()))) return { tipo: 'dentro' };
  return { tipo: 'fuera', motivo: `Fuera del ámbito de actuación: ${orgLegible(c)}` };
}

const ambito: Regla = (c, p) => {
  const a = clasificarAmbito(c, p);
  if (a.tipo !== 'fuera') return null;
  return { regla: 'ambito', motivo: a.motivo };
};

/**
 * Condición que deja una convocatoria en juego solo a medias: las autonómicas de una comunidad que solo está en parte del ámbito no se descartan
 * por regla, pero la criba LLM debe comprobar que admiten proyectos en las provincias admitidas. null = sin condición.
 */
export function condicionAmbito(c: Convocatoria, p: Perfil): string | null {
  // Fundaciones y premios (fuentes 'fundacion' y 'eu_cascada'; eu_ft tiene su propio criterio): no hay órgano territorial que lo decida por regla, así que SIEMPRE llevan la condición del perfil
  // y la criba LLM comprueba dónde puede ejecutarse el proyecto (un premio solo para Latinoamérica o África no es para esta entidad).
  if (c.fuente === 'fundacion' || c.fuente === 'eu_cascada') {
    const donde = (p.ambito.territorios ?? []).map((t) => (t.provincias.length ? `${t.provincias.join(', ')} (${t.comunidad})` : t.comunidad)).join('; ');
    return donde ? `el proyecto debe poder ejecutarse en ${donde}; si la convocatoria o el premio se limita a otro país, continente o región, no encaja${c.fuente === 'eu_cascada' ? ' (una abierta a toda España o a toda la UE sí vale)' : ''}` : null;
  }
  // Licitaciones: el lugar de ejecución es solo parcial (comunidad entera sin provincia, «toda España» o sin concretar): la criba LLM comprueba dónde se hará.
  if (c.fuente === 'placsp') {
    if (ubicacionEnAmbito(c.regiones, p) !== 'parcial') return null;
    const donde = (p.ambito.territorios ?? []).map((t) => (t.provincias.length ? `${t.provincias.join(', ')} (${t.comunidad})` : t.comunidad)).join('; ');
    return donde ? `el contrato debe poder ejecutarse en ${donde}; si el lugar de ejecución es otro (otra provincia o comunidad), no encaja` : null;
  }
  const a = clasificarAmbito(c, p);
  if (a.tipo !== 'parcial') return null;
  return `${a.comunidad}: solo encaja si permite ejecutar el proyecto en ${a.provincias.join(', ')} (no si lo limita a otras provincias de la comunidad)`;
}

/**
 * Pista barata (no descarta nada: decide la criba LLM) para convocatorias locales cuyo órgano es de un municipio o distrito distinto del domicilio social de la entidad:
 * si además exigen sede, domicilio o inscripción allí, no son para ella. null = sin pista (sin domicilio en el perfil, no es local o es el mismo municipio y distrito).
 */
export function pistaDomicilio(c: Convocatoria, p: Perfil): string | null {
  const d = p.domicilio;
  if (!d || normalizar(c.organo.nivel1) !== 'LOCAL') return null;
  const dondeEsta = `${d.municipio}${d.distrito ? `, distrito de ${d.distrito}` : ''}`;
  const distrito = [c.organo.nivel3, c.organo.nivel2, c.titulo].map((t) => /\bdistrito\s+(?:municipal\s+)?(?:de\s+(?:la\s+|los\s+|las\s+)?|del\s+)?([\p{L}][\p{L}\s-]{1,40}?)(?=\s*(?:[,.;:()\n]|\s-\s|\spor\b|\spara\b|\sde\s(?:la|los|las)\b|$))/iu.exec(t ?? '')?.[1]).find(Boolean);
  if (distrito && clave(distrito) !== clave(d.distrito)) return `el órgano o el título mencionan el distrito «${distrito.trim()}»; la entidad está domiciliada en ${dondeEsta}, no en ese distrito`;
  const munic = [c.organo.nivel2, c.organo.nivel3].map((t) => /^(?:AYUNTAMIENTO|AJUNTAMENT|CONCEJO|EXCMO\.? AYUNTAMIENTO)\s+(?:DE\s+)?(?:LA\s+|LOS\s+|LAS\s+|EL\s+)?(.+)$/.exec(clave(t))?.[1]).find(Boolean) ?? (c.organo.nivel2 ? clave(c.organo.nivel2) : null);
  if (munic && !clave(d.municipio).split(' ').every((w) => munic.includes(w)) && !munic.includes(clave(d.municipio))) {
    return `convoca el ayuntamiento de ${c.organo.nivel2 ?? c.organo.nivel3}; la entidad está domiciliada en ${dondeEsta}`;
  }
  return null;
}

const finalidad: Regla = (c, p) => {
  if (!c.finalidad) return null;
  const f = normalizar(c.finalidad);
  if (p.finalidadesExcluidas.some((x) => normalizar(x) === f)) return { regla: 'finalidad', motivo: `Finalidad ajena: ${c.finalidad}` };
  return null;
};

const REGLAS: Regla[] = [nominativa, ambito, finalidad];

/** Devuelve el primer motivo de descarte, o null si la convocatoria sigue en juego. */
export function cribar(c: Convocatoria, p: Perfil): Descarte | null {
  for (const regla of REGLAS) {
    const d = regla(c, p);
    if (d) return d;
  }
  return null;
}
