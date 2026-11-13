// Tipos de dominio compartidos por motor, fuentes, reglas, BD y API.

/** Perfil de la organización a la que sirve el radar. Viene de la semilla y vive en la BD. */
export interface Perfil {
  nombre: string;
  nif: string;
  /** idPersona del beneficiario en BDNS (concesiones). */
  bdnsIdPersona: number | null;
  lineas: { nombre: string; descripcion: string }[];
  ambito: {
    descripcion: string;
    /** Niveles de administración (nivel1 de BDNS) que siempre se admiten, p. ej. "ESTADO". */
    nivelesSiempre: string[];
    /** Comunidades autónomas cuyos órganos se admiten (nivel2 de BDNS). */
    comunidades: string[];
    /** Códigos NUTS de las regiones admitidas (p. ej. "ES30"): admiten órganos locales de esa región. */
    regiones: string[];
    /**
     * Convocatorias autonómicas de otras comunidades: true = no se descartan por regla, pasan a la criba LLM
     * con la condición de que no exijan sede o actividad en esa comunidad; false/ausente = se descartan.
     */
    otrasComunidadesSiNoExigenSede?: boolean;
  };
  /** Importe mínimo que merece el esfuerzo, en euros (null = sin mínimo). */
  importeMinimo: number | null;
  /** Finalidades (descripcionFinalidad de BDNS) claramente ajenas a la organización. */
  finalidadesExcluidas: string[];
}

export interface OrganizacionParecida {
  nif: string;
  nombre: string;
}

export interface Fundacion {
  nombre: string;
  /** Página de convocatorias que se vigila; null = sin página conocida (no se puede vigilar). */
  url: string | null;
  notas: string | null;
  /** Fundación con convocatorias propias o agregador de convocatorias del tercer sector. Por defecto, fundación. */
  tipo?: 'fundacion' | 'agregador';
  /** false = no se vigila (p. ej. la web bloquea clientes automáticos). Por defecto, activa. */
  activa?: boolean;
}

export interface Semilla {
  perfil: Perfil;
  organizacionesParecidas: OrganizacionParecida[];
  fundaciones: Fundacion[];
}

/** Convocatoria normalizada, venga de la fuente que venga. */
export interface Convocatoria {
  /** Id estable: `${fuente}:${fuenteId}`. */
  id: string;
  fuente: string;
  fuenteId: string;
  titulo: string;
  /** Órgano convocante en tres niveles (en BDNS: ESTADO/AUTONOMICA/LOCAL/OTROS · organismo · unidad). */
  organo: { nivel1: string; nivel2: string | null; nivel3: string | null };
  /** YYYY-MM-DD */
  fechaPublicacion: string;
  /** Enlace a la ficha en la fuente original. */
  url: string;
  /** Tipo de convocatoria (concurrencia competitiva, concesión directa…); null si aún no se sabe. */
  tipo: string | null;
  finalidad: string | null;
  /** Códigos de región (NUTS) conocidos. */
  regiones: string[];
  abierto: boolean | null;
  /** Respuesta(s) originales de la fuente, para fases posteriores. */
  datos: unknown;
}

export type ReglaDescarte = 'nominativa' | 'ambito' | 'finalidad' | 'tema';

export interface Descarte {
  regla: ReglaDescarte;
  motivo: string;
}

export interface Cribada {
  convocatoria: Convocatoria;
  descarte: Descarte | null;
}

/** Cribada lista para guardar: si no se descarta, puede seguir en juego con una condición que decidirá la criba LLM. */
export interface CribadaConCondicion extends Cribada {
  /** p. ej. "Otra comunidad (GALICIA): solo si no exige sede o actividad allí". null = sin condición. */
  condicion: string | null;
}

export interface Reloj {
  now(): Date;
}
