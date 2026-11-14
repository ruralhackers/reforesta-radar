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

// --- Decisiones del equipo y notas (lecturas /api/equipo/*, escrituras /api/decisiones/*) ---
export interface DecisionEquipo {
  convocatoriaId: string;
  decision: 'nos_interesa' | 'descartada';
  motivo: string | null;
  detalle: string | null;
  decididaEn: string;
}
export interface NotaEquipo { id: number; texto: string; autor: string | null; creadaEn: string }
export interface NosInteresa {
  id: string;
  titulo: string;
  organo: string;
  url: string;
  fechaCierre: string | null;
  /** Negativo = cerrada; null = plazo desconocido. */
  diasHastaCierre: number | null;
}

async function pedir<T>(ruta: string, metodo = 'GET', cuerpo?: object): Promise<T> {
  const res = await fetch(ruta, { method: metodo, ...(cuerpo ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) } : {}) });
  const datos = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(datos.error ?? `Error ${res.status}`);
  return datos;
}

export const leerMotivos = async () => (await pedir<{ motivos: string[] }>('/api/equipo/motivos')).motivos;
export const leerDecisiones = async () => (await pedir<{ decisiones: DecisionEquipo[] }>('/api/equipo/decisiones')).decisiones;
export const leerNosInteresa = async () => (await pedir<{ convocatorias: NosInteresa[] }>('/api/equipo/nos-interesa')).convocatorias;
export const leerEquipoFicha = (id: string) => pedir<{ decision: DecisionEquipo | null; notas: NotaEquipo[] }>(`/api/equipo/convocatorias/${encodeURIComponent(id)}`);
export const decidirConvocatoria = (id: string, cuerpo: { decision: 'nos_interesa' } | { decision: 'descartada'; motivo: string; detalle?: string }) =>
  pedir<DecisionEquipo>(`/api/decisiones/${encodeURIComponent(id)}`, 'PUT', cuerpo);
export const deshacerDecision = (id: string) => pedir<object>(`/api/decisiones/${encodeURIComponent(id)}`, 'DELETE');
export const anadirNota = (id: string, texto: string, autor: string) => pedir<NotaEquipo>(`/api/decisiones/${encodeURIComponent(id)}/notas`, 'POST', { texto, autor: autor || undefined });
export const borrarNota = (id: string, notaId: number) => pedir<object>(`/api/decisiones/${encodeURIComponent(id)}/notas/${notaId}`, 'DELETE');

// --- Sesión del equipo (GET/POST/DELETE /api/sesion): solo hay acceso de equipo cuando el servidor tiene TEAM_PASSWORD ---
export interface EstadoSesion { modoPrivado: boolean; autenticado: boolean }
export const leerSesion = () => pedir<EstadoSesion>('/api/sesion');
export const entrarEquipo = (password: string) => pedir<EstadoSesion>('/api/sesion', 'POST', { password });
export const salirEquipo = () => pedir<EstadoSesion>('/api/sesion', 'DELETE');

// --- Fundaciones y agregadores vigilados (GET público; el resto, del equipo) ---
export interface FuenteVigilada {
  id: number;
  nombre: string;
  url: string | null;
  tipo: 'fundacion' | 'agregador';
  activa: boolean;
  notas: string | null;
  /** Cuándo cambió por última vez el texto de la página (null = aún no se ha leído). */
  ultimoCambio: string | null;
  ultimaRevision: string | null;
  /** Error de la última revisión (null = fue bien). */
  ultimoError: string | null;
}

export const leerFundaciones = async () => (await pedir<{ fundaciones: FuenteVigilada[] }>('/api/fundaciones')).fundaciones;
export const anadirFundacion = (f: { nombre: string; url: string; tipo: 'fundacion' | 'agregador' }) => pedir<FuenteVigilada>('/api/fundaciones', 'POST', f);
export const activarFundacion = (id: number, activa: boolean) => pedir<object>(`/api/fundaciones/${id}`, 'PATCH', { activa });
export const quitarFundacion = (id: number) => pedir<object>(`/api/fundaciones/${id}`, 'DELETE');

