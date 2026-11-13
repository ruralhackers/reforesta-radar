// Servidor: /api + la SPA compilada (dist/web), con vuelta a index.html para las rutas del cliente.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { crearApi } from './api/app.ts';
import { config } from './config.ts';
import { abrirBd } from './db/schema.ts';
import { sembrarSiVacia } from './seed.ts';

const reloj = { now: () => new Date() };
const db = abrirBd(config.rutaBd);
sembrarSiVacia(db, config.rutaSemilla, reloj.now());

const app = new Hono();
app.route('/api', crearApi({ db, reloj }));
app.all('/api/*', (c) => c.json({ error: 'No existe' }, 404));
app.use('/*', serveStatic({ root: config.dirWeb }));
app.get('*', (c) => {
  try {
    return c.html(readFileSync(join(config.dirWeb, 'index.html'), 'utf8'));
  } catch {
    return c.text('Web sin compilar: ejecuta npm run build', 503);
  }
});

serve({ fetch: app.fetch, port: config.puerto, hostname: config.host }, (i) => {
  console.log(`Radar en http://${config.host}:${i.port}`);
});
