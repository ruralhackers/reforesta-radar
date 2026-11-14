// Empresas que compran créditos de absorción, a través del motor: un extracto REAL de las compensaciones y los proyectos de absorción del MITECO
// (test/fixtures/compras/extracto.json, convertido en .xlsx de verdad), reloj fijo y sin LLM. Compradores derivados, unión con empresas de la huella y de las DIA,
// prioridad por territorio y recencia, y que no se une nunca a una empresa de otro CIF.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { derivarCompradores, FASE_COMPRAS, motivoCompra, type ConfigCompras } from '../src/fases/compras.ts';
import { leerEmpresas, registrarSenal } from '../src/db/empresas.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { codigoProyectoDe, leerListadoCompensacion, leerListadoProyectos, URL_COMPENSACION } from '../src/sources/huella.ts';
import type { Llm } from '../src/llm/llm.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdSembrada, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
import { xlsxCompensacionCompras, xlsxProyectos } from './support/compras.ts';
import { fetchHuella } from './support/huella.ts';

const AHORA = new Date('2026-11-14T09:00:00Z');
const PERFIL = leerSemilla(RUTA_SEMILLA).perfil;
const compensaciones = () => leerListadoCompensacion(xlsxCompensacionCompras());
const proyectos = () => leerListadoProyectos(xlsxProyectos());
const derivar = (ahora = AHORA, comp = compensaciones(), proy = proyectos()) => derivarCompradores(comp, proy, PERFIL, ahora);
const comprador = (nombre: string, ahora = AHORA) => derivar(ahora).compradores.find((c) => c.nombre === nombre)!;
const todas = (db: DatabaseSync) => leerEmpresas(db, { incluirBaja: true });
const fetchCompras = (o: Parameters<typeof fetchHuella>[0] = {}) => fetchHuella({ proyectos: xlsxProyectos(), compensacion: xlsxCompensacionCompras(), ...o });

/** La compra de absorciones no llama al LLM: solo lo usa la fase de huella (que dice «financiadora» a todo lo que se le enseña). */
const llmHuella: Llm = { async generar(p) { return { datos: { financiador: true, motivo: 'Compensa emisiones con proyectos de absorción, buen encaje.' }, modelo: p.modelo, uso: { entrada: 1_000, salida: 60, cacheLectura: 0, cacheEscritura: 0 } }; } };

function pasada(db: DatabaseSync, fetch: typeof globalThis.fetch, opciones: { huella?: boolean; compras?: Partial<ConfigCompras> | boolean; ahora?: Date } = {}) {
  return ejecutarRadar({ db, fetch, reloj: relojFijo(opciones.ahora ?? AHORA), fuentes: [], llm: opciones.huella ? llmHuella : { async generar() { throw new Error('La compra de absorciones no usa LLM'); } }, ganadores: false, parecidas: false, huella: opciones.huella ? {} : false, compras: opciones.compras ?? true }, { diasAtras: 1 });
}

describe('lectores del extracto real', () => {
  test('proyectos: código, provincia, CCAA y promotor; las compensaciones se unen por el código del proyecto', () => {
    const p = proyectos();
    const cantos = p.find((x) => x.provincia === 'Ávila' && x.promotor === 'EULEN, S.A.')!;
    assert.match(cantos.codigo, /^\d{4}-b\d{3}$/);
    assert.equal(cantos.ccaa, 'Castilla y León');
    assert.equal(cantos.baja, false);
    const comps = compensaciones();
    const porCodigo = new Set(p.map((x) => x.codigo));
    assert.ok(comps.filter((c) => porCodigo.has(codigoProyectoDe(c))).length > comps.length / 2);
    assert.ok(comps.every((c) => /^\d{4}-c\d{3}$/.test(c.codigo) && /^\d{4}-b/.test(c.toneladas)));
    assert.throws(() => leerListadoProyectos(xlsxCompensacionCompras()), /no tiene la hoja/);
  });
});

