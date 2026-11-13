// Tipos de las respuestas de /api (espejo de src/api/app.ts).
/** Plazo de solicitud: fecha literal (la da la fuente), calculada (en días hábiles desde la publicación) o desconocida. */
export interface Plazo {
  fechaCierre: string | null;
  tipo: 'literal' | 'calculada' | 'desconocida';
  textoOriginal: string | null;
  fechaBase: string | null;
  baseOrigen: 'extracto' | 'registro' | null;
  /** La base es solo el registro en la fuente: el cierre real puede ser posterior. */
  aproximada: boolean;
  detalle: string;
  /** Días que faltan (negativo = cerrada); null si desconocida. */
  diasHastaCierre: number | null;
}

/** Un factor de la puntuación: subpuntuación 0-1 y su explicación en una línea. */
export interface FactorPuntuacion {
  id: 'encaje' | 'importe' | 'cierre' | 'esfuerzo' | 'probabilidad';
  nombre: string;
  peso: number;
  subpuntuacion: number;
  /** false = faltaba el dato (cuenta como desconocido, no como bueno). */
  conocido: boolean;
  explicacion: string;
}

export interface Puntuacion {
  /** 0-100. */
  total: number;
  analizada: boolean;
  factores: FactorPuntuacion[];
  calculadoEn: string;
}

/** Parecidas activas detrás de una convocatoria: la descubrió una de ellas y/o figuran entre sus ganadores previos. */
export interface InfoParecidas {
  descubierta: boolean;
  organizaciones: { nif: string; nombre: string; anios: number[] }[];
}

export interface ConvocatoriaSemana {
  id: string;
  fuente: string;
  titulo: string;
  organo: string;
  fechaPublicacion: string;
  url: string;
  plazo: Plazo | null;
  /** Sale en una sola: cierran_pronto > nuevas > abiertas. */
  seccion: 'cierran_pronto' | 'nuevas' | 'abiertas';
  /** null = todavía no hubo ninguna pasada tras guardarla. */
  puntuacion: Puntuacion | null;
  /** null = ninguna parecida activa tiene que ver con ella. */
  parecidas: InfoParecidas | null;
}

export interface Ejecucion {
  id: number;
  inicio: string;
  fin: string | null;
  estado: string;
  fuentes: { fuente: string; recibidas: number; candidatas: number; descartadas: number; errores: string[] }[];
}

export interface Semana {
  desde: string;
  hasta: string;
  nuevasDias: number;
  cierranProntoDias: number;
  /** Ya en orden: cierran pronto, nuevas y abiertas; cada sección por puntuación. */
  convocatorias: ConvocatoriaSemana[];
  /** Ids de "las ganan organizaciones como vosotros", por puntuación. Lista paralela: repite convocatorias de las secciones de arriba. */
  lasGananParecidas: string[];
  ultimaEjecucion: Ejecucion | null;
}

export async function leerSemana(): Promise<Semana> {
  const res = await fetch('/api/semana');
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return res.json() as Promise<Semana>;
}

// --- Ficha de convocatoria (GET /api/convocatorias/:id) ---

/** Campo extraído con su cita. `valor === null` ⇒ desconocido. */
export interface CampoCitado {
  valor: string | null;
  cita: string | null;
  documento: string | null;
  motivo?: string;
}

export interface CamposAnalisis {
  elegibilidadEsfl: CampoCitado;
  importeMaximoProyecto: CampoCitado;
  importeTotal: CampoCitado;
  plazo: CampoCitado;
  cofinanciacion: CampoCitado;
  requisitos: CampoCitado[];
  lineas: { linea: string; motivo: string; cita: string | null; documento: string | null }[];
  ideaProyecto: string | null;
  correcciones: string[];
}

export interface GanadorPrevio {
  nombre: string;
  nif: string | null;
  importe: number | null;
  fechaConcesion: string | null;
  esReforesta: boolean;
  esParecida: boolean;
}

export interface EdicionPrevia {
  numeroConvocatoria: string;
  anio: number | null;
  titulo: string;
  url: string;
  /** Es esta misma convocatoria, ya resuelta. */
  propia: boolean;
  ganadores: GanadorPrevio[];
  importeTotal: number;
  /** BDNS solo publica ganadores: no_figura no significa que la perdiera. */
  reforesta: 'gano' | 'no_figura' | 'sin_datos';
  importeReforesta: number | null;
}

