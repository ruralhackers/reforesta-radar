// Perfil editable: API (lectura, escritura, validación) y el efecto en la siguiente ejecución del motor.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { leerFases, leerPerfil } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm } from '../src/llm/llm.ts';
import { guardarPerfilEditable, versionLineas, type PerfilEditable, validarPerfilEditable } from '../src/perfil.ts';
import { leerPuntuacion } from '../src/db/repo.ts';
import { guardarFase } from '../src/db/repo.ts';
import { bdSembrada, RUTA_PUNTUACION, relojFijo } from './support/bd.ts';
import { ESCENARIOS, fetchGrabado } from './support/grabaciones.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';

const AHORA = new Date('2026-11-13T10:00:00Z');

function editable(db: DatabaseSync): PerfilEditable {
  const p = leerPerfil(db)!;
  return { lineas: p.lineas, ambito: { ...p.ambito }, importeMinimo: p.importeMinimo };
}

const put = (api: ReturnType<typeof crearApi>, cuerpo: unknown) =>
  api.request('/perfil', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo) });

describe('API del perfil', () => {
  test('GET lee el perfil de la semilla y PUT lo guarda en la BD', async () => {
    const db = bdSembrada();
    const api = crearApi({ db, reloj: { now: () => AHORA } });
    const leido = await (await api.request('/perfil')).json() as { nif: string; lineas: unknown[]; importeMinimo: number; ambito: { territorios: { comunidad: string; provincias: string[] }[] } };
    assert.equal(leido.nif, 'G80428204');
    assert.equal(leido.importeMinimo, 3000);
    assert.deepEqual(leido.ambito.territorios.map((t) => t.comunidad), ['Comunidad de Madrid', 'Castilla y León', 'Castilla-La Mancha']);

    const nuevo = {
      lineas: [{ nombre: ' Agua ', descripcion: 'Charcas' }],
      ambito: { descripcion: 'Solo Madrid', nivelesSiempre: ['estado'], territorios: [{ comunidad: ' Comunidad de Madrid ', provincias: [' Segovia '] }], regiones: ['es30'] },
      importeMinimo: 10000,
    };
    const res = await put(api, nuevo);
    assert.equal(res.status, 200);
    const guardado = leerPerfil(db)!;
    assert.deepEqual(guardado.lineas, [{ nombre: 'Agua', descripcion: 'Charcas' }]);
    assert.deepEqual(guardado.ambito.nivelesSiempre, ['ESTADO']);
    assert.deepEqual(guardado.ambito.regiones, ['ES30']);
    assert.deepEqual(guardado.ambito.territorios, [{ comunidad: 'Comunidad de Madrid', provincias: ['Segovia'] }]);
    assert.deepEqual(guardado.ambito.comunidades, [], 'las comunidades enteras se derivan de los territorios (Madrid lleva Segovia aquí: no está entera)');
    assert.equal(guardado.importeMinimo, 10000);
    // NIF, idPersona y finalidades excluidas no se tocan
    assert.equal(guardado.nif, 'G80428204');
    assert.ok(guardado.finalidadesExcluidas.length > 0);
    assert.equal((await (await api.request('/perfil')).json() as { importeMinimo: number }).importeMinimo, 10000);
  });

  test('PUT rechaza lo no válido con 400 y mensaje en castellano, sin guardar nada', async () => {
    const db = bdSembrada();
    const api = crearApi({ db, reloj: { now: () => AHORA } });
    const antes = JSON.stringify(leerPerfil(db));
    const base = editable(db);
    const casos: [unknown, RegExp][] = [
      ['no es json', /JSON/],
      [{ ...base, lineas: [] }, /al menos una línea/],
      [{ ...base, lineas: [{ nombre: '  ', descripcion: 'x' }] }, /necesita un nombre/],
      [{ ...base, lineas: [{ nombre: 'A', descripcion: '' }] }, /necesita una descripción/],
      [{ ...base, lineas: 'texto' }, /al menos una línea/],
      [{ ...base, importeMinimo: -1 }, /negativo/],
      [{ ...base, importeMinimo: 'mucho' }, /número/],
      [{ ...base, ambito: { ...base.ambito, regiones: ['Madrid'] } }, /NUTS/],
      [{ ...base, ambito: { ...base.ambito, nivelesSiempre: ['MARTE'] } }, /niveles/],
      [{ ...base, ambito: { ...base.ambito, territorios: [] } }, /al menos un territorio/],
      [{ ...base, ambito: { ...base.ambito, territorios: [{ comunidad: ' ', provincias: [] }] } }, /necesita una comunidad/],
      [{ ...base, ambito: { ...base.ambito, territorios: [{ comunidad: 'Galicia', provincias: [''] }] } }, /vacíos/],
    ];
    for (const [cuerpo, re] of casos) {
      const res = await put(api, cuerpo);
      assert.equal(res.status, 400, JSON.stringify(cuerpo).slice(0, 80));
      assert.match((await res.json() as { error: string }).error, re);
    }
    assert.equal(JSON.stringify(leerPerfil(db)), antes);
    assert.equal(validarPerfilEditable({ ...base, importeMinimo: null }).importeMinimo, null, 'sin mínimo es válido');
  });
});

