// npm run seed — carga la semilla si la BD no tiene perfil.
import { config } from '../config.ts';
import { abrirBd } from '../db/schema.ts';
import { sembrarSiVacia } from '../seed.ts';

const db = abrirBd(config.rutaBd);
console.log(sembrarSiVacia(db, config.rutaSemilla, new Date())
  ? `Semilla cargada desde ${config.rutaSemilla} en ${config.rutaBd}`
  : `La BD ${config.rutaBd} ya tiene perfil: no se toca`);
db.close();