export interface GanadoresPrevios {
  esSerie: boolean;
  ediciones: EdicionPrevia[];
  reforestaGano: { numeroConvocatoria: string; anio: number | null; importe: number | null }[];
  parecidas: { nif: string; nombre: string; anios: number[] }[];
}

export interface Ficha {
  id: string;
  fuente: string;
  titulo: string;
  organo: string;
  fechaPublicacion: string;
  url: string;
  tipo: string | null;
  finalidad: string | null;
  abierto: boolean | null;
  descarte: { regla: string; motivo: string | null } | null;
  condicion: string | null;
  enJuego: boolean;
  plazo: Plazo | null;
  /** null = aún sin puntuar; `excluida` = motivo por el que no entra en el ranking. */
  puntuacion: (Puntuacion & { excluida: string | null }) | null;
  criba: { descarta: boolean; motivo: string | null; modelo?: string } | null;
  analisis: {
    descarta: boolean;
    motivo: string | null;
    modelo: string;
    campos: CamposAnalisis;
    documentos: { titulo: string; caracteres: number }[];
    documentosConError: string[];
  } | null;
  ganadoresPrevios: GanadoresPrevios;
  parecidas: InfoParecidas | null;
  enlaces: { tipo: 'ficha' | 'bases' | 'extracto' | 'sede' | 'documento'; titulo: string; url: string }[];
}

export async function leerFicha(id: string): Promise<Ficha> {
  const res = await fetch(`/api/convocatorias/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new Error('No existe esa convocatoria');
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return res.json() as Promise<Ficha>;
}

export const rutaFicha = (id: string) => `/convocatoria/${encodeURIComponent(id)}`;

// --- Organizaciones parecidas (GET/PATCH/POST/DELETE /api/parecidas) ---

export interface Parecida {
  nif: string;
  nombre: string;
  /** calculada = sale de los datos de BDNS; semilla = de partida; manual = añadida a mano. */
  origen: 'calculada' | 'semilla' | 'manual' | 'derivada';
  activa: boolean;
  /** Convocatorias que Reforesta ganó y esta organización también. */
  coincidencias: number;
  /** Convocatorias candidatas que ha aportado esta organización. */
  convocatorias: number;
}

async function pedirParecidas(ruta: string, metodo: string, cuerpo?: object): Promise<unknown> {
  const res = await fetch(`/api/parecidas${ruta}`, {
    method: metodo,
    ...(cuerpo ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) } : {}),
  });
  const datos = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(datos.error ?? `Error ${res.status}`);
  return datos;
}

export async function leerParecidas(): Promise<Parecida[]> {
  return ((await pedirParecidas('', 'GET')) as { parecidas: Parecida[] }).parecidas;
}
export const activarParecida = (nif: string, activa: boolean) => pedirParecidas(`/${encodeURIComponent(nif)}`, 'PATCH', { activa });
export const anadirParecida = (nif: string, nombre: string) => pedirParecidas('', 'POST', { nif, nombre: nombre || undefined });
export const quitarParecida = (nif: string) => pedirParecidas(`/${encodeURIComponent(nif)}`, 'DELETE');

// --- Perfil (GET/PUT /api/perfil) ---
export interface PerfilWeb {
  nombre: string;
  nif: string;
  bdnsIdPersona: number | null;
  lineas: { nombre: string; descripcion: string }[];
  ambito: { descripcion: string; nivelesSiempre: string[]; comunidades: string[]; regiones: string[]; otrasComunidadesSiNoExigenSede?: boolean };
  importeMinimo: number | null;
}

export async function leerPerfil(): Promise<PerfilWeb> {
  const res = await fetch('/api/perfil');
  const datos = await res.json().catch(() => ({})) as PerfilWeb & { error?: string };
  if (!res.ok) throw new Error(datos.error ?? `Error ${res.status}`);
  return datos;
}

export async function guardarPerfil(p: Pick<PerfilWeb, 'lineas' | 'ambito' | 'importeMinimo'>): Promise<PerfilWeb> {
  const res = await fetch('/api/perfil', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  const datos = await res.json().catch(() => ({})) as PerfilWeb & { error?: string };
  if (!res.ok) throw new Error(datos.error ?? `Error ${res.status}`);
  return datos;
}
