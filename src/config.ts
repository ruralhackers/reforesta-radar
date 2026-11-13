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
  llm: {
    modeloCriba: process.env.RADAR_MODELO_CRIBA || CONFIG_LLM_POR_DEFECTO.modeloCriba,
    modeloAnalisis: process.env.RADAR_MODELO_ANALISIS || CONFIG_LLM_POR_DEFECTO.modeloAnalisis,
    maxAnalisis: Number(process.env.RADAR_MAX_ANALISIS ?? CONFIG_LLM_POR_DEFECTO.maxAnalisis),
    diasPendientes: Number(process.env.RADAR_DIAS_PENDIENTES ?? CONFIG_LLM_POR_DEFECTO.diasPendientes),
  },
};
