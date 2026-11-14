// Configuración por variables de entorno (ver .env.example).
//
// Los valores numéricos se validan al arrancar (`leerConfig`): vacío o ausente = valor por defecto; no numérico, negativo o fuera de rango =
// error claro y salida con código 1 (un `RADAR_MAX_ANALISIS=abc` no puede quitar el tope de gasto ni un `RADAR_PAUSA_BDNS_MS=` dejar la pausa en 0).
import { fileURLToPath } from 'node:url';
import { CONFIG_LLM_POR_DEFECTO } from './llm/llm.ts';

export class ErrorConfig extends Error {}

type Entorno = Record<string, string | undefined>;

/**
 * Lee un número de una variable de entorno. Vacío o ausente → `porDefecto`. Lanza ErrorConfig si no es un número finito, si `entero` y no lo es,
 * o si está fuera de [min, max]. Por defecto: entero >= 0.
 */
export function numeroEnv(env: Entorno, nombre: string, porDefecto: number, o: { min?: number; max?: number; entero?: boolean } = {}): number {
  const crudo = env[nombre]?.trim();
  if (crudo === undefined || crudo === '') return porDefecto;
  const n = Number(crudo);
  const min = o.min ?? 0;
  const entero = o.entero ?? true;
  if (!Number.isFinite(n)) throw new ErrorConfig(`${nombre}="${crudo}" no es un número`);
  if (entero && !Number.isInteger(n)) throw new ErrorConfig(`${nombre}="${crudo}" debe ser un número entero`);
  if (n < min) throw new ErrorConfig(`${nombre}=${crudo} no puede ser menor que ${min}`);
  if (o.max !== undefined && n > o.max) throw new ErrorConfig(`${nombre}=${crudo} no puede ser mayor que ${o.max}`);
  return n;
}

