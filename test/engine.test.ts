import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { candidatasEntre, guardarFase, leerFases, ultimasEjecuciones } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Fuente } from '../src/sources/source.ts';
import { bdSembrada, relojFijo } from './support/bd.ts';
import { ESCENARIOS, fetchGrabado } from './support/grabaciones.ts';

type Fila = { descarte_regla: string | null; descarte_motivo: string | null; titulo: string; url: string };

function fila(db: DatabaseSync, numConv: string): Fila | undefined {
  return db.prepare('SELECT descarte_regla, descarte_motivo, titulo, url FROM convocatorias WHERE id = ?').get(`bdns:${numConv}`) as Fila | undefined;
}

function contar(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM convocatorias').get() as { n: number }).n;
}

async function ejecutar(db: DatabaseSync, escenario: keyof typeof ESCENARIOS, fetch = fetchGrabado()) {
  const e = ESCENARIOS[escenario];
  return ejecutarRadar({ db, fetch, reloj: relojFijo(e.ahora) }, { diasAtras: e.diasAtras });
}

describe('motor con respuestas grabadas de BDNS', () => {
  test('agosto 2026: entra la 923290 (MITECO), se descartan nominativas, concesiones directas y ayuntamientos ajenos; otras comunidades quedan condicionadas', async () => {
    const db = bdSembrada();
    const r = await ejecutar(db, 'agosto2026');

    assert.equal(r.conErrores, false);
    const [bdns] = r.fuentes;
    assert.equal(bdns.fuente, 'bdns');
    assert.equal(bdns.recibidas, contar(db));
    assert.equal(bdns.candidatas + bdns.descartadas, bdns.recibidas);

    const c923290 = fila(db, '923290');
    assert.equal(c923290?.descarte_regla, null, 'la 923290 debe ser candidata');
    assert.equal(c923290?.url, 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/923290');

    // Nominativa por el título (ya en el listado)
    assert.equal(fila(db, '923535')?.descarte_regla, 'nominativa');
    // Concesión directa del Estado: solo se sabe por el detalle (tipoConvocatoria)
    assert.equal(fila(db, '923424')?.descarte_regla, 'nominativa');
    assert.match(fila(db, '923424')!.descarte_motivo!, /Concesión directa/);
    // Otra comunidad autónoma: no se descarta por regla, queda condicionada a la criba LLM (¿exige sede allí?)
    // y, sin criba, no sale en la lista.
    assert.equal(fila(db, '923229')?.descarte_regla, null);
    assert.match((db.prepare("SELECT condicion FROM convocatorias WHERE id = 'bdns:923229'").get() as { condicion: string }).condicion, /EXTREMADURA.*sede/);
    assert.ok(!candidatasEntre(db, '2026-08-03', '2026-08-04').some((c) => c.id === 'bdns:923229'));
    // Ayuntamiento fuera de Madrid
    assert.equal(fila(db, '923541')?.descarte_regla, 'ambito');
    // Ninguna descartada sin motivo
    assert.equal((db.prepare("SELECT count(*) AS n FROM convocatorias WHERE descarte_regla IS NOT NULL AND coalesce(descarte_motivo, '') = ''").get() as { n: number }).n, 0);
  });

  test('abril 2025: entra la 825309 (CAM, ESFL proyectos ambientales) y la finalidad Defensa queda fuera', async () => {
    const db = bdSembrada();
    await ejecutar(db, 'abril2025');
    assert.equal(fila(db, '825309')?.descarte_regla, null);
    assert.equal(fila(db, '825454')?.descarte_regla, 'finalidad');
    assert.match(fila(db, '825454')!.descarte_motivo!, /Defensa/);
  });

  test('re-ejecutar no duplica ni cambia la primera vez que se vio', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(ESCENARIOS.agosto2026.ahora);
    const deps = { db, fetch: fetchGrabado(), reloj };
    const primera = await ejecutarRadar(deps, { diasAtras: 2 });
    const total = contar(db);
    const vistaAntes = (db.prepare("SELECT primera_vez FROM convocatorias WHERE id = 'bdns:923290'").get() as { primera_vez: string }).primera_vez;

    reloj.adelantar(60 * 60 * 1000);
    const segunda = await ejecutarRadar(deps, { diasAtras: 2 });

    assert.equal(contar(db), total);
    assert.equal(primera.fuentes[0].nuevas, total);
    assert.equal(segunda.fuentes[0].nuevas, 0);
    const despues = db.prepare("SELECT primera_vez, ultima_vez FROM convocatorias WHERE id = 'bdns:923290'").get() as { primera_vez: string; ultima_vez: string };
    assert.equal(despues.primera_vez, vistaAntes);
    assert.notEqual(despues.ultima_vez, vistaAntes);
    assert.equal(ultimasEjecuciones(db, 10).length, 2);
  });

  test('si BDNS no responde, la ejecución queda registrada con el error y no revienta', async () => {
    const db = bdSembrada();
    const caida = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const r = await ejecutar(db, 'agosto2026', caida);

    assert.equal(r.conErrores, true);
    assert.equal(contar(db), 0);
    const [ejecucion] = ultimasEjecuciones(db, 1);
    assert.equal(ejecucion.estado, 'con_errores');
    assert.ok(ejecucion.fin);
    assert.equal(ejecucion.fuentes[0].fuente, 'bdns');
    assert.match(ejecucion.fuentes[0].errores[0], /fetch failed/);
  });

  test('si falla el detalle de una convocatoria, se registra y el resto se guarda', async () => {
    const db = bdSembrada();
    const grabado = fetchGrabado();
    const casiTodo = ((url: string, init?: RequestInit) =>
      String(url).includes('numConv=923290') ? Promise.reject(new TypeError('fetch failed')) : grabado(url, init)) as typeof fetch;
    const r = await ejecutar(db, 'agosto2026', casiTodo);

    assert.equal(r.conErrores, true);
    assert.deepEqual(r.fuentes[0].errores, ['Detalle 923290: fetch failed']);
    assert.equal(fila(db, '923290'), undefined, 'sin detalle no se guarda: se reintentará en la próxima ejecución');
    assert.ok(fila(db, '923289'));
  });

  test('re-ejecutar no borra el veredicto de fases posteriores (criba LLM, equipo…)', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(ESCENARIOS.agosto2026.ahora);
    const deps = { db, fetch: fetchGrabado(), reloj };
    await ejecutarRadar(deps, { diasAtras: 2 });
    const enLista = () => candidatasEntre(db, '2026-08-03', '2026-08-04').map((c) => c.id);
    assert.ok(enLista().includes('bdns:923290'));

    guardarFase(db, { convocatoriaId: 'bdns:923290', fase: 'criba_llm', descarta: true, motivo: 'No encaja', datos: { modelo: 'falso' } }, reloj.now());
    assert.ok(!enLista().includes('bdns:923290'));

    reloj.adelantar(24 * 60 * 60 * 1000);
    await ejecutarRadar(deps, { diasAtras: 2 });

    assert.deepEqual(leerFases(db, 'bdns:923290'), [
      { convocatoriaId: 'bdns:923290', fase: 'criba_llm', descarta: true, motivo: 'No encaja', datos: { modelo: 'falso' } },
    ]);
    assert.ok(!enLista().includes('bdns:923290'), 'sigue fuera de la lista tras la nueva pasada');
    assert.equal(fila(db, '923290')?.descarte_regla, null, 'el veredicto de las reglas se sigue refrescando aparte');
  });

  test('un fallo fuera de las fuentes cierra la ejecución con el error y se relanza', async () => {
    const db = bdSembrada();
    const vacia: Fuente = { nombre: 'repetida', recoger: async () => ({ cribadas: [], errores: [] }) };
    // Dos fuentes con el mismo nombre: el registro de la segunda viola la clave primaria (fallo de BD, no de la fuente).
    await assert.rejects(
      ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(ESCENARIOS.agosto2026.ahora), fuentes: [vacia, vacia] }),
      /UNIQUE constraint failed/,
    );
    const [ejecucion] = ultimasEjecuciones(db, 1);
    assert.equal(ejecucion.estado, 'con_errores');
    assert.ok(ejecucion.fin, 'la ejecución queda cerrada, no en_curso');
    assert.match(ejecucion.error ?? '', /UNIQUE constraint failed/);
    assert.equal(ejecucion.fuentes.length, 1);
  });
});
