// Reglas deterministas de criba. Puras: solo miran la convocatoria y el perfil.
// Un campo desconocido (null) nunca descarta: los metadatos de las fuentes no son fiables.
import type { Convocatoria, Descarte, Perfil } from './types.ts';

export function normalizar(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

type Regla = (c: Convocatoria, p: Perfil) => Descarte | null;

const nominativa: Regla = (c) => {
  if (/nominativ/i.test(c.titulo)) return { regla: 'nominativa', motivo: 'Subvención nominativa (ya adjudicada a nombre de alguien)' };
  if (c.tipo && /concesi[oó]n directa/i.test(c.tipo)) return { regla: 'nominativa', motivo: `Concesión directa: ${c.tipo}` };
  return null;
};

type Ambito = 'dentro' | 'otra_comunidad' | 'fuera';

function clasificarAmbito(c: Convocatoria, p: Perfil): Ambito {
  const { nivel1, nivel2 } = c.organo;
  const n1 = normalizar(nivel1);
  // Programas de la UE (fuente Funding & Tenders): sin límite territorial; si exigen entidades de ciertos países lo decide el análisis.
  if (n1 === 'UE') return 'dentro';
  if (p.ambito.nivelesSiempre.some((n) => normalizar(n) === n1)) return 'dentro';
  if (n1 === 'AUTONOMICA' && nivel2 && p.ambito.comunidades.some((x) => normalizar(x) === normalizar(nivel2))) return 'dentro';
  if (c.regiones.some((r) => p.ambito.regiones.includes(r))) return 'dentro';
  if (n1 === 'AUTONOMICA' && nivel2 && p.ambito.otrasComunidadesSiNoExigenSede) return 'otra_comunidad';
  return 'fuera';
}

const ambito: Regla = (c, p) => {
  if (clasificarAmbito(c, p) !== 'fuera') return null;
  const { nivel1, nivel2 } = c.organo;
  return { regla: 'ambito', motivo: `Ámbito fuera del perfil: ${[nivel1, nivel2].filter(Boolean).join(' · ')}` };
};

/**
 * Condición que deja una convocatoria en juego solo a medias: las autonómicas de otras comunidades no se descartan
 * por regla, pero la criba LLM debe comprobar que no exigen sede o actividad allí. null = sin condición.
 */
export function condicionAmbito(c: Convocatoria, p: Perfil): string | null {
  if (clasificarAmbito(c, p) !== 'otra_comunidad') return null;
  return `Otra comunidad (${c.organo.nivel2}): solo encaja si no exige sede o actividad en esa comunidad`;
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
