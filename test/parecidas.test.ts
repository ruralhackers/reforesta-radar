// Descubrimiento por organizaciones parecidas: motor con concesiones reales grabadas de GREFA y Grupo Brinzal (BDNS, reloj fijo 20/08/2026),
// búsqueda de las ediciones de cada serie que ganaron y detalle de las ediciones nuevas. La 923290 (MITECO, línea A, anualidad 2026, registrada
// el 03/08/2026) es la edición nueva de la serie que ambas ganaron en 2023, 2024 y 2025; la 904719 (CAM, proyectos ambientales 2026) ya cerró
// el 08/06/2026 y la 897908 (CAM, proyectos juveniles 2026) ya la ganó GREFA: ninguna es candidata.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { guardarParecidasCalculadas, leerParecidas, origenesDe } from '../src/db/ganadores.ts';
import { candidatasEntre, enJuegoTodas, guardarConvocatoria, pendientesDeFase } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { textoBusquedaSerie } from '../src/concesiones.ts';
import { seccionParecidas } from '../src/ranking.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { bdns } from '../src/sources/bdns.ts';
import type { Fuente } from '../src/sources/source.ts';
import { bdSembrada, RUTA_PUNTUACION, relojFijo } from './support/bd.ts';
import { fetchGrabado } from './support/grabaciones.ts';
import { AHORA_PARECIDAS as AHORA, NIF_ACTIVAS_PARECIDAS, NIF_BRINZAL, NIF_GREFA } from './support/parecidas.ts';

const ID = 'bdns:923290';
const sinNovedades: Fuente = { ...bdns, recoger: async () => ({ cribadas: [], errores: [] }) };

/** Semilla con solo GREFA y Brinzal activas (las otras tienen concesiones sin grabar). */
function bdParecidas(): DatabaseSync {
  const db = bdSembrada();
  db.prepare(`UPDATE organizaciones_parecidas SET activa = 0 WHERE nif NOT IN (${NIF_ACTIVAS_PARECIDAS.map((n) => `'${n}'`).join(',')})`).run();
  return db;
}

const ejecutar = (db: DatabaseSync, extra: object = {}, fuente: Fuente = sinNovedades) =>
  ejecutarRadar({ db, fetch: fetchGrabado({ concesiones: true }), reloj: relojFijo(AHORA), fuentes: [fuente], ganadores: false, dormir: async () => {}, ...extra });

const api = (db: DatabaseSync) => crearApi({ db, reloj: relojFijo(AHORA), fuentes: [sinNovedades], puntuacion: leerConfigPuntuacion(RUTA_PUNTUACION) });
const json = (app: ReturnType<typeof api>, ruta: string, metodo = 'GET', cuerpo?: object) =>
  app.request(ruta, { method: metodo, ...(cuerpo ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) } : {}) });
const ids = (db: DatabaseSync) => candidatasEntre(db, '2000-01-01', '2100-01-01').map((c) => c.id);
const filas = (db: DatabaseSync, id: string) => (db.prepare('SELECT COUNT(*) AS n FROM convocatorias WHERE id = ?').get(id) as { n: number }).n;
const marcada = (db: DatabaseSync, id: string) => db.prepare('SELECT 1 FROM descubiertas_parecidas WHERE convocatoria_id = ?').get(id) !== undefined;

