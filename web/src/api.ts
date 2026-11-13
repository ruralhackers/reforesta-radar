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

export interface ConvocatoriaSemana {
  id: string;
  fuente: string;
  titulo: string;
  organo: string;
  fechaPublicacion: string;
  url: string;
  plazo: Plazo | null;
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
  convocatorias: ConvocatoriaSemana[];
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
  criba: { descarta: boolean; motivo: string | null; modelo?: string } | null;
  analisis: {
    descarta: boolean;
    motivo: string | null;
    modelo: string;
    campos: CamposAnalisis;
    documentos: { titulo: string; caracteres: number }[];
    documentosConError: string[];
  } | null;
  enlaces: { tipo: 'ficha' | 'bases' | 'extracto' | 'sede' | 'documento'; titulo: string; url: string }[];
}

export async function leerFicha(id: string): Promise<Ficha> {
  const res = await fetch(`/api/convocatorias/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new Error('No existe esa convocatoria');
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return res.json() as Promise<Ficha>;
}

export const rutaFicha = (id: string) => `/convocatoria/${encodeURIComponent(id)}`;
