// Copia coherente de la BD (VACUUM INTO) en data/backup/radar-N.sqlite, N = día de la semana (1 lunes … 7 domingo).
// Se ejecuta dentro del contenedor (dueño de data/): `docker compose run --rm -T radar npm run backup`.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const bd = process.env.DB_PATH ?? 'data/radar.sqlite';
const dir = join('data', 'backup');
const dia = ((new Date().getDay() + 6) % 7) + 1;
const destino = join(dir, `radar-${dia}.sqlite`);

mkdirSync(dir, { recursive: true });
rmSync(destino, { force: true });
new DatabaseSync(bd).exec(`VACUUM INTO '${destino.replaceAll("'", "''")}'`);
console.log(`${new Date().toISOString()} copia: ${destino}`);