describe('descubrimiento con concesiones grabadas', () => {
  test('la nueva edición de lo que ganaron GREFA y Brinzal entra como candidata con su origen; lo cerrado o ya resuelto no', async () => {
    const db = bdParecidas();
    const r = await ejecutar(db);
    assert.equal(r.conErrores, false, JSON.stringify(r.parecidas?.errores));
    assert.equal(r.parecidas?.organizaciones, 2);
    assert.equal(r.parecidas?.nuevas, 1);
    assert.equal(r.parecidas?.etiquetadas, 1);
    // Solo la 923290: la 904719 cerró el 08/06 y la 897908 ya tiene ganadores; las ediciones viejas (2023-2025) no son candidatas.
    assert.deepEqual(ids(db), [ID]);
    for (const n of ['712977', '782254', '848938', '904719', '897908']) assert.equal(filas(db, `bdns:${n}`), 0, n);
    const o = origenesDe(db, ID);
    assert.deepEqual([...new Set(o.map((x) => x.nif))].sort(), [NIF_GREFA, NIF_BRINZAL].sort());
    assert.deepEqual([...new Set(o.map((x) => x.numeroPrevio))].sort(), ['712977', '782254', '848938']);
    assert.equal(o.find((x) => x.numeroPrevio === '848938')?.anioPrevio, 2025);
    assert.equal(marcada(db, ID), true);
    // Pasó por las reglas como cualquier otra: el órgano es del Estado y la finalidad no está excluida.
    const fila = db.prepare('SELECT descarte_regla, fuente, fecha_publicacion FROM convocatorias WHERE id = ?').get(ID) as Record<string, string | null>;
    assert.deepEqual({ ...fila }, { descarte_regla: null, fuente: 'bdns', fecha_publicacion: '2026-08-03' });
  });

  test('segunda pasada: todo en caché, sin duplicar filas ni etiquetas', async () => {
    const db = bdParecidas();
    await ejecutar(db);
    const antes = origenesDe(db, ID).length;
    const r = await ejecutar(db);
    assert.equal(r.parecidas?.consultas, 0);
    assert.equal(r.parecidas?.peticiones, 0);
    assert.equal(r.parecidas?.desdeCache, 24);
    assert.equal(r.parecidas?.nuevas, 0);
    assert.equal(r.parecidas?.yaConocidas, 1);
    assert.equal(origenesDe(db, ID).length, antes);
    assert.equal(filas(db, ID), 1);
  });

  test('sin duplicados con BDNS directo: si ya estaba guardada solo se añade la etiqueta, y si llega después por directo se queda', async () => {
    const db = bdParecidas();
    // Ya conocida por la fuente directa (con su detalle real).
    const detalle = JSON.parse((await (await fetchGrabado()('https://www.infosubvenciones.es/bdnstrans/api/convocatorias?numConv=923290')).text())) as { descripcion: string; organo: { nivel1: string; nivel2: string; nivel3: string } };
    guardarConvocatoria(db, {
      descarte: null,
      convocatoria: { id: ID, fuente: 'bdns', fuenteId: '923290', titulo: detalle.descripcion, organo: detalle.organo, fechaPublicacion: '2026-08-03', url: 'x', tipo: null, finalidad: null, regiones: [], abierto: null, datos: { directo: true } },
    }, AHORA);
    const r = await ejecutar(db);
    assert.equal(r.parecidas?.nuevas, 0);
    assert.equal(r.parecidas?.yaConocidas, 1);
    assert.equal(filas(db, ID), 1);
    assert.equal(marcada(db, ID), false, 'ya venía de BDNS directo: no es "solo parecidas"');
    assert.ok(origenesDe(db, ID).length > 0);
    assert.deepEqual((db.prepare('SELECT datos FROM convocatorias WHERE id = ?').get(ID) as { datos: string }).datos, '{"directo":true}', 'no se pisa lo que trajo la fuente');

    // Y al revés: descubierta primero, la fuente directa la trae después → una sola fila y sin marca.
    const db2 = bdParecidas();
    await ejecutar(db2);
    assert.equal(marcada(db2, ID), true);
    const c = (db2.prepare('SELECT * FROM convocatorias WHERE id = ?').get(ID) as Record<string, string>);
    const directa: Fuente = {
      ...bdns,
      recoger: async () => ({ cribadas: [{ descarte: null, convocatoria: { id: ID, fuente: 'bdns', fuenteId: '923290', titulo: c.titulo, organo: { nivel1: c.organo_nivel1, nivel2: c.organo_nivel2, nivel3: c.organo_nivel3 }, fechaPublicacion: c.fecha_publicacion, url: c.url, tipo: null, finalidad: null, regiones: [], abierto: null, datos: JSON.parse(c.datos) } }], errores: [] }),
    };
    await ejecutar(db2, {}, directa);
    assert.equal(filas(db2, ID), 1);
    assert.equal(marcada(db2, ID), false);
    // Aunque luego se desactiven las dos organizaciones, sigue en juego porque también viene de BDNS directo.
    db2.prepare('UPDATE organizaciones_parecidas SET activa = 0').run();
    await ejecutar(db2);
    assert.deepEqual(ids(db2), [ID]);
  });

  test('lo descubierto también pasa por la criba aunque se registrara hace más de la ventana de pendientes', async () => {
    const db = bdParecidas();
    await ejecutar(db);
    db.prepare("UPDATE convocatorias SET fecha_publicacion = '2026-01-10' WHERE id = ?").run(ID);
    assert.deepEqual(pendientesDeFase(db, 'criba_llm', '2026-07-22').map((p) => p.convocatoria.id), [ID]);
    db.prepare("DELETE FROM origenes_convocatoria").run();
    assert.deepEqual(pendientesDeFase(db, 'criba_llm', '2026-07-22'), []); // sin etiqueta vuelve a valer solo la fecha
  });

  test('tope de peticiones compartido con la fase de ganadores', async () => {
    const db = bdParecidas();
    const r = await ejecutar(db, { ganadores: { maxPeticiones: 5, pausaMs: 0 }, parecidas: { pausaMs: 0 } });
    assert.equal(r.parecidas?.peticiones, 5);
    assert.ok((r.parecidas?.omitidasPorTope ?? 0) > 0);
    assert.equal(r.ganadores?.peticiones, 0, 'lo que gastó el descubrimiento se descuenta del tope total');
    assert.ok(r.ganadores!.omitidasPorTope > 0);
  });

  test('un fallo de red se anota y no corta la ejecución ni borra lo anterior', async () => {
    const db = bdParecidas();
    await ejecutar(db);
    const r = await ejecutar(db, { fetch: (() => Promise.reject(new Error('sin red'))) as typeof fetch, ganadores: false, parecidas: { diasCache: 0 } });
    assert.ok(r.conErrores);
    assert.ok((r.parecidas?.errores.length ?? 0) > 0);
    assert.deepEqual(ids(db), [ID]);
    assert.ok(origenesDe(db, ID).length > 0);
  });

  test('parecidas: false salta la fase', async () => {
    const db = bdParecidas();
    const r = await ejecutar(db, { parecidas: false });
    assert.equal(r.parecidas, null);
    assert.deepEqual(ids(db), []);
  });

  test('el texto de búsqueda llega hasta el primer año (la búsqueda de BDNS es de frase)', () => {
    assert.equal(textoBusquedaSerie('AYUDAS CONCURRENCIA COMPETITIVA LÍNEA A DESARROLLO ACTIVIDADES INTERÉS GENERAL. ANUALIDAD 2025.'), 'AYUDAS CONCURRENCIA COMPETITIVA LÍNEA A DESARROLLO ACTIVIDADES INTERÉS GENERAL. ANUALIDAD');
    assert.equal(textoBusquedaSerie('SUBVENCIÓN ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES 2026'), 'SUBVENCIÓN ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES');
  });
});

