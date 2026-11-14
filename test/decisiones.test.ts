// Decisiones del equipo y notas: API (CRUD, orden de "nos interesa"), efecto en "Esta semana" y aprendizaje
// (las decisiones llegan como ejemplos a la criba y al análisis de lo nuevo; lo ya veredictado no se rehace).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { guardarConvocatoria, guardarPlazo, leerFases } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, relojFijo, darPorCribadas } from './support/bd.ts';
import { ESCENARIOS, fetchGrabado } from './support/grabaciones.ts';

const AHORA = new Date('2026-11-13T10:00:00Z');
const reloj = { now: () => AHORA };

function conv(n: string, extra: Partial<Convocatoria> = {}): Convocatoria {
  return {
    id: `bdns:${n}`, fuente: 'bdns', fuenteId: n, titulo: `Convocatoria ${n}`, organo: { nivel1: 'ESTADO', nivel2: 'MINISTERIO X', nivel3: null },
    fechaPublicacion: '2026-11-12', url: `https://example.org/${n}`, tipo: null, finalidad: null, regiones: [], abierto: null, datos: {}, ...extra,
  };
}

const json = (cuerpo: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
type Api = ReturnType<typeof crearApi>;
const decidir = (api: Api, id: string, cuerpo: unknown) => api.request(`/decisiones/${encodeURIComponent(id)}`, { method: 'PUT', ...json(cuerpo) });

function plazo(db: DatabaseSync, id: string, fechaCierre: string | null) {
  guardarPlazo(db, id, { fechaCierre, tipo: fechaCierre ? 'literal' : 'desconocida', textoOriginal: null, fechaBase: null, baseOrigen: null, aproximada: false, detalle: 'test' }, AHORA);
}

describe('API de decisiones y notas', () => {
  test('marcar, cambiar, deshacer; descartar exige un motivo (y "Otro", texto libre); 404 y 400', async () => {
    const db = bdSembrada();
    guardarConvocatoria(db, { convocatoria: conv('1'), descarte: null }, AHORA);
    const api = crearApi({ db, reloj });
    const leer = async () => (await (await api.request('/equipo/convocatorias/bdns%3A1')).json()) as { decision: { decision: string; motivo: string | null; detalle: string | null } | null; notas: unknown[] };

    assert.equal((await leer()).decision, null);
    assert.equal((await decidir(api, 'bdns:1', { decision: 'nos_interesa' })).status, 200);
    assert.equal((await leer()).decision!.decision, 'nos_interesa');

    // Cambiar a descartada con motivo de un clic
    assert.equal((await decidir(api, 'bdns:1', { decision: 'descartada', motivo: 'Importe demasiado bajo' })).status, 200);
    let d = (await leer()).decision!;
    assert.deepEqual([d.decision, d.motivo, d.detalle], ['descartada', 'Importe demasiado bajo', null]);
    // "Otro" con texto libre
    await decidir(api, 'bdns:1', { decision: 'descartada', motivo: 'Otro', detalle: ' Ya la pidió otra entidad del grupo ' });
    d = (await leer()).decision!;
    assert.deepEqual([d.motivo, d.detalle], ['Otro', 'Ya la pidió otra entidad del grupo']);

    for (const [cuerpo, estado] of [
      [{ decision: 'descartada' }, 400], [{ decision: 'descartada', motivo: 'Porque sí' }, 400], [{ decision: 'descartada', motivo: 'Otro' }, 400],
      [{ decision: 'quizá' }, 400], ['no json', 400],
    ] as [unknown, number][]) {
      const r = typeof cuerpo === 'string' ? await api.request('/decisiones/bdns%3A1', { method: 'PUT', body: cuerpo }) : await decidir(api, 'bdns:1', cuerpo);
      assert.equal(r.status, estado, JSON.stringify(cuerpo));
    }
    assert.equal((await leer()).decision!.motivo, 'Otro', 'lo rechazado no cambia nada');
    assert.equal((await decidir(api, 'bdns:999', { decision: 'nos_interesa' })).status, 404);

    // Los motivos de un clic salen de la API
    const { motivos } = await (await api.request('/equipo/motivos')).json() as { motivos: string[] };
    assert.ok(motivos.includes('No encaja con nuestras líneas') && motivos.at(-1) === 'Otro');

    // Deshacer
    assert.equal((await api.request('/decisiones/bdns%3A1', { method: 'DELETE' })).status, 200);
    assert.equal((await leer()).decision, null);
    assert.equal((await api.request('/decisiones/bdns%3A1', { method: 'DELETE' })).status, 404);
    db.close();
  });

  test('notas: varias por convocatoria con fecha y autor opcional, en orden; borrar; validaciones', async () => {
    const db = bdSembrada();
    guardarConvocatoria(db, { convocatoria: conv('1'), descarte: null }, AHORA);
    guardarConvocatoria(db, { convocatoria: conv('2'), descarte: null }, AHORA);
    let t = AHORA.getTime();
    const api = crearApi({ db, reloj: { now: () => new Date((t += 60_000)) } });
    const nota = (id: string, cuerpo: unknown) => api.request(`/decisiones/${encodeURIComponent(id)}/notas`, { method: 'POST', ...json(cuerpo) });

    const r1 = await nota('bdns:1', { texto: 'Llamar a la fundación', autor: 'Marta' });
    assert.equal(r1.status, 201);
    const n1 = await r1.json() as { id: number; texto: string; autor: string; creadaEn: string };
    assert.deepEqual([n1.texto, n1.autor], ['Llamar a la fundación', 'Marta']);
    assert.match(n1.creadaEn, /^2026-11-13T10:01:00/);
    const n2 = await (await nota('bdns:1', { texto: '  Sin autor  ' })).json() as { id: number; autor: string | null };
    assert.equal(n2.autor, null);
    await nota('bdns:2', { texto: 'De otra' });

    const { notas } = await (await api.request('/equipo/convocatorias/bdns%3A1')).json() as { notas: { texto: string }[] };
    assert.deepEqual(notas.map((n) => n.texto), ['Llamar a la fundación', 'Sin autor']);

    assert.equal((await nota('bdns:1', { texto: '   ' })).status, 400);
    assert.equal((await nota('bdns:1', { texto: 'x', autor: 5 })).status, 400);
    assert.equal((await nota('bdns:999', { texto: 'x' })).status, 404);
    // No se borra una nota de otra convocatoria
    assert.equal((await api.request(`/decisiones/bdns%3A2/notas/${n1.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await api.request(`/decisiones/bdns%3A1/notas/${n1.id}`, { method: 'DELETE' })).status, 200);
    const despues = await (await api.request('/equipo/convocatorias/bdns%3A1')).json() as { notas: unknown[] };
    assert.equal(despues.notas.length, 1);
    assert.equal((await api.request('/equipo/convocatorias/bdns%3A999')).status, 404);
    db.close();
  });

  test('"nos interesa": por plazo (el más próximo primero, desconocido al final) con los días que faltan; las descartadas no salen', async () => {
    const db = bdSembrada();
    for (const n of ['1', '2', '3', '4', '5']) guardarConvocatoria(db, { convocatoria: conv(n), descarte: null }, AHORA);
    plazo(db, 'bdns:1', '2026-12-20');
    plazo(db, 'bdns:2', '2026-11-20');
    plazo(db, 'bdns:3', null);
    plazo(db, 'bdns:4', '2026-11-30');
    const api = crearApi({ db, reloj });
    for (const n of ['1', '2', '3', '4']) await decidir(api, `bdns:${n}`, { decision: 'nos_interesa' });
    await decidir(api, 'bdns:5', { decision: 'descartada', motivo: 'Plazo imposible' });

    const r = await (await api.request('/equipo/nos-interesa')).json() as { convocatorias: { id: string; titulo: string; fechaCierre: string | null; diasHastaCierre: number | null }[] };
    assert.deepEqual(r.convocatorias.map((c) => c.id), ['bdns:2', 'bdns:4', 'bdns:1', 'bdns:3']);
    assert.deepEqual(r.convocatorias.map((c) => c.diasHastaCierre), [7, 17, 37, null]);
    assert.equal(r.convocatorias[0].titulo, 'Convocatoria 2');
    db.close();
  });

  test('"nos interesa": abiertas por días que faltan, luego plazo desconocido y al final las cerradas (la más reciente primero)', async () => {
    const db = bdSembrada();
    for (const n of ['1', '2', '3', '4', '5']) guardarConvocatoria(db, { convocatoria: conv(n), descarte: null }, AHORA);
    plazo(db, 'bdns:1', '2026-10-01'); // cerrada hace 42 días
    plazo(db, 'bdns:2', '2026-11-10'); // cerrada hace 3 días
    plazo(db, 'bdns:3', null);
    plazo(db, 'bdns:4', '2026-11-30');
    plazo(db, 'bdns:5', '2026-11-13'); // cierra hoy
    const api = crearApi({ db, reloj });
    for (const n of ['1', '2', '3', '4', '5']) await decidir(api, `bdns:${n}`, { decision: 'nos_interesa' });
    const r = await (await api.request('/equipo/nos-interesa')).json() as { convocatorias: { id: string; diasHastaCierre: number | null }[] };
    assert.deepEqual(r.convocatorias.map((c) => c.id), ['bdns:5', 'bdns:4', 'bdns:3', 'bdns:2', 'bdns:1']);
    assert.deepEqual(r.convocatorias.map((c) => c.diasHastaCierre), [0, 17, null, -3, -43]);
    db.close();
  });
});

describe('lo descartado por el equipo no sale en "Esta semana"', () => {
  test('desaparece de las secciones y de la lista de parecidas, vuelve al deshacer y la decisión sobrevive a una ejecución', async () => {
    const e = ESCENARIOS.agosto2026;
    const db = bdSembrada();
    const rj = relojFijo(e.ahora);
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: rj }, { diasAtras: e.diasAtras });
    darPorCribadas(db);
    const api = crearApi({ db, reloj: rj });
    const semana = async () => await (await api.request('/semana')).json() as { convocatorias: { id: string }[]; lasGananParecidas: string[] };
    const antes = await semana();
    assert.ok(antes.convocatorias.length >= 2);
    const [a, b] = antes.convocatorias.map((c) => c.id);
    // Una de ellas, además, figura en la lista paralela de parecidas
    db.prepare("INSERT INTO origenes_convocatoria (convocatoria_id, origen, nif, nombre, numero_previo, anio_previo) VALUES (?, 'parecidas', 'G11111111', 'Otra ONG', '1', 2025)").run(a);
    assert.deepEqual((await semana()).lasGananParecidas, [a]);

    assert.equal((await decidir(api, a, { decision: 'descartada', motivo: 'Ya presentada' })).status, 200);
    const despues = await semana();
    assert.ok(!despues.convocatorias.some((c) => c.id === a), 'fuera de las secciones');
    assert.deepEqual(despues.lasGananParecidas, [], 'y de la lista de parecidas');
    assert.equal(despues.convocatorias.length, antes.convocatorias.length - 1);

    // "Nos interesa" no la quita
    await decidir(api, b, { decision: 'nos_interesa' });
    assert.ok((await semana()).convocatorias.some((c) => c.id === b));

    // Una ejecución más no la devuelve ni pierde la decisión
    rj.adelantar(3600_000);
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: rj }, { diasAtras: e.diasAtras });
    assert.ok(!(await semana()).convocatorias.some((c) => c.id === a));
    assert.equal((db.prepare('SELECT decision FROM decisiones WHERE convocatoria_id = ?').get(a) as { decision: string }).decision, 'descartada');

    // (el motor reconstruye los orígenes de "parecidas" en cada ejecución: se vuelve a poner el de la prueba)
    db.prepare("INSERT INTO origenes_convocatoria (convocatoria_id, origen, nif, nombre, numero_previo, anio_previo) VALUES (?, 'parecidas', 'G11111111', 'Otra ONG', '1', 2025)").run(a);
    await api.request(`/decisiones/${encodeURIComponent(a)}`, { method: 'DELETE' });
    const vuelta = await semana();
    assert.ok(vuelta.convocatorias.some((c) => c.id === a));
    assert.deepEqual(vuelta.lasGananParecidas, [a]);
  });
});

describe('aprendizaje: las decisiones llegan como ejemplos al LLM', () => {
  const analisisVacio = {
    elegibilidadEsfl: { valor: null, cita: null, documento: null }, importeMaximoProyecto: { valor: null, cita: null, documento: null },
    importeTotal: { valor: null, cita: null, documento: null }, plazo: { valor: null, cita: null, documento: null },
    cofinanciacion: { valor: null, cita: null, documento: null }, requisitos: [], lineas: [], ideaProyecto: null,
  };
  const USO = { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 };
  const idDe = (p: PeticionLlm) => /Convocatoria (bdns:\d+)/.exec(p.mensaje)?.[1] ?? '';

  test('en la siguiente ejecución, la criba y el análisis de una convocatoria nueva reciben las decisiones; lo ya veredictado no se rehace', async () => {
    const e = ESCENARIOS.agosto2026;
    const db = bdSembrada();
    const rj = relojFijo(e.ahora);
    const llamadas: PeticionLlm[] = [];
    const llm: Llm = {
      async generar(p) {
        llamadas.push(p);
        return { datos: p.tarea === 'criba' ? { decision: 'puede_encajar', motivo: 'vale', exigeSedeEnOtraComunidad: 'no_aplica' } : analisisVacio, modelo: p.modelo, uso: USO };
      },
    };
    const deps = { db, fetch: fetchGrabado(), reloj: rj, llm, configLlm: { maxAnalisis: 50 } };
    await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    assert.ok(llamadas.length > 2);
    for (const p of llamadas) assert.doesNotMatch(p.sistema, /Decisiones anteriores del equipo/, 'sin decisiones el prompt no lleva ejemplos');
    const conAnalisis = db.prepare("SELECT convocatoria_id AS id FROM convocatoria_fases WHERE fase = 'analisis' ORDER BY convocatoria_id").all() as { id: string }[];
    assert.ok(conAnalisis.length >= 3);
    const [interesa, descartada, nueva] = conAnalisis.map((f) => f.id);
    const titulo = (id: string) => (db.prepare('SELECT titulo FROM convocatorias WHERE id = ?').get(id) as { titulo: string }).titulo;

    darPorCribadas(db);
    const api = crearApi({ db, reloj: rj });
    await decidir(api, interesa, { decision: 'nos_interesa' });
    rj.adelantar(1000);
    await decidir(api, descartada, { decision: 'descartada', motivo: 'Importe demasiado bajo' });

    // Los veredictos existentes no se tocan al decidir ni en la siguiente ejecución; solo "la nueva" (sin veredictos) se vuelve a evaluar.
    const antes = JSON.stringify(leerFases(db, interesa));
    db.prepare('DELETE FROM convocatoria_fases WHERE convocatoria_id = ?').run(nueva);
    llamadas.length = 0;
    rj.adelantar(3600_000);
    await ejecutarRadar(deps, { diasAtras: e.diasAtras });

    assert.deepEqual([...new Set(llamadas.map(idDe))], [nueva], 'solo se llama por la convocatoria sin veredicto');
    assert.deepEqual(llamadas.map((p) => p.tarea).sort(), ['analisis', 'criba']);
    for (const p of llamadas) {
      assert.match(p.sistema, /Decisiones anteriores del equipo/);
      assert.ok(p.sistema.includes(`- NOS INTERESÓ: ${titulo(interesa)}`), 'la que interesa, con su título');
      assert.ok(p.sistema.includes(`- DESCARTADA (Importe demasiado bajo): ${titulo(descartada)}`), 'la descartada, con su motivo');
      // Posición estable: tras todo el texto fijo del sistema, no en el mensaje
      assert.ok(p.sistema.indexOf('Decisiones anteriores') > p.sistema.indexOf('Líneas de trabajo'));
      assert.doesNotMatch(p.mensaje, /Decisiones anteriores/);
      // más reciente primero
      assert.ok(p.sistema.indexOf(titulo(descartada)) < p.sistema.indexOf(titulo(interesa)));
    }
    assert.equal(JSON.stringify(leerFases(db, interesa)), antes, 'el veredicto previo no se rehízo');

    // Solo las últimas N: con 1 ejemplo solo entra la más reciente
    db.prepare('DELETE FROM convocatoria_fases WHERE convocatoria_id = ?').run(nueva);
    llamadas.length = 0;
    rj.adelantar(3600_000);
    await ejecutarRadar({ ...deps, maxEjemplosDecisiones: 1 }, { diasAtras: e.diasAtras });
    // (con tres ejecuciones seguidas fallando, el radar da por ilegibles los documentos de otras y las analiza: todas las llamadas llevan el mismo ejemplo)
    assert.ok(llamadas.some((p) => idDe(p) === nueva && p.tarea === 'criba'));
    for (const p of llamadas) {
      assert.ok(p.sistema.includes(titulo(descartada)));
      assert.ok(!p.sistema.includes(`- NOS INTERESÓ: ${titulo(interesa)}`));
    }
  });
});
