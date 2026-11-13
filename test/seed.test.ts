import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leerPerfil } from '../src/db/repo.ts';
import { abrirBd } from '../src/db/schema.ts';
import { sembrarSiVacia } from '../src/seed.ts';
import { RUTA_SEMILLA } from './support/bd.ts';

test('la semilla carga el perfil en una BD vacía y no pisa uno existente', () => {
  const db = abrirBd(':memory:');
  assert.equal(sembrarSiVacia(db, RUTA_SEMILLA, new Date()), true);

  const perfil = leerPerfil(db);
  assert.equal(perfil?.nif, 'G80428204');
  assert.equal(perfil?.bdnsIdPersona, 5886517);
  assert.equal(perfil?.lineas.length, 3);
  const n = (tabla: string) => (db.prepare(`SELECT count(*) AS n FROM ${tabla}`).get() as { n: number }).n;
  assert.equal(n('organizaciones_parecidas'), 11);
  assert.equal(n('fundaciones'), 14);

  db.prepare("UPDATE perfil SET datos = json_set(datos, '$.importeMinimo', 1) WHERE id = 1").run();
  assert.equal(sembrarSiVacia(db, RUTA_SEMILLA, new Date()), false);
  assert.equal(leerPerfil(db)?.importeMinimo, 1);
});
