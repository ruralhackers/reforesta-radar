// Configuración por variables de entorno (ver .env.example).
import { fileURLToPath } from 'node:url';
import { CONFIG_LLM_POR_DEFECTO } from './llm/llm.ts';

export const config = {
  rutaBd: process.env.DB_PATH ?? 'data/radar.sqlite',
  rutaSemilla: process.env.SEED_FILE ?? 'seed/perfil.json',
  /** Festivos (nacionales y regionales) para contar días hábiles. */
  rutaFestivos: process.env.FESTIVOS_FILE ?? fileURLToPath(new URL('../seed/festivos.json', import.meta.url)),
  /** Pesos y umbrales de la puntuación. */
  rutaPuntuacion: process.env.PUNTUACION_FILE ?? fileURLToPath(new URL('../seed/puntuacion.json', import.meta.url)),
  /** Informe público del backtest ("Cómo sabemos") que se sirve cuando la BD aún no tiene resultados (lo escribe `npm run backtest`). */
  rutaBacktest: process.env.BACKTEST_FILE ?? fileURLToPath(new URL('../seed/backtest.json', import.meta.url)),
  /** Backtest: BD de trabajo (criba y caché del LLM; nunca la del radar), tope de convocatorias del conjunto (b) por ejecución y pasada de construcción. */
  backtest: {
    rutaBdTrabajo: process.env.BACKTEST_DB ?? 'data/backtest/trabajo.sqlite',
    maxB: Number(process.env.BACKTEST_MAX_B ?? 150),
    maxDetallesB: Number(process.env.BACKTEST_MAX_DETALLES_B ?? 400),
  },
  puerto: Number(process.env.PORT ?? 8116),
  host: process.env.HOST ?? '127.0.0.1',
  diasAtras: Number(process.env.LOOKBACK_DAYS ?? 7),
  dirWeb: process.env.WEB_DIR ?? 'dist/web',
  /** Sin clave, la criba y el análisis se saltan (con aviso en el registro de la ejecución). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  /** Concesiones de BDNS (ganadores previos y organizaciones parecidas): días de caché de cada consulta, tope de peticiones HTTP por ejecución y pausa entre peticiones. */
  ganadores: {
    diasCache: Number(process.env.RADAR_DIAS_CACHE_GANADORES ?? 7),
    maxPeticiones: Number(process.env.RADAR_MAX_PETICIONES_GANADORES ?? 200),
    pausaMs: Number(process.env.RADAR_PAUSA_BDNS_MS ?? 250),
  },
  /** Descubrimiento por organizaciones parecidas (comparte caché y pausa con los ganadores; su tope sale del tope total de peticiones). */
  parecidas: {
    maxPeticiones: Number(process.env.RADAR_MAX_PETICIONES_PARECIDAS ?? 100),
    desdeAnio: Number(process.env.RADAR_DESDE_ANIO_PARECIDAS ?? 2022),
    diasEdicion: Number(process.env.RADAR_DIAS_EDICION_PARECIDAS ?? 400),
  },
  /** Fuente EU Funding & Tenders: pausa entre páginas y tope de peticiones por ejecución (50 resultados por página). */
  euFt: {
    pausaMs: Number(process.env.RADAR_PAUSA_FT_MS ?? 500),
    maxPeticiones: Number(process.env.RADAR_MAX_PETICIONES_FT ?? 8),
  },
  /** Fundaciones vigiladas: pausa entre páginas, tiempo máximo y tamaño máximo de cada una, tope de fuentes por ejecución y de texto que se pasa al LLM. */
  fundaciones: {
    pausaMs: Number(process.env.RADAR_PAUSA_FUNDACIONES_MS ?? 1000),
    timeoutMs: Number(process.env.RADAR_TIMEOUT_FUNDACIONES_MS ?? 30_000),
    maxBytes: Number(process.env.RADAR_MAX_BYTES_FUNDACIONES ?? 3 * 1024 * 1024),
    maxFuentes: Number(process.env.RADAR_MAX_FUNDACIONES ?? 60),
    maxCaracteres: Number(process.env.RADAR_MAX_CARACTERES_FUNDACIONES ?? 60_000),
  },
  /** Empresas desde las DIA del BOE: días hacia atrás (la primera vez; luego solo lo no revisado), tope de resoluciones leídas con el LLM por ejecución y pausa entre peticiones al BOE. */
  empresas: {
    diasAtras: Number(process.env.RADAR_DIAS_DIA_BOE ?? 60),
    maxResoluciones: Number(process.env.RADAR_MAX_DIA_BOE ?? 40),
    pausaMs: Number(process.env.RADAR_PAUSA_BOE_MS ?? 300),
    maxCaracteres: Number(process.env.RADAR_MAX_CARACTERES_DIA_BOE ?? 150_000),
  },
  /** Empresas del registro de huella de carbono del MITECO: tope de organizaciones que se criban con el LLM por ejecución, años de huella que cuentan como recientes y tiempo máximo por descarga. */
  huella: {
    maxCribadas: Number(process.env.RADAR_MAX_HUELLA ?? 50),
    aniosAtras: Number(process.env.RADAR_ANIOS_HUELLA ?? 3),
    timeoutMs: Number(process.env.RADAR_TIMEOUT_HUELLA_MS ?? 60_000),
    /** Letras CNAE de los sectores afines para el nivel B (zona + sector sin compensación). Por defecto B,D,E,F,G,H: extractivas, energía, agua y residuos, construcción, comercio, transporte. La zona sale del ámbito del perfil. */
    sectores: (process.env.RADAR_SECTORES_HUELLA ?? 'B,D,E,F,G,H').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
  },
  /** Aprendizaje ligero: cuántas de las últimas decisiones del equipo se pasan como ejemplos a la criba y el análisis de lo nuevo. */
  decisiones: {
    maxEjemplos: Number(process.env.RADAR_EJEMPLOS_DECISIONES ?? 20),
  },
  /** Modo privado: sin TEAM_PASSWORD todo está abierto (demo). SESSION_SECRET refuerza la firma de la cookie; RADAR_COOKIE_SECURE=1/0 fuerza la marca Secure. */
  equipo: {
    password: process.env.TEAM_PASSWORD || null,
    secret: process.env.SESSION_SECRET || null,
    confiarXForwardedFor: process.env.RADAR_CONFIAR_X_FORWARDED_FOR === '1',
    secure: process.env.RADAR_COOKIE_SECURE === undefined || process.env.RADAR_COOKIE_SECURE === '' ? undefined : process.env.RADAR_COOKIE_SECURE === '1',
  },
  /** Correo del lunes (npm run digest). Sin destinatarios no se envía nada; con destinatarios y sin clave, error. */
  resumen: {
    resendApiKey: process.env.RESEND_API_KEY || null,
    destinatarios: (process.env.RADAR_DIGEST_DESTINATARIOS ?? '').split(',').map((d) => d.trim()).filter(Boolean),
    remitente: process.env.RADAR_DIGEST_REMITENTE || 'Radar Reforesta <no-reply@out.ruralhackers.com>',
    urlPublica: process.env.RADAR_URL_PUBLICA || 'https://radar-reforesta.ruralhackers.com',
  },
  llm: {
    modeloCriba: process.env.RADAR_MODELO_CRIBA || CONFIG_LLM_POR_DEFECTO.modeloCriba,
    modeloAnalisis: process.env.RADAR_MODELO_ANALISIS || CONFIG_LLM_POR_DEFECTO.modeloAnalisis,
    maxAnalisis: Number(process.env.RADAR_MAX_ANALISIS ?? CONFIG_LLM_POR_DEFECTO.maxAnalisis),
    diasPendientes: Number(process.env.RADAR_DIAS_PENDIENTES ?? CONFIG_LLM_POR_DEFECTO.diasPendientes),
  },
};
