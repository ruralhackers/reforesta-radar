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

const ambito: Regla = (c, p) => {
  const { nivel1, nivel2 } = c.organo;
  const n1 = normalizar(nivel1);
  if (p.ambito.nivelesSiempre.some((n) => normalizar(n) === n1)) return null;
  if (n1 === 'AUTONOMICA' && nivel2 && p.ambito.comunidades.some((x) => normalizar(x) === normalizar(nivel2))) return null;
  if (c.regiones.some((r) => p.ambito.regiones.includes(r))) return null;
  return { regla: 'ambito', motivo: `Ámbito fuera del perfil: ${[nivel1, nivel2].filter(Boolean).join(' · ')}` };
};

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