/** Toda la configuración a partir de un entorno. Lanza ErrorConfig con todos los fallos juntos. */
export function leerConfig(env: Entorno) {
  const errores: string[] = [];
  const num = (nombre: string, porDefecto: number, o?: { min?: number; max?: number; entero?: boolean }) => {
    try {
      return numeroEnv(env, nombre, porDefecto, o);
    } catch (e) {
      errores.push((e as Error).message);
      return porDefecto;
    }
  };
  const c = {
    rutaBd: env.DB_PATH || 'data/radar.sqlite',
    rutaSemilla: env.SEED_FILE || 'seed/perfil.json',
    /** Festivos (nacionales y regionales) para contar días hábiles. */
    rutaFestivos: env.FESTIVOS_FILE || fileURLToPath(new URL('../seed/festivos.json', import.meta.url)),
    /** Pesos y umbrales de la puntuación. */
    rutaPuntuacion: env.PUNTUACION_FILE || fileURLToPath(new URL('../seed/puntuacion.json', import.meta.url)),
    /** Palabras genéricas y de administración con las que no se casan los financiadores de las memorias con empresas ni fundaciones (ver seed/financiadores-genericos.json). */
    rutaGenericos: env.FINANCIADORES_GENERICOS_FILE || fileURLToPath(new URL('../seed/financiadores-genericos.json', import.meta.url)),
    /** Informe público del backtest ("Cómo sabemos") que se sirve cuando la BD aún no tiene resultados (lo escribe `npm run backtest`). */
    rutaBacktest: env.BACKTEST_FILE || fileURLToPath(new URL('../seed/backtest.json', import.meta.url)),
    /** Backtest: BD de trabajo (criba y caché del LLM; nunca la del radar), tope de convocatorias del conjunto (b) por ejecución y pasada de construcción. */
    backtest: {
      rutaBdTrabajo: env.BACKTEST_DB || 'data/backtest/trabajo.sqlite',
      maxB: num('BACKTEST_MAX_B', 150),
      maxDetallesB: num('BACKTEST_MAX_DETALLES_B', 400),
    },
    puerto: num('PORT', 8116, { min: 1, max: 65535 }),
    host: env.HOST || '127.0.0.1',
    diasAtras: num('LOOKBACK_DAYS', 7, { min: 1 }),
    dirWeb: env.WEB_DIR || 'dist/web',
    /** Sin clave, la criba y el análisis se saltan (con aviso en el registro de la ejecución). */
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    /** Concesiones de BDNS (ganadores previos y organizaciones parecidas): días de caché de cada consulta, tope de peticiones HTTP por ejecución y pausa entre peticiones. */
    ganadores: {
      diasCache: num('RADAR_DIAS_CACHE_GANADORES', 7),
      maxPeticiones: num('RADAR_MAX_PETICIONES_GANADORES', 200),
      pausaMs: num('RADAR_PAUSA_BDNS_MS', 250),
    },
    /** Descubrimiento por organizaciones parecidas (comparte caché y pausa con los ganadores; su tope sale del tope total de peticiones). */
    parecidas: {
      maxPeticiones: num('RADAR_MAX_PETICIONES_PARECIDAS', 100),
      desdeAnio: num('RADAR_DESDE_ANIO_PARECIDAS', 2022, { min: 2000, max: 2100 }),
      diasEdicion: num('RADAR_DIAS_EDICION_PARECIDAS', 400, { min: 1 }),
    },
    /** Fuente EU Funding & Tenders: pausa entre páginas y tope de peticiones por ejecución (50 resultados por página). */
    euFt: {
      pausaMs: num('RADAR_PAUSA_FT_MS', 500),
      maxPeticiones: num('RADAR_MAX_PETICIONES_FT', 8),
    },
    /** Fuente de convocatorias en cascada de la UE (FSTP): pausa entre páginas y tope de peticiones por ejecución (50 resultados por página). */
    euCascada: {
      rutaTemas: env.CASCADA_FILE || fileURLToPath(new URL('../seed/cascada.json', import.meta.url)),
      /** Raíces extra del pre-filtro de tema (se suman a las de seed/cascada.json) y umbral de menciones en el cuerpo (vacío = el del fichero). */
      terminosExtra: (env.RADAR_TERMINOS_CASCADA ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      mencionesCuerpo: env.RADAR_MENCIONES_CASCADA ? num('RADAR_MENCIONES_CASCADA', 1, { min: 1 }) : null,
      pausaMs: num('RADAR_PAUSA_CASCADA_MS', 500),
      maxPeticiones: num('RADAR_MAX_PETICIONES_CASCADA', 4),
    },
    /**
     * Fuente de licitaciones (PLACSP, sindicación ATOM de licitaciones de perfiles de contratante, sin agregadas). Cada página trae unas 500 entradas y pesa
     * unos 14 MB: tope de páginas por pasada (la diaria llega a cubrir ~1 día laborable con 12), de bytes por página y totales, pausa entre páginas y
     * tiempo máximo por petición. `RADAR_LICITACIONES=0` apaga la fuente. Pre-filtro en seed/licitaciones.json (más CPV y palabras extra por entorno).
     */
    placsp: {
      activa: env.RADAR_LICITACIONES !== '0',
      urlFeed: env.PLACSP_URL || 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom',
      rutaFiltro: env.PLACSP_FILE || fileURLToPath(new URL('../seed/licitaciones.json', import.meta.url)),
      cpvExtra: (env.RADAR_CPV_PLACSP ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      palabrasExtra: (env.RADAR_TERMINOS_PLACSP ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      maxPaginas: num('RADAR_MAX_PAGINAS_PLACSP', 12, { min: 1, max: 200 }),
      maxBytesPagina: num('RADAR_MAX_BYTES_PLACSP', 20 * 1024 * 1024, { min: 1024 }),
      maxBytesTotal: num('RADAR_MAX_BYTES_TOTAL_PLACSP', 300 * 1024 * 1024, { min: 1024 }),
      pausaMs: num('RADAR_PAUSA_PLACSP_MS', 2000),
      timeoutMs: num('RADAR_TIMEOUT_PLACSP_MS', 120_000, { min: 1 }),
      /** Un hueco sin leer del feed se abandona (con aviso) tras estos días o tras 3 fallos seguidos de su URL; y no se guardan más de `maxHuecos` (se tiran los más antiguos). */
      diasHueco: num('RADAR_DIAS_HUECO_PLACSP', 14, { min: 1 }),
      maxHuecos: num('RADAR_MAX_HUECOS_PLACSP', 10, { min: 1 }),
    },
    /** Fundaciones vigiladas: pausa entre páginas, tiempo máximo y tamaño máximo de cada una, tope de fuentes por ejecución y de texto que se pasa al LLM. */
    fundaciones: {
      pausaMs: num('RADAR_PAUSA_FUNDACIONES_MS', 1000),
      timeoutMs: num('RADAR_TIMEOUT_FUNDACIONES_MS', 30_000, { min: 1 }),
      maxBytes: num('RADAR_MAX_BYTES_FUNDACIONES', 3 * 1024 * 1024, { min: 1 }),
      maxFuentes: num('RADAR_MAX_FUNDACIONES', 60),
      maxCaracteres: num('RADAR_MAX_CARACTERES_FUNDACIONES', 60_000, { min: 1 }),
    },
    /** Empresas desde las DIA del BOE: días hacia atrás (la primera vez; luego solo lo no revisado), tope de resoluciones leídas con el LLM por ejecución y pausa entre peticiones al BOE. */
    empresas: {
      diasAtras: num('RADAR_DIAS_DIA_BOE', 60, { min: 1 }),
      maxResoluciones: num('RADAR_MAX_DIA_BOE', 40),
      pausaMs: num('RADAR_PAUSA_BOE_MS', 300),
      maxCaracteres: num('RADAR_MAX_CARACTERES_DIA_BOE', 150_000, { min: 1 }),
    },
    /** Empresas del registro de huella de carbono del MITECO: tope de organizaciones que se criban con el LLM por ejecución, años de huella que cuentan como recientes y tiempo máximo por descarga. */
    huella: {
      maxCribadas: num('RADAR_MAX_HUELLA', 50),
      aniosAtras: num('RADAR_ANIOS_HUELLA', 3, { min: 1 }),
      timeoutMs: num('RADAR_TIMEOUT_HUELLA_MS', 60_000, { min: 1 }),
      /** Letras CNAE de los sectores afines para el nivel B (zona + sector sin compensación). Por defecto B,D,E,F,G,H: extractivas, energía, agua y residuos, construcción, comercio, transporte. La zona sale del ámbito del perfil. */
      sectores: (env.RADAR_SECTORES_HUELLA || 'B,D,E,F,G,H').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
    },
    /** Empresas que compran absorciones (compensaciones del registro del MITECO, sin LLM): años que cuentan como compra reciente en territorio y tiempo máximo por descarga. */
    compras: {
      aniosRecientes: num('RADAR_ANIOS_COMPRAS', 3, { min: 1 }),
      timeoutMs: num('RADAR_TIMEOUT_COMPRAS_MS', 60_000, { min: 1 }),
    },
    /**
     * Memorias anuales de la entidad (`perfil.memorias`): `npm run memorias` las lee una vez con Sonnet. Como es un trabajo puntual, su presupuesto por defecto
     * es 3 USD (RADAR_PRESUPUESTO_USD lo cambia, el mismo que en el radar), con un tope de proyección de 5 USD antes de llamar al LLM. `experiencia` = proyectos propios
     * que entran en los prompts de criba y análisis (0 = ninguno).
     */
    memorias: {
      presupuestoUsd: num('RADAR_PRESUPUESTO_USD', 3, { entero: false }),
      maxProyeccionUsd: num('RADAR_MAX_PROYECCION_MEMORIAS_USD', 5, { entero: false }),
      maxCaracteres: num('RADAR_MAX_CARACTERES_MEMORIAS', 150_000, { min: 1000 }),
      /** Extracciones de memorias como mucho por pasada del radar (el comando `npm run memorias` no tiene tope, solo el presupuesto). */
      maxPorEjecucion: num('RADAR_MAX_MEMORIAS', 2),
      experiencia: num('RADAR_EXPERIENCIA_PROYECTOS', 15),
    },
    /** Aprendizaje ligero: cuántas de las últimas decisiones del equipo se pasan como ejemplos a la criba y el análisis de lo nuevo. */
    decisiones: {
      maxEjemplos: num('RADAR_EJEMPLOS_DECISIONES', 20),
    },
    /** Modo privado: sin TEAM_PASSWORD todo está abierto (demo). SESSION_SECRET refuerza la firma de la cookie; RADAR_COOKIE_SECURE=1/0 fuerza la marca Secure. */
    equipo: {
      password: env.TEAM_PASSWORD || null,
      secret: env.SESSION_SECRET || null,
      confiarXForwardedFor: env.RADAR_CONFIAR_X_FORWARDED_FOR === '1',
      secure: env.RADAR_COOKIE_SECURE === undefined || env.RADAR_COOKIE_SECURE === '' ? undefined : env.RADAR_COOKIE_SECURE === '1',
    },
    /**
     * Correo del lunes (npm run digest). Sin destinatarios no se envía nada; con destinatarios y sin clave, error. Sin RADAR_URL_PUBLICA no hay
     * valor por defecto: el envío se niega (los enlaces irían a otra instancia) y la vista previa usa enlaces relativos.
     */
    resumen: {
      resendApiKey: env.RESEND_API_KEY || null,
      destinatarios: (env.RADAR_DIGEST_DESTINATARIOS ?? '').split(',').map((d) => d.trim()).filter(Boolean),
      remitente: env.RADAR_DIGEST_REMITENTE || 'Radar Reforesta <no-reply@out.ruralhackers.com>',
      urlPublica: env.RADAR_URL_PUBLICA?.trim() || null,
    },
    llm: {
      modeloCriba: env.RADAR_MODELO_CRIBA || CONFIG_LLM_POR_DEFECTO.modeloCriba,
      modeloAnalisis: env.RADAR_MODELO_ANALISIS || CONFIG_LLM_POR_DEFECTO.modeloAnalisis,
      maxAnalisis: num('RADAR_MAX_ANALISIS', CONFIG_LLM_POR_DEFECTO.maxAnalisis),
      diasPendientes: num('RADAR_DIAS_PENDIENTES', CONFIG_LLM_POR_DEFECTO.diasPendientes, { min: 1 }),
      /** Presupuesto en USD por ejecución, común a todas las fases con LLM (criba, análisis, extracción de fundaciones, DIA, huella). */
      presupuestoUsd: num('RADAR_PRESUPUESTO_USD', CONFIG_LLM_POR_DEFECTO.presupuestoUsd, { entero: false }),
      /** Tope de caracteres de documentos que se pasan a un análisis (el resto se recorta con una nota). */
      maxCaracteresAnalisis: num('RADAR_MAX_CARACTERES_ANALISIS', CONFIG_LLM_POR_DEFECTO.maxCaracteresAnalisis, { min: 1000 }),
      /** Intentos fallidos por error del LLM (entre ejecuciones) tras los que una convocatoria deja de reintentarse en esa fase. */
      maxIntentos: num('RADAR_MAX_INTENTOS_LLM', CONFIG_LLM_POR_DEFECTO.maxIntentos, { min: 1 }),
    },
  };
  if (errores.length) throw new ErrorConfig(`Configuración no válida:\n${errores.map((e) => `  - ${e}`).join('\n')}`);
  return c;
}

export type Config = ReturnType<typeof leerConfig>;

function cargar(): Config {
  try {
    return leerConfig(process.env);
  } catch (e) {
    if (!(e instanceof ErrorConfig)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

export const config = cargar();
