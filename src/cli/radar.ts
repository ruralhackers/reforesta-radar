// npm run radar — recoge, criba y guarda. Sale con 0 aunque una fuente falle (queda en el registro de ejecución).
import { config } from '../config.ts';
import { abrirBd } from '../db/schema.ts';
import { ejecutarRadar } from '../engine.ts';
import { sembrarSiVacia } from '../seed.ts';

const db = abrirBd(config.rutaBd);
const reloj = { now: () => new Date() };
if (sembrarSiVacia(db, config.rutaSemilla, reloj.now())) console.log(`Semilla cargada desde ${config.rutaSemilla}`);
const r = await ejecutarRadar({ db, fetch: globalThis.fetch, reloj, log: console.log }, { diasAtras: config.diasAtras });
console.log(`Ejecución ${r.ejecucionId}: ${r.conErrores ? 'con errores' : 'ok'}`);
db.close();