describe('ranking y ficha', () => {
  test('la descubierta sale en su sección principal Y en "las ganan organizaciones como vosotros", marcada con su origen', async () => {
    const db = bdParecidas();
    await ejecutar(db);
    const semana = await (await json(api(db), '/semana')).json() as any;
    const c = semana.convocatorias.find((x: any) => x.id === ID);
    assert.ok(c, 'está en el ranking');
    assert.equal(semana.convocatorias.filter((x: any) => x.id === ID).length, 1, 'una sola vez en las secciones principales');
    assert.ok(['cierran_pronto', 'nuevas', 'abiertas'].includes(c.seccion));
    assert.equal(c.parecidas.descubierta, true);
    assert.deepEqual(c.parecidas.organizaciones.map((o: any) => o.nombre).sort(), ['GREFA', 'Grupo Brinzal']);
    assert.deepEqual(c.parecidas.organizaciones[0].anios, [2025, 2024, 2023]);
    assert.deepEqual(semana.lasGananParecidas, [ID]);
    const ficha = await (await json(api(db), `/convocatorias/${ID}`)).json() as any;
    assert.equal(ficha.parecidas.descubierta, true);
    assert.equal(ficha.parecidas.organizaciones.length, 2);
  });

  test('una candidata de BDNS directo sin ninguna parecida entre sus ganadores no sale en la lista; con una parecida entre los ganadores previos sí', async () => {
    const db = bdParecidas();
    await ejecutar(db, { parecidas: false });
    assert.deepEqual(((await (await json(api(db), '/semana')).json()) as any).lasGananParecidas, []);
    // Misma convocatoria, ahora de BDNS directo, con una parecida entre los ganadores de su edición anterior.
    const c = { id: 'bdns:999', fuente: 'bdns', fuenteId: '999', titulo: 'AYUDAS CONCURRENCIA COMPETITIVA LÍNEA A DESARROLLO ACTIVIDADES INTERÉS GENERAL CONSIDERADAS INTERÉS SOCIAL, EN EL ÁMBITO DE LA INVESTIGACIÓN CIENTÍFICA Y TÉCNICA Y PROTECCIÓN MEDIO AMBIENTE EN MATERIAS DE COMPETENCIA ESTATAL. ANUALIDAD 2026.', organo: { nivel1: 'ESTADO', nivel2: 'MINISTERIO PARA LA TRANSICIÓN ECOLÓGICA Y EL RETO DEMOGRÁFICO', nivel3: 'DIRECCIÓN GENERAL DE SERVICIOS' }, fechaPublicacion: '2026-08-10', url: 'x', tipo: null, finalidad: null, regiones: [], abierto: null, datos: {} };
    guardarConvocatoria(db, { convocatoria: c, descarte: null }, AHORA);
    await ejecutar(db, { ganadores: { maxPeticiones: 0 } }); // sin red para ganadores; usa lo ya guardado por el descubrimiento (ediciones y concesiones de las parecidas)
    // Sin concesiones de las ediciones anteriores en `concesiones` (solo en ganadas_parecidas) no hay ganadores previos conocidos: no sale.
    assert.deepEqual(((await (await json(api(db), '/semana')).json()) as any).lasGananParecidas, []);
    // Con sus concesiones guardadas (lo que hace la fase de ganadores), sí.
    const filaConcesion = (id: number, numero: string, anio: number) => ({ id, fechaConcesion: `${anio}-12-01`, beneficiario: `${NIF_GREFA} GREFA`, importe: 1000, urlBR: null, numeroConvocatoria: numero, idConvocatoria: id, convocatoria: c.titulo.replace('2026', String(anio)), ...c.organo, idPersona: null });
    const { guardarConcesionesDeConvocatoria } = await import('../src/db/ganadores.ts');
    guardarConcesionesDeConvocatoria(db, '848938', [filaConcesion(1, '848938', 2025)], AHORA);
    const semana = await (await json(api(db), '/semana')).json() as any;
    assert.ok(semana.lasGananParecidas.includes('bdns:999'));
    assert.equal(semana.convocatorias.find((x: any) => x.id === 'bdns:999').parecidas.descubierta, false);
  });

  test('seccionParecidas: solo las que tienen parecidas, por puntuación, sin quitarlas de su sección', () => {
    const f = (id: string, total: number, parecidas: unknown, seccion: string) => ({ id, seccion, parecidas, plazo: null, fechaPublicacion: '2026-01-01', puntuacion: { total } }) as any;
    const r = seccionParecidas([f('a', 50, null, 'nuevas'), f('b', 60, { x: 1 }, 'cierran_pronto'), f('c', 80, { x: 1 }, 'abiertas')]);
    assert.deepEqual(r.map((x) => x.id), ['c', 'b']);
    assert.deepEqual(r.map((x) => x.seccion), ['abiertas', 'cierran_pronto']);
  });
});