describe('compradores derivados', () => {
  test('ENAGÁS: compra en un proyecto de Madrid; el motivo y la cita salen literales del registro', () => {
    const e = comprador('ENAGÁS, S.A.');
    assert.equal(e.enTerritorio, true);
    assert.equal(e.principal.proyecto?.provincia, 'Madrid');
    assert.equal(e.principal.proyecto?.promotor, 'GRUPO SYLVESTRIS, S.L.');
    assert.match(motivoCompra(e), /^Compensó [\d.,]+ tCO2 en 20\d\d con el proyecto de absorción «[^»]+» \(Madrid\); 4 compensaciones más, [\d.,]+ tCO2 en total$/);
    assert.equal(e.tco2Total, e.compras.reduce((s, c) => s + Number(c.compensacion.tco2), 0));
  });

  test('descartes: sin forma jurídica (GRUPO OHLA), administraciones (Mancomunidad) y quien solo compensa en proyectos que promueve él mismo', () => {
    const d = derivar();
    const nombres = d.compradores.map((c) => c.nombre);
    assert.ok(!nombres.includes('GRUPO OHLA') && d.sinFormaJuridica === 1);
    assert.ok(!nombres.some((n) => /MANCOMUNIDAD/.test(n)) && d.administraciones === 1);
    // EULEN promueve proyectos y también compra uno ajeno: de sus compras solo cuenta la ajena.
    assert.equal(comprador('EULEN, S.A.').compras.every((c) => c.proyecto?.promotor !== 'EULEN, S.A.'), true);
    // Si todo lo que compensa es de su propio proyecto, no es comprador.
    const ps = proyectos();
    const deEulen = new Set(ps.filter((p) => p.promotor === 'EULEN, S.A.').map((p) => p.codigo));
    const comps = compensaciones().filter((c) => deEulen.has(codigoProyectoDe(c))).slice(0, 2).map((c) => ({ ...c, organizacion: 'EULEN, S.A.' }));
    assert.equal(comps.length, 2);
    const solo = derivarCompradores(comps, ps, PERFIL, AHORA);
    assert.equal(solo.compradores.length, 0);
    assert.equal(solo.soloProyectosPropios, 1);
  });

  test('prioridad 2 si compró en un proyecto de los territorios (aunque sea antiguo) o hace menos de dos años; si no, 1', () => {
    const kaura = comprador('KAURA COPRODUCTS, S.L.');
    assert.equal(kaura.compras[0].compensacion.fecha.slice(0, 4), '2023');
    assert.deepEqual([kaura.enTerritorio, kaura.reciente, kaura.prioridad], [true, false, 2]); // Ávila, compra de 2023
    const crisma = comprador('CRISMACHEM, S.L.');
    assert.deepEqual([crisma.enTerritorio, crisma.reciente, crisma.prioridad], [false, true, 2]); // Pontevedra, 2025
    const fal = comprador('FAL CALZADOS DE SEGURIDAD, S.A.');
    assert.deepEqual([fal.enTerritorio, fal.reciente, fal.prioridad], [false, false, 1]); // La Rioja, 2023
    // Con el reloj en 2029 ya no hay compras recientes: solo cuentan las de territorio.
    assert.equal(comprador('CRISMACHEM, S.L.', new Date('2029-01-01T00:00:00Z')).prioridad, 1);
    assert.equal(comprador('KAURA COPRODUCTS, S.L.', new Date('2029-01-01T00:00:00Z')).prioridad, 2);
  });

  test('una comunidad con solo algunas provincias en el perfil (Castilla y León) no cuenta entera: Palencia está fuera, Ávila dentro', () => {
    const ps = proyectos();
    const palencia = ps.find((p) => p.provincia === 'Palencia')!;
    const avila = ps.find((p) => p.provincia === 'Ávila')!;
    const base = compensaciones()[0];
    const un = (p: typeof palencia) => derivarCompradores([{ ...base, organizacion: 'COMPRADORA TEST, S.L.', toneladas: `${p.codigo}/00001`, fecha: '2020-01-01' }], ps, PERFIL, AHORA).compradores[0];
    assert.equal(un(palencia).enTerritorio, false);
    assert.equal(un(avila).enTerritorio, true);
  });
});

