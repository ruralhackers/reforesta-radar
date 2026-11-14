// Configuración numérica: vacío = valor por defecto; no numérico, negativo o fuera de rango = error claro al arrancar (y salida 1).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ErrorConfig, leerConfig, numeroEnv } from '../src/config.ts';

describe('configuración numérica', () => {
  test('ausente o vacío → valor por defecto (no 0)', () => {
    assert.equal(numeroEnv({}, 'X', 20), 20);
    assert.equal(numeroEnv({ X: '' }, 'X', 20), 20);
    assert.equal(numeroEnv({ X: '  ' }, 'X', 250), 250);
    const c = leerConfig({ RADAR_PAUSA_BDNS_MS: '', RADAR_MAX_ANALISIS: '' });
    assert.equal(c.ganadores.pausaMs, 250);
    assert.equal(c.llm.maxAnalisis, 20);
    assert.equal(c.llm.presupuestoUsd, 1);
  });

  test('valores válidos se leen, 0 incluido', () => {
    const c = leerConfig({ RADAR_MAX_ANALISIS: '0', RADAR_PRESUPUESTO_USD: '0.25', PORT: '9000' });
    assert.equal(c.llm.maxAnalisis, 0);
    assert.equal(c.llm.presupuestoUsd, 0.25);
    assert.equal(c.puerto, 9000);
  });

  test('no numérico, negativo, decimal donde va entero o fuera de rango → ErrorConfig con todos los fallos', () => {
    assert.throws(() => numeroEnv({ X: 'abc' }, 'X', 1), (e: Error) => e instanceof ErrorConfig && /X="abc" no es un número/.test(e.message));
    assert.throws(() => numeroEnv({ X: '-1' }, 'X', 1), /no puede ser menor que 0/);
    assert.throws(() => numeroEnv({ X: '1.5' }, 'X', 1), /entero/);
    assert.throws(() => numeroEnv({ X: '70000' }, 'X', 1, { max: 65535 }), /mayor que 65535/);
    assert.throws(
      () => leerConfig({ RADAR_MAX_ANALISIS: 'abc', RADAR_PAUSA_BDNS_MS: '-5', RADAR_PRESUPUESTO_USD: 'NaN' }),
      (e: Error) => e instanceof ErrorConfig && /RADAR_MAX_ANALISIS/.test(e.message) && /RADAR_PAUSA_BDNS_MS/.test(e.message) && /RADAR_PRESUPUESTO_USD/.test(e.message),
    );
  });

  test('el proceso sale con 1 y un mensaje claro si la configuración no es válida', () => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli', 'radar.ts')], {
      env: { ...process.env, RADAR_MAX_ANALISIS: 'muchos', DB_PATH: ':memory:' }, encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Configuración no válida/);
    assert.match(r.stderr, /RADAR_MAX_ANALISIS="muchos" no es un número/);
  });
});
