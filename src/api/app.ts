// API HTTP (Hono). Sin estado propio: lee de la BD. `crearApi` es el punto de prueba (app.request en memoria).
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { diaLocal, sumarDias } from '../dates.ts';
import { candidatasEntre, ultimasEjecuciones } from '../db/repo.ts';
import type { Reloj } from '../types.ts';

export function crearApi({ db, reloj }: { db: DatabaseSync; reloj: Reloj }): Hono {
  const api = new Hono();

  api.get('/salud', (c) => c.json({ ok: true }));

  /** Candidatas publicadas en los últimos 7 días (hoy incluido). */
  api.get('/semana', (c) => {
    const hasta = diaLocal(reloj.now());
    const desde = sumarDias(hasta, -6);
    return c.json({
      desde,
      hasta,
      convocatorias: candidatasEntre(db, desde, hasta),
      ultimaEjecucion: ultimasEjecuciones(db, 1)[0] ?? null,
    });
  });

  api.get('/ejecuciones', (c) => c.json(ultimasEjecuciones(db, 20)));

  return api;
}
