// Tipos de dominio compartidos por motor, fuentes, reglas, BD y API.

/** Domicilio social de la entidad (público, p. ej. su aviso legal): sirve para descartar convocatorias que exigen sede o inscripción en otro municipio o distrito. */
export interface Domicilio {
  municipio: string;
  provincia: string;
  comunidad: string;
  /** Distrito, si el municipio los tiene (p. ej. los de Madrid capital). */
  distrito?: string;
}

export interface TerritorioAmbito {
  /** Comunidad autónoma (nivel2 de BDNS, sin importar mayúsculas ni tildes). */
  comunidad: string;
  /** Provincias admitidas; vacía = toda la comunidad. */
  provincias: string[];
}

/** Perfil de la organización a la que sirve el radar. Viene de la semilla y vive en la BD. */
export interface Perfil {
  nombre: string;
  nif: string;
  /** idPersona del beneficiario en BDNS (concesiones). */
  bdnsIdPersona: number | null;
  /** Domicilio social; ausente en perfiles guardados antes de este campo (se completa desde la semilla). */
  domicilio?: Domicilio;
  lineas: { nombre: string; descripcion: string }[];
  ambito: {
    descripcion: string;
    /** Niveles de administración (nivel1 de BDNS) que siempre se admiten, p. ej. "ESTADO". */
    nivelesSiempre: string[];
    /**
     * Territorios donde el proyecto puede ejecutarse (lo que importa es DÓNDE SE HACE, no dónde está la sede): por comunidad autónoma, con la
     * lista de sus provincias admitidas (vacía = toda la comunidad). Estatales y de la UE siempre valen; autonómicas solo de estas comunidades
     * (y, si la comunidad solo está en parte, la criba LLM comprueba que admitan las provincias); locales solo de diputaciones de estas provincias
     * o de órganos con alguna de las `regiones`.
     */
    territorios: TerritorioAmbito[];
    /** Comunidades enteras de `territorios`, sin provincias (derivado; la huella de empresas toma de aquí su zona). */
    comunidades: string[];
    /** Códigos NUTS admitidos (p. ej. "ES30", "ES416"): admiten órganos locales de esas zonas y sirven a la fuente BDNS para pedirlas. */
    regiones: string[];
  };
  /** Importe mínimo que merece el esfuerzo, en euros (null = sin mínimo). */
  importeMinimo: number | null;
  /** Puntuación mínima (0-100) para entrar en "Esta semana" arriba; ausente = UMBRAL_CORTE_POR_DEFECTO (ver src/perfil.ts). */
  umbralEncaje?: number | null;
  /** Finalidades (descripcionFinalidad de BDNS) claramente ajenas a la organización. */
  finalidadesExcluidas: string[];
  /**
   * Licitaciones públicas (fuente PLACSP): lo que la entidad puede ejecutar. Ausente en perfiles guardados antes de este campo: se usan
   * `PRESUPUESTO_MAXIMO_LICITACION` e `INGRESOS_ANUALES_POR_DEFECTO` (src/perfil.ts).
   */
  licitaciones?: {
    /** Presupuesto base de licitación (sin IVA) por encima del cual un contrato es «probablemente fuera de escala». */
    presupuestoMaximo: number | null;
    /** Ingresos anuales por servicios, para juzgar la solvencia económica exigida (volumen anual de negocio). */
    ingresosAnuales: number | null;
  };
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
  tipo?: 'fundacion' | 'agregador' | 'premio';
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

export type ReglaDescarte = 'nominativa' | 'ambito' | 'finalidad' | 'tema' | 'pais';

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