describe('ajuste de la lista (activar, añadir, quitar)', () => {
  test('desactivar una organización la excluye de la siguiente ejecución; la candidata deja de estar en juego si ya no le queda ninguna', async () => {
    const db = bdParecidas();
    const app = api(db);
    await ejecutar(db);
    assert.deepEqual(ids(db), [ID]);
    let r = await json(app, `/parecidas/${NIF_GREFA}`, 'PATCH', { activa: false });
    assert.equal(r.status, 200);
    await ejecutar(db);
    assert.deepEqual([...new Set(origenesDe(db, ID).map((o) => o.nif))], [NIF_BRINZAL], 'solo queda Brinzal');
    assert.deepEqual(ids(db), [ID]);
    r = await json(app, `/parecidas/${NIF_BRINZAL}`, 'PATCH', { activa: false });
    await ejecutar(db);
    assert.deepEqual(origenesDe(db, ID), []);
    assert.deepEqual(ids(db), [], 'solo la traían las parecidas desactivadas');
    assert.deepEqual(enJuegoTodas(db), []);
    assert.equal(filas(db, ID), 1, 'la fila se conserva (por si se reactiva)');
    assert.deepEqual(((await (await json(app, '/semana')).json()) as any).convocatorias, []);
    // Reactivar la devuelve (la caché guarda lo consultado: no hace falta red).
    await json(app, `/parecidas/${NIF_GREFA}`, 'PATCH', { activa: true });
    const r2 = await ejecutar(db, { fetch: (() => Promise.reject(new Error('sin red'))) as typeof fetch });
    assert.equal(r2.parecidas?.peticiones, 0);
    assert.deepEqual(ids(db), [ID]);
  });

  test('el recálculo de las calculadas no reactiva una desactivada', async () => {
    const db = bdParecidas();
    await json(api(db), `/parecidas/${NIF_GREFA}`, 'PATCH', { activa: false });
    guardarParecidasCalculadas(db, [{ nif: NIF_GREFA, nombre: 'GREFA', evidencia: ['1', '2'] }], AHORA);
    assert.equal(leerParecidas(db).find((p) => p.nif === NIF_GREFA)?.activa, false);
  });

  test('añadir una por NIF la incluye en la siguiente ejecución; quitar la manual la saca', async () => {
    const db = bdParecidas();
    db.prepare('DELETE FROM organizaciones_parecidas WHERE nif IN (?, ?)').run(NIF_GREFA, NIF_BRINZAL);
    const app = api(db);
    await ejecutar(db);
    assert.deepEqual(ids(db), [], 'sin parecidas activas no se descubre nada');

    const alta = await json(app, '/parecidas', 'POST', { nif: ' g78616893 ' });
    assert.equal(alta.status, 201);
    assert.equal(((await alta.json()) as any).origen, 'manual');
    assert.equal((await json(app, '/parecidas', 'POST', { nif: NIF_BRINZAL })).status, 409, 'ya está');
    const r = await ejecutar(db);
    assert.equal(r.parecidas?.organizaciones, 1);
    assert.deepEqual(ids(db), [ID]);
    assert.deepEqual([...new Set(origenesDe(db, ID).map((o) => o.nif))], [NIF_BRINZAL]);
    const lista = await (await json(app, '/parecidas')).json() as any;
    const brinzal = lista.parecidas.find((p: any) => p.nif === NIF_BRINZAL);
    assert.equal(brinzal.origen, 'manual');
    assert.equal(brinzal.activa, true);
    assert.equal(brinzal.convocatorias, 1);
    assert.match(brinzal.nombre, /^GRUPO BRINZAL/, 'sin nombre se adopta el de BDNS (que lo trunca)');

    assert.equal((await json(app, `/parecidas/${NIF_BRINZAL}`, 'DELETE')).status, 200);
    await ejecutar(db);
    assert.deepEqual(ids(db), []);
    assert.equal(leerParecidas(db).some((p) => p.nif === NIF_BRINZAL), false);
  });

  test('alta con nombre; validaciones y errores', async () => {
    const db = bdParecidas();
    const app = api(db);
    const ok = await json(app, '/parecidas', 'POST', { nif: 'G11111111', nombre: ' Mi amiga ' });
    assert.equal(ok.status, 201);
    assert.equal(leerParecidas(db).find((p) => p.nif === 'G11111111')?.nombre, 'Mi amiga');
    assert.equal((await json(app, '/parecidas', 'POST', { nif: '12345678Z' })).status, 400, 'personas físicas no');
    assert.equal((await json(app, '/parecidas', 'POST', { nif: 'basura' })).status, 400);
    assert.equal((await json(app, '/parecidas', 'POST', {})).status, 400);
    assert.equal((await json(app, `/parecidas/${NIF_GREFA}`, 'PATCH', { activa: 'no' })).status, 400);
    assert.equal((await json(app, '/parecidas/G99999999', 'PATCH', { activa: false })).status, 404);
    assert.equal((await json(app, '/parecidas/G99999999', 'DELETE')).status, 404);
    assert.equal((await json(app, `/parecidas/${NIF_GREFA}`, 'DELETE')).status, 409, 'las de semilla/calculadas solo se desactivan');
    assert.equal(leerParecidas(db).some((p) => p.nif === NIF_GREFA), true);
  });

  test('GET /parecidas lista nombre, NIF, origen, coincidencias y activa', async () => {
    const db = bdParecidas();
    const lista = await (await json(api(db), '/parecidas')).json() as any;
    assert.equal(lista.parecidas.length, 11);
    const grefa = lista.parecidas.find((p: any) => p.nif === NIF_GREFA);
    assert.deepEqual({ ...grefa }, { nif: NIF_GREFA, nombre: 'GREFA', origen: 'semilla', activa: true, coincidencias: 0, evidencia: [], convocatorias: 0 });
    assert.equal(lista.parecidas.filter((p: any) => !p.activa).length, 9);
  });
});

