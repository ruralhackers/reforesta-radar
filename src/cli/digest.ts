// npm run digest — compone y envía el correo del lunes (Resend). Opciones: --forzar (repetir la semana), --vista-previa [ruta] (escribe el HTML sin enviar).
// Sin destinatarios: no envía y sale con 0. Con destinatarios y sin RESEND_API_KEY: error, sale con 1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.ts';
import { abrirBd } from '../db/schema.ts';
import { enviarResumen, prepararResumen } from '../engine.ts';
import { crearEmisorResend } from '../mailer.ts';

const args = process.argv.slice(2);
const iPrevia = args.indexOf('--vista-previa');
const db = abrirBd(config.rutaBd);
const reloj = { now: () => new Date() };
try {
  if (iPrevia >= 0) {
    const siguiente = args[iPrevia + 1];
    const ruta = siguiente && !siguiente.startsWith('--') ? siguiente : 'data/digest-preview.html';
    const { correo, convocatorias } = prepararResumen({ db, reloj }, config.resumen);
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, correo.html);
    writeFileSync(ruta.replace(/\.html?$/, '') + '.txt', correo.texto);
    console.log(`Vista previa en ${ruta} (y .txt): "${correo.asunto}", ${convocatorias.length} convocatorias. No se ha enviado nada.`);
  } else {
    const emisor = config.resumen.resendApiKey ? crearEmisorResend({ apiKey: config.resumen.resendApiKey }) : null;
    const r = await enviarResumen({ db, reloj, emisor, log: console.log }, { forzar: args.includes('--forzar') });
    console.log(`Resumen: ${r.estado}`);
  }
} catch (e) {
  console.error(`El resumen falló: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