// --- Empresas (DIA del BOE con medidas de restauración): GET público sin nota; la nota solo en la lectura del equipo; PATCH del equipo ---
export type EstadoEmpresa = 'pendiente' | 'contactada' | 'descartada';
export interface SenalEmpresa {
  /** De dónde viene la señal: una DIA del BOE o el registro de huella de carbono del MITECO. */
  tipo: 'dia_boe' | 'huella_carbono';
  boeId: string;
  titulo: string;
  proyecto: string | null;
  provincia: string | null;
  motivo: string;
  medidas: { tipo: string; cita: string }[];
  enlace: string;
  fechaPublicacion: string;
}
export interface Empresa {
  id: number;
  nombre: string;
  cif: string | null;
  origen: string;
  motivo: string;
  cita: string;
  enlace: string;
  provincia: string | null;
  paginaRsc: string | null;
  /** 3 = DIA del BOE, 2 = registro con compensación, 1 = registro solo por zona y sector (baja confianza). */
  prioridad: number;
  primeraVezVista: string;
  /** Ausente en la lectura pública en modo privado (es trabajo del equipo). */
  estado?: EstadoEmpresa;
  /** Solo si se lee como equipo. */
  nota?: string | null;
  senales: SenalEmpresa[];
}
/** Ordenadas por prioridad (DIA, registro con compensación, y con `baja` también el registro de baja confianza). `ocultas` = las de baja confianza que no vienen. */
export const leerEmpresas = async (equipo: boolean, baja = false) => pedir<{ empresas: Empresa[]; ocultas: number }>(`${equipo ? '/api/equipo/empresas' : '/api/empresas'}${baja ? '?baja=1' : ''}`);
export const actualizarEmpresa = (id: number, cambios: { estado?: EstadoEmpresa; nota?: string }) => pedir<{ id: number; estado: EstadoEmpresa; nota: string | null }>(`/api/empresas/${id}`, 'PATCH', cambios);

// --- Cómo sabemos (backtest) ---
export interface BacktestFactor { nombre: string; peso: number; subpuntuacion: number; conocido: boolean; explicacion: string }
export interface BacktestFilaA {
  numero: string; etiqueta: string | null; titulo: string; fechaPublicacion: string; urlBdns: string; notas: string[];
  resultado: { pasoReglas: boolean; motivoReglas: string | null; pasoCriba: boolean; motivoCriba: string | null; etapa: string; puntuacion: number | null; factores: BacktestFactor[]; completa: boolean; exito: boolean } | null;
}
export interface BacktestFilaB {
  numero: string; titulo: string; organo: string; fechaPublicacion: string; urlBdns: string; reglas: string[]; ganadoras: string[];
  procesada: boolean; pasoReglas: boolean | null; pasoCriba: boolean | null; etapa: string | null; motivo: string | null; puntuacion: number | null;
}
export interface BacktestMetricaB {
  conjunto: number; procesadas: number; provisionales: number; sinProcesar: number; sinDatos: number; pasanCriba: number; porcentajePasaCriba: number | null;
  puntuaciones: number[]; medianaPuntuacion: number | null; distribucion: { etiqueta: string; n: number }[];
}
export interface BacktestModo {
  modo: 'sin_analisis' | 'con_analisis';
  a: { filas: BacktestFilaA[]; total: number; calculadas: number; completas: number; exitos: number; pasanReglas: number; pasanCriba: number };
  b: { filas: BacktestFilaB[]; metrica: BacktestMetricaB; excluidas: { motivo: string; n: number }[]; examinadas: number };
  titular: string;
  titularB: string | null;
  coste: { ejecuciones: number; llamadas: number; costeUsd: number };
}
export interface Backtest {
  generadoEn: string;
  origen: 'bd' | 'fichero' | 'vacio';
  modos: { sin_analisis?: BacktestModo; con_analisis?: BacktestModo };
  reglasB: { palabrasAmbientales: string[] };
}
export async function leerBacktest(): Promise<Backtest> {
  const res = await fetch('/api/backtest');
  if (!res.ok) throw new Error(`Error ${res.status} al leer el backtest`);
  return (await res.json()) as Backtest;
}