describe('ventana desde 2022 y caché de series', () => {
  /** GREFA solo "ganó" la edición 2022 de proyectos ambientales (CAM); la 2026 (904719) se hace pasar por abierta. */
  function fetchSoloDosMilVeintidos(): typeof fetch {
    const base = fetchGrabado({ concesiones: true });
    return (async (entrada: string | URL | Request, init?: RequestInit) => {
      const url = String(entrada instanceof Request ? entrada.url : entrada);
      const res = await base(entrada, init);
      if (url.includes(`nifCif=${NIF_GREFA}`)) {
        const d = await res.json() as { content: { numeroConvocatoria: string }[] };
        return new Response(JSON.stringify({ ...d, content: d.content.filter((c) => c.numeroConvocatoria === '626301') }), { status: 200 });
      }
      if (url.includes('numConv=904719')) {
        const d = await res.json() as object;
        return new Response(JSON.stringify({ ...d, fechaFinSolicitud: '2026-09-30', abierto: true }), { status: 200 });
      }
      return res;
    }) as typeof fetch;
  }

  test('una victoria de 2022 lleva a descubrir la edición 2026 abierta (ventana por defecto desde 2022)', async () => {
    const db = bdParecidas();
    db.prepare('UPDATE organizaciones_parecidas SET activa = 0 WHERE nif = ?').run(NIF_BRINZAL);
    const r = await ejecutar(db, { fetch: fetchSoloDosMilVeintidos() });
    assert.equal(r.conErrores, false, JSON.stringify(r.parecidas?.errores));
    assert.deepEqual(ids(db), ['bdns:904719']);
    assert.deepEqual(origenesDe(db, 'bdns:904719').map((o) => [o.nif, o.numeroPrevio, o.anioPrevio]), [[NIF_GREFA, '626301', 2022]]);
    // Con una ventana más corta (desde 2024) esa serie no se mira.
    const db2 = bdParecidas();
    db2.prepare('UPDATE organizaciones_parecidas SET activa = 0 WHERE nif = ?').run(NIF_BRINZAL);
    await ejecutar(db2, { fetch: fetchSoloDosMilVeintidos(), parecidas: { desdeAnio: 2024 } });
    assert.deepEqual(ids(db2), []);
  });

  test('la migración invalida las búsquedas de series cacheadas con el texto anterior', async () => {
    const { abrirBd, migrar } = await import('../src/db/schema.ts');
    const db = abrirBd(':memory:');
    db.prepare("INSERT INTO consultas_concesiones (clave, consultado_en, total) VALUES ('serie:x', '2026-08-19T00:00:00Z', 0), ('conv:1', '2026-08-19T00:00:00Z', 3), ('parecida:G1', '2026-08-19T00:00:00Z', 1)").run();
    db.exec('DROP TABLE empresa_senales; DROP TABLE empresas; DROP TABLE dia_boe_procesadas; DROP TABLE boe_dias; DROP TABLE envios_resumen; DROP TABLE notas; DROP TABLE decisiones; PRAGMA user_version = 8'); // las migraciones posteriores se reaplican
    db.exec('DROP TABLE fundaciones; CREATE TABLE fundaciones (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL UNIQUE, url TEXT, notas TEXT, activa INTEGER NOT NULL DEFAULT 1)'); // forma anterior a la migración 12
    migrar(db);
    assert.deepEqual((db.prepare('SELECT clave FROM consultas_concesiones ORDER BY clave').all() as { clave: string }[]).map((c) => c.clave), ['conv:1', 'parecida:G1']);
  });

  test('la búsqueda por prefijo más amplio cuesta como mucho las páginas máximas por serie y respeta el tope compartido', async () => {
    const db = bdParecidas();
    const base = fetchGrabado({ concesiones: true });
    let busquedas = 0;
    const sinFin = (async (entrada: string | URL | Request, init?: RequestInit) => {
      const url = String(entrada instanceof Request ? entrada.url : entrada);
      if (url.includes('/convocatorias/busqueda')) {
        busquedas++;
        const fila = (i: number) => ({ numeroConvocatoria: String(7000000 + busquedas * 1000 + i), descripcion: 'X', fechaRecepcion: '2026-01-01', nivel1: 'ESTADO', nivel2: null, nivel3: null });
        return new Response(JSON.stringify({ content: [fila(1)], last: false }), { status: 200 });
      }
      return base(entrada, init);
    }) as typeof fetch;
    const r = await ejecutar(db, { fetch: sinFin, parecidas: { maxPeticiones: 40, pausaMs: 0 } });
    assert.ok(r.parecidas!.peticiones <= 40, `peticiones ${r.parecidas!.peticiones}`);
    assert.ok(busquedas <= 10 * r.parecidas!.series, 'cada serie pagina como mucho 10 veces');
    assert.ok(r.parecidas!.omitidasPorTope > 0);
  });
});