describe('fase por el motor', () => {
  test('guarda los compradores sin LLM: motivo, cita literal, enlace al listado, provincia del proyecto y promotor; las de baja confianza quedan ocultas', async () => {
    const db = bdSembrada();
    const r = await pasada(db, fetchCompras());
    assert.deepEqual(r.compras!.errores, []);
    const c = r.compras!;
    assert.equal(c.compensacionesLeidas, 82);
    assert.equal(c.proyectosLeidos, 44);
    assert.equal(c.compradores, 11);
    assert.equal(c.relevantes, 9);
    assert.equal(c.enTerritorio, 3); // ALSA, KAURA y ENAGÁS
    assert.equal(c.empresasNuevas.length, 11);
    assert.equal(r.fases.find((f) => f.fase === FASE_COMPRAS)!.costeUsd, 0);

    const enagas = leerEmpresas(db).find((e) => e.nombre === 'ENAGÁS, S.A.')!;
    assert.equal(enagas.prioridad, 2);
    assert.equal(enagas.origen, 'compra_absorcion');
    assert.equal(enagas.provincia, 'Madrid');
    assert.equal(enagas.enlace, URL_COMPENSACION);
    assert.match(enagas.cita, /^COMPENSACIÓN: ENAGÁS, S\.A\. \| AÑO DE LA HUELLA COMPENSADA: \d{4} \| PROYECTO DE ABSORCIÓN: .+ \| FECHA DE LA COMPENSACIÓN: \d{4}-\d\d-\d\d$/);
    const s = enagas.senales[0];
    assert.equal(s.tipo, 'compra_absorcion');
    assert.match(s.proyecto ?? '', /\(.*Madrid\), promovido por GRUPO SYLVESTRIS, S\.L\.$/);
    assert.deepEqual(s.medidas.map((m) => m.tipo), ['compensacion', 'proyecto_absorcion']);
    assert.match(s.medidas[1].cita, /PROMOTOR: GRUPO SYLVESTRIS, S\.L\./);

    const visibles = leerEmpresas(db).map((e) => e.nombre);
    assert.ok(!visibles.includes('FAL CALZADOS DE SEGURIDAD, S.A.') && !visibles.includes('CALZADOS FAL, S.A.'));
    assert.equal(todas(db).find((e) => e.nombre === 'FAL CALZADOS DE SEGURIDAD, S.A.')!.prioridad, 1);
    assert.ok(!todas(db).some((e) => /MANCOMUNIDAD|OHLA/.test(e.nombre)));
  });

  test('idempotente: repetir la pasada no duplica empresas ni señales', async () => {
    const db = bdSembrada();
    await pasada(db, fetchCompras());
    const antes = todas(db).map((e) => [e.nombre, e.senales.length]);
    const r = await pasada(db, fetchCompras());
    assert.equal(r.compras!.empresasNuevas.length, 0);
    assert.equal(r.compras!.empresasUnidas.length, 11);
    assert.deepEqual(todas(db).map((e) => [e.nombre, e.senales.length]), antes);
  });

  test('si el MITECO falla, queda como error de la fase y no se guarda nada', async () => {
    const db = bdSembrada();
    const r = await pasada(db, fetchCompras({ fallo: { compensacion: 503 } }));
    assert.match(r.compras!.errores[0], /Compra de absorciones.*503/);
    assert.equal(todas(db).length, 0);
  });

  test('unión con una empresa de la huella: FCC es una sola fila con las dos señales y el CIF de la huella', async () => {
    const db = bdSembrada();
    await pasada(db, fetchCompras(), { huella: true });
    const fcc = todas(db).filter((e) => /^FCC CONSTRUCCI/.test(e.nombre));
    assert.equal(fcc.length, 1);
    assert.deepEqual(fcc[0].senales.map((s) => s.tipo).sort(), ['compra_absorcion', 'huella_carbono']);
    assert.equal(fcc[0].cif, 'A28854727');
    assert.equal(fcc[0].prioridad, 2);
  });

  test('una empresa de baja confianza que compró en territorio sube a visible y su motivo pasa a ser el de la compra', async () => {
    const db = bdSembrada();
    registrarSenal(db, {
      nombre: 'Alsa Grupo, S.L.U.', cif: null, origen: 'huella_carbono', prioridad: 1, motivo: 'Registro de huella de carbono (MITECO), 2025: gran empresa; no consta compensación (baja confianza)', cita: 'x', provincia: 'Asturias',
      senal: { boeId: 'huella:alsa grupo slu', titulo: 't', proyecto: null, provincia: 'Asturias', medidas: [], enlace: 'https://www.miteco.gob.es/x', fechaPublicacion: '2026-10-01' },
    }, AHORA);
    assert.equal(leerEmpresas(db).length, 0);
    await pasada(db, fetchCompras());
    const alsa = leerEmpresas(db).find((e) => /^alsa grupo/i.test(e.nombre))!;
    assert.equal(alsa.prioridad, 2);
    assert.match(alsa.motivo, /^Compensó/);
    assert.equal(alsa.senales.length, 2);
    assert.equal(todas(db).filter((e) => /alsa grupo/i.test(e.nombre)).length, 1);
  });

  test('una empresa con DIA que además compra absorciones sigue en prioridad 3', async () => {
    const db = bdSembrada();
    registrarSenal(db, { nombre: 'Enagás, S.A.', cif: 'A28294726', origen: 'dia_boe', motivo: 'DIA', cita: 'c', provincia: 'Soria', senal: { boeId: 'BOE-A-2026-1', titulo: 't', proyecto: null, provincia: 'Soria', medidas: [], enlace: 'https://www.boe.es/x', fechaPublicacion: '2026-11-01' } }, AHORA);
    await pasada(db, fetchCompras());
    const e = leerEmpresas(db).filter((x) => /^enag/i.test(x.nombre));
    assert.equal(e.length, 1);
    assert.equal(e[0].prioridad, 3);
    assert.equal(e[0].cif, 'A28294726'); // el listado no trae NIF: no lo toca
    assert.deepEqual(e[0].senales.map((s) => s.tipo).sort(), ['compra_absorcion', 'dia_boe']);
  });

  test('nunca se une a empresas de CIF distinto: con dos empresas del mismo nombre y CIF diferentes, la compra no va a ninguna', async () => {
    const db = bdSembrada();
    const dia = (cif: string, id: string) => registrarSenal(db, { nombre: 'Enagás, S.A.', cif, origen: 'dia_boe', motivo: 'DIA', cita: 'c', provincia: 'Soria', senal: { boeId: id, titulo: 't', proyecto: null, provincia: 'Soria', medidas: [], enlace: 'https://www.boe.es/x', fechaPublicacion: '2026-11-01' } }, AHORA);
    dia('A28294726', 'BOE-A-2026-1');
    dia('A58217029', 'BOE-A-2026-2');
    assert.equal(todas(db).filter((e) => /^enag/i.test(e.nombre)).length, 2);
    const r = await pasada(db, fetchCompras());
    assert.equal(r.compras!.ambiguos, 1);
    assert.equal(r.compras!.empresasNuevas.length, 10);
    const e = todas(db).filter((x) => /^enag/i.test(x.nombre));
    assert.equal(e.length, 2);
    assert.ok(e.every((x) => x.senales.every((s) => s.tipo === 'dia_boe')));
    assert.ok(r.compras!.fase.avisos.some((a) => /ENAGÁS.*CIF distintos/.test(a)));
  });

  test('el orden del grupo «compensan»: las compras en territorio van antes que las de fuera', async () => {
    const db = bdSembrada();
    await pasada(db, fetchCompras());
    const orden = leerEmpresas(db, { perfil: PERFIL }).map((e) => e.nombre);
    const pos = (n: string) => orden.indexOf(n);
    assert.ok(pos('ENAGÁS, S.A.') < pos('CRISMACHEM, S.L.') && pos('KAURA COPRODUCTS, S.L.') < pos('URBASER, S.A.'));
  });
});
