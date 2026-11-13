// Plazos a través del motor (respuestas grabadas de BDNS + reloj fijo) y de la API.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crearApi } from '../src/api/app.ts';
import { cierresEntre, leerPlazo } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { bdSembrada, relojFijo } from './support/bd.ts';
import { ESCENARIOS, fetchGrabado } from './support/grabaciones.ts';

describe('plazos en el motor', () => {
  test('agosto 2026: la 923290 ("15 días hábiles tras publicación extracto BOE") sale calculada desde el extracto del BOE', async () => {
    const db = bdSembrada();
    const e = ESCENARIOS.agosto2026;
    const reloj = relojFijo(e.ahora); // martes 04/08/2026
    const r = await ejecutarRadar({ db, fetch: fetchGrabado(), reloj }, { diasAtras: e.diasAtras });
    assert.equal(r.conErrores, false);

    const p = leerPlazo(db, 'bdns:923290', '2026-08-04')!;
    assert.equal(p.tipo, 'calculada');
    assert.equal(p.fechaCierre, '2026-08-28');
    assert.equal(p.fechaBase, '2026-08-07'); // fecha del extracto en el BOE, no la de registro en BDNS (03/08)
    assert.equal(p.baseOrigen, 'extracto');
    assert.equal(p.aproximada, false);
    assert.equal(p.textoOriginal, '15 días hábiles tras publicación extracto BOE');
    assert.equal(p.diasHastaCierre, 24);
    assert.equal(r.plazos?.calculadas, 2);

    // Con el reloj adelantado, los días hasta el cierre cambian (se calculan al leer, no al guardar).
    assert.equal(leerPlazo(db, 'bdns:923290', '2026-08-28')!.diasHastaCierre, 0);
    assert.equal(leerPlazo(db, 'bdns:923290', '2026-08-30')!.diasHastaCierre, -2);
    assert.deepEqual(cierresEntre(db, '2026-08-04', '2026-08-31', '2026-08-04').map((c) => [c.id, c.plazo.diasHastaCierre]), [['bdns:923289', 24], ['bdns:923290', 24]]);
    assert.deepEqual(cierresEntre(db, '2026-08-04', '2026-08-20', '2026-08-04'), []);
  });

  test('abril 2025: literal de la fuente, cálculo con Semana Santa y festivos de mayo, y desconocida con su texto', async () => {
    const db = bdSembrada();
    const e = ESCENARIOS.abril2025;
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora) }, { diasAtras: e.diasAtras });
    const hoy = '2025-04-08';

    const literal = leerPlazo(db, 'bdns:825251', hoy)!;
    assert.deepEqual([literal.tipo, literal.fechaCierre, literal.textoOriginal], ['literal', '2025-09-15', '15 de septiembre 2025']);

    // BOE 08/04, "Quince días hábiles siguientes a la publicación del extracto": salta 17 y 18/04 y 1 y 2/05.
    const calculada = leerPlazo(db, 'bdns:825256', hoy)!;
    assert.deepEqual([calculada.tipo, calculada.fechaCierre, calculada.fechaBase], ['calculada', '2025-05-05', '2025-04-08']);
    assert.match(calculada.detalle, /Jueves Santo/);
    assert.match(calculada.detalle, /Fiesta de la Comunidad de Madrid/);

    // "10 DÍAS HÁBILES DESDE EL INICIO DEL PLAZO DE SOLICITUD": ambiguo → desconocida, con el texto original.
    const desconocida = leerPlazo(db, 'bdns:825309', hoy)!;
    assert.deepEqual([desconocida.tipo, desconocida.fechaCierre, desconocida.diasHastaCierre], ['desconocida', null, null]);
    assert.equal(desconocida.textoOriginal, '10 DÍAS HÁBILES DESDE EL INICIO DEL PLAZO DE SOLICITUD');
  });

  test('re-ejecutar recalcula sin duplicar filas', async () => {
    const db = bdSembrada();
    const e = ESCENARIOS.agosto2026;
    const deps = { db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora) };
    await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    const n1 = (db.prepare('SELECT count(*) AS n FROM plazos').get() as { n: number }).n;
    await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    assert.equal((db.prepare('SELECT count(*) AS n FROM plazos').get() as { n: number }).n, n1);
  });
});

describe('plazos en la API', () => {
  test('/semana y la ficha traen el plazo con los días hasta el cierre desde el reloj de la API', async () => {
    const db = bdSembrada();
    const e = ESCENARIOS.agosto2026;
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora) }, { diasAtras: e.diasAtras });

    const api = crearApi({ db, reloj: relojFijo(new Date('2026-08-09T08:00:00Z')) });
    const semana = await (await api.request('/semana')).json() as { convocatorias: { id: string; plazo: Record<string, unknown> | null }[] };
    const f = semana.convocatorias.find((c) => c.id === 'bdns:923290')!;
    assert.equal(f.plazo?.fechaCierre, '2026-08-28');
    assert.equal(f.plazo?.tipo, 'calculada');
    assert.equal(f.plazo?.diasHastaCierre, 19);

    const ficha = await (await api.request('/convocatorias/bdns:923290')).json() as { plazo: Record<string, unknown> };
    assert.deepEqual(
      [ficha.plazo.fechaCierre, ficha.plazo.tipo, ficha.plazo.textoOriginal, ficha.plazo.fechaBase, ficha.plazo.baseOrigen, ficha.plazo.aproximada, ficha.plazo.diasHastaCierre],
      ['2026-08-28', 'calculada', '15 días hábiles tras publicación extracto BOE', '2026-08-07', 'extracto', false, 19],
    );
  });
});