describe('el perfil editado cambia la siguiente ejecución', () => {
  const e = ESCENARIOS.agosto2026;
  const estado = (db: DatabaseSync, n: string) =>
    db.prepare('SELECT descarte_regla AS r FROM convocatorias WHERE id = ?').get(`bdns:${n}`) as { r: string | null };

  test('ámbito: añadir un territorio recupera lo de esa comunidad, y quitar el nivel ESTADO descarta lo que antes entraba', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(e.ahora);
    const deps = { db, fetch: fetchGrabado(), reloj };
    const ejecutar = async () => { reloj.adelantar(3600_000); await ejecutarRadar(deps, { diasAtras: e.diasAtras }); };
    await ejecutar();
    assert.equal(estado(db, '923229').r, 'ambito', 'Extremadura no está en el ámbito de actuación');
    assert.equal(estado(db, '923290').r, null, 'MITECO (ESTADO) entra');

    const original = editable(db);
    guardarPerfilEditable(db, { ...original, ambito: { ...original.ambito, territorios: [...original.ambito.territorios, { comunidad: 'Extremadura', provincias: [] }], nivelesSiempre: [] } }, reloj.now());
    await ejecutar();
    assert.equal(estado(db, '923229').r, null, 'con Extremadura como territorio, su convocatoria vuelve (reglas reaplicadas a lo guardado)');
    assert.equal(estado(db, '923290').r, 'ambito', 'sin ESTADO siempre admitido, el Ministerio queda fuera');

    guardarPerfilEditable(db, original, reloj.now());
    await ejecutar();
    assert.equal(estado(db, '923229').r, 'ambito');
    assert.equal(estado(db, '923290').r, null);
  });

  test('importe mínimo: cambia la puntuación de lo ya analizado en la siguiente ejecución', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(e.ahora);
    const deps = { db, fetch: fetchGrabado(), reloj, puntuacion: leerConfigPuntuacion(RUTA_PUNTUACION) };
    await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    const campo = (valor: string | null) => ({ valor, cita: valor, documento: valor ? 'D' : null });
    guardarFase(db, { convocatoriaId: 'bdns:923290', fase: 'criba_llm', descarta: false, motivo: 'ok', datos: {} }, reloj.now());
    guardarFase(db, { convocatoriaId: 'bdns:923290', fase: 'analisis', descarta: false, motivo: null, datos: { analisis: {
      elegibilidadEsfl: campo('si'), importeMaximoProyecto: campo('5.000 euros'), importeTotal: campo(null), plazo: campo(null),
      cofinanciacion: campo(null), requisitos: [], lineas: [], ideaProyecto: null, tituloCorto: 'Título corto de prueba', correcciones: [],
    } } }, reloj.now());
    const importe = () => leerPuntuacion(db, 'bdns:923290')!.factores.find((f) => f.id === 'importe')!.subpuntuacion;

    reloj.adelantar(3600_000);
    await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    const con3000 = importe();
    assert.ok(con3000 > 0, '5.000 € supera el mínimo de 3.000 €');

    guardarPerfilEditable(db, { ...editable(db), importeMinimo: 20000 }, reloj.now());
    reloj.adelantar(3600_000);
    await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    assert.equal(importe(), 0, '5.000 € queda por debajo de 20.000 €');
  });

  test('líneas o ámbito cambiados: los veredictos de la criba se rehacen; el análisis solo si cambian las líneas', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(e.ahora);
    let cribas = 0;
    const llm: Llm = {
      async generar(p) {
        if (p.tarea === 'criba') { cribas++; return { datos: { decision: 'puede_encajar', motivo: 'vale', exigeSedeEnOtraComunidad: 'no_aplica' }, modelo: p.modelo, uso: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 } }; }
        throw new Error('sin análisis en este test');
      },
    };
    const deps = { db, fetch: fetchGrabado(), reloj, llm, configLlm: { maxAnalisis: 0 } };
    const ejecutar = async () => { reloj.adelantar(3600_000); await ejecutarRadar(deps, { diasAtras: e.diasAtras }); };

    await ejecutar();
    const primera = cribas;
    assert.ok(primera > 0);
    await ejecutar();
    assert.equal(cribas, primera, 'sin cambios no se vuelve a cribar');
    const versionAntes = leerFases(db, 'bdns:923290').find((f) => f.fase === 'criba_llm')!.datos;

    // Un análisis ya hecho con las líneas actuales: se conserva si solo cambia el ámbito, se invalida si cambian las líneas.
    const ed = editable(db);
    guardarFase(db, { convocatoriaId: 'bdns:923290', fase: 'analisis', descarta: false, motivo: null, datos: { analisis: {}, versionLineas: versionLineas(leerPerfil(db)!) } }, reloj.now());
    guardarPerfilEditable(db, { ...ed, ambito: { ...ed.ambito, descripcion: 'Otro ámbito distinto' } }, reloj.now());
    await ejecutar();
    assert.ok(cribas > primera, 'cambiar el ámbito hace que se criben de nuevo');
    assert.notDeepEqual(leerFases(db, 'bdns:923290').find((f) => f.fase === 'criba_llm')!.datos, versionAntes);
    assert.ok(leerFases(db, 'bdns:923290').find((f) => f.fase === 'analisis'), 'el análisis se conserva: las líneas no cambiaron');

    const antesLineas = cribas;
    guardarPerfilEditable(db, { ...editable(db), lineas: [{ nombre: 'Nueva', descripcion: 'otra' }] }, reloj.now());
    await ejecutar();
    assert.ok(cribas > antesLineas, 'cambiar las líneas también rehace la criba');
    const analisis = leerFases(db, 'bdns:923290').find((f) => f.fase === 'analisis');
    assert.equal((analisis?.datos as { obsoleta?: boolean }).obsoleta, true, 'cambiar las líneas deja el análisis obsoleto (no se borra; se rehace cuando se pueda)');
  });
});
