// Configuración por variables de entorno (ver .env.example).
export const config = {
  rutaBd: process.env.DB_PATH ?? 'data/radar.sqlite',
  rutaSemilla: process.env.SEED_FILE ?? 'seed/perfil.json',
  puerto: Number(process.env.PORT ?? 8116),
  host: process.env.HOST ?? '127.0.0.1',
  diasAtras: Number(process.env.LOOKBACK_DAYS ?? 7),
  dirWeb: process.env.WEB_DIR ?? 'dist/web',
};
