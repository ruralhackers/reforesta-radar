// R15: sin fecha de cierre conocida, una convocatoria sale de "Esta semana" (y del correo) a los 60 días de verla por primera vez.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crearApi } from '../src/api/app.ts';
import { guardarConvocatoria, guardarPlazo } from '../src/db/repo.ts';
import { leerConfigPuntuacion, puntuar } from '../src/puntuacion.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, RUTA_PUNTUACION } from './support/bd.ts';

const cfg = leerConfigPuntuacion(RUTA_PUNTUACION);
const conv = (id: string): Convocatoria => ({
  id, fuente: 'bdns', fuenteId: id, titulo: `Ayudas ${id}`, organo: { nivel1: 'ESTADO', nivel2: 'MINISTERIO', nivel3: null },
  fechaPublicacion: '2026-08-01', url: 'https://example.org', tipo: null, finalidad: null, regiones: [], abierto: null, datos: {},
});
const desconocida = { fechaCierre: null, tipo: 'desconocida' as const, diasHastaCierre: null };

test('puntuar: plazo desconocido y vista hace más de diasMaximosSinPlazo → excluida con el motivo; con plazo conocido no', () => {
  assert.equal(cfg.diasMaximosSinPlazo, 60);
  const base = { convocatoria: conv('a'), analisis: null, importeMinimo: null };
  assert.equal(puntuar({ ...base, plazo: desconocida, diasDesdePrimeraVez: 60 }, cfg).excluida, null);
  assert.equal(puntuar({ ...base, plazo: desconocida, diasDesdePrimeraVez: 61 }, cfg).excluida, 'Plazo desconocido y vista por primera vez hace 61 días: probablemente ya cerrada');
  assert.equal(puntuar({ ...base, plazo: null, diasDesdePrimeraVez: 90 }, cfg).excluida?.startsWith('Plazo desconocido'), true);
  assert.equal(puntuar({ ...base, plazo: { fechaCierre: '2027-01-01', tipo: 'literal', diasHastaCierre: 40 }, diasDesdePrimeraVez: 200 }, cfg).excluida, null);
  assert.equal(puntuar({ ...base, plazo: desconocida, diasDesdePrimeraVez: 61 }, { ...cfg, diasMaximosSinPlazo: 90 }).excluida, null, 'configurable');
});

test('/semana: la de plazo desconocido vista hace 70 días no sale; la vista hace 10 sí; la ficha explica por qué', async () => {
  const db = bdSembrada();
  const ahora = new Date('2026-11-13T09:00:00Z');
  guardarConvocatoria(db, { convocatoria: conv('bdns:vieja'), descarte: null }, new Date('2026-09-04T09:00:00Z'));
  guardarConvocatoria(db, { convocatoria: conv('bdns:reciente'), descarte: null }, new Date('2026-11-03T09:00:00Z'));
  for (const id of ['bdns:vieja', 'bdns:reciente']) {
    guardarPlazo(db, id, { fechaCierre: null, tipo: 'desconocida', textoOriginal: null, fechaBase: null, baseOrigen: null, aproximada: false, detalle: 'sin datos' }, ahora);
  }
  const api = crearApi({ db, reloj: { now: () => ahora }, puntuacion: cfg, equipo: { password: null } });
  const semana = (await (await api.request('/semana')).json()) as { convocatorias: { id: string }[] };
  assert.deepEqual(semana.convocatorias.map((c) => c.id), ['bdns:reciente']);
  const ficha = (await (await api.request('/convocatorias/bdns%3Avieja')).json()) as { puntuacion: { excluida: string } };
  assert.match(ficha.puntuacion.excluida, /Plazo desconocido y vista por primera vez hace 70 días/);
});
