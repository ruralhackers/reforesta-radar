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
  /** Aprendizaje ligero: cuántas de las últimas decisiones del equipo se pasan como ejemplos a la criba y el análisis de lo nuevo. */
  decisiones: {
    maxEjemplos: Number(process.env.RADAR_EJEMPLOS_DECISIONES ?? 20),
  },
  /** Modo privado: sin TEAM_PASSWORD todo está abierto (demo). SESSION_SECRET refuerza la firma de la cookie; RADAR_COOKIE_SECURE=1/0 fuerza la marca Secure. */
  equipo: {
    password: process.env.TEAM_PASSWORD || null,
    secret: process.env.SESSION_SECRET || null,
    secure: process.env.RADAR_COOKIE_SECURE === undefined || process.env.RADAR_COOKIE_SECURE === '' ? undefined : process.env.RADAR_COOKIE_SECURE === '1',
  },
  llm: {
    modeloCriba: process.env.RADAR_MODELO_CRIBA || CONFIG_LLM_POR_DEFECTO.modeloCriba,
    modeloAnalisis: process.env.RADAR_MODELO_ANALISIS || CONFIG_LLM_POR_DEFECTO.modeloAnalisis,
    maxAnalisis: Number(process.env.RADAR_MAX_ANALISIS ?? CONFIG_LLM_POR_DEFECTO.maxAnalisis),
    diasPendientes: Number(process.env.RADAR_DIAS_PENDIENTES ?? CONFIG_LLM_POR_DEFECTO.diasPendientes),
  },
};
