// Domicilio social en el perfil (criba y análisis), orden de las empresas por zona, "empresas nuevas" relevantes y título corto de las ya analizadas.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { ordenarPorZona, leerEmpresas, registrarSenal } from '../src/db/empresas.ts';
import { guardarConvocatoria, guardarFase, leerFases, leerPerfil } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { promptAnalisis, promptCriba } from '../src/llm/prompts.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { guardarPerfilEditable, migrarDomicilio, reconsiderarVeredictos, validarPerfilEditable, versionCriba, versionLineas } from '../src/perfil.ts';
import { pistaDomicilio } from '../src/rules.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { leerSemilla, sembrarSiVacia } from '../src/seed.ts';
import type { Convocatoria, Perfil } from '../src/types.ts';
import { bdSembrada, RUTA_PUNTUACION, RUTA_SEMILLA, relojFijo } from './support/bd.ts';

const AHORA = new Date('2026-11-13T10:00:00Z');
const perfil = leerSemilla(RUTA_SEMILLA).perfil;
const USO = { entrada: 100, salida: 20, cacheLectura: 0, cacheEscritura: 0 };

function conv(id: string, titulo: string, organo: Convocatoria['organo']): Convocatoria {
  return { id: `bdns:${id}`, fuente: 'bdns', fuenteId: id, titulo, organo, fechaPublicacion: '2026-11-12', url: `https://example.org/${id}`, tipo: null, finalidad: null, regiones: ['ES30'], abierto: true, datos: {} };
}

describe('domicilio social en el perfil', () => {
  test('la semilla trae el domicilio de Reforesta y las criba/análisis lo dicen en el prompt', () => {
    assert.deepEqual(perfil.domicilio, { municipio: 'Tres Cantos', provincia: 'Madrid', comunidad: 'Comunidad de Madrid' });
    const c = conv('1', 'Subvenciones del distrito', { nivel1: 'LOCAL', nivel2: 'MADRID', nivel3: 'DISTRITO DE USERA' });
    const criba = promptCriba(perfil, c, null, [{ titulo: 'Ficha', texto: c.titulo }]);
    assert.match(criba.sistema, /La entidad tiene su domicilio social en: Tres Cantos \(Madrid\), Comunidad de Madrid\./);
    assert.match(criba.sistema, /exige domicilio, sede, empadronamiento o inscripción/);
    assert.match(promptAnalisis(perfil, c, [{ titulo: 'Ficha', texto: c.titulo }]).sistema, /domicilio social en: Tres Cantos/);
    // Sin domicilio en el perfil, el prompt no dice nada de él.
    assert.doesNotMatch(promptCriba({ ...perfil, domicilio: undefined }, c, null, []).sistema, /domicilio social en:/);
  });

  test('pista determinista: distrito o ayuntamiento distinto del domicilio; el propio municipio no lleva pista', () => {
    const usera = conv('2', 'Decreto de la Concejala Presidenta del Distrito de Usera por el que se aprueba la convocatoria', { nivel1: 'LOCAL', nivel2: 'MADRID', nivel3: 'DISTRITO DE USERA' });
    assert.match(pistaDomicilio(usera, perfil)!, /distrito «.*Usera.*»/i);
    const ciudadLineal = conv('3', 'Subvenciones del Distrito de Ciudad Lineal para entidades', { nivel1: 'LOCAL', nivel2: 'MADRID', nivel3: null });
    assert.match(pistaDomicilio(ciudadLineal, perfil)!, /Ciudad Lineal/);
    const alcala = conv('4', 'Bases de subvenciones', { nivel1: 'LOCAL', nivel2: 'ALCALÁ DE HENARES', nivel3: 'AYUNTAMIENTO DE ALCALÁ DE HENARES' });
    assert.match(pistaDomicilio(alcala, perfil)!, /ayuntamiento de ALCALÁ DE HENARES.*Tres Cantos/);
    const tresCantos = conv('5', 'Subvenciones a asociaciones 2027', { nivel1: 'LOCAL', nivel2: 'TRES CANTOS', nivel3: 'AYUNTAMIENTO DE TRES CANTOS' });
    assert.equal(pistaDomicilio(tresCantos, perfil), null);
    assert.equal(pistaDomicilio({ ...usera, organo: { nivel1: 'ESTADO', nivel2: null, nivel3: null } }, perfil), null);
    assert.equal(pistaDomicilio(usera, { ...perfil, domicilio: undefined }), null);
    // La pista llega al mensaje de la criba.
    assert.match(promptCriba(perfil, usera, null, []).mensaje, /Pista automática.*Usera/i);
    assert.doesNotMatch(promptCriba(perfil, tresCantos, null, []).mensaje, /Pista automática/);
  });

  test('migración: un perfil guardado sin domicilio lo recibe de la semilla y sus cribas quedan obsoletas (no se borran)', () => {
    const db = bdSembrada();
    const sin = { ...leerPerfil(db)! } as Partial<Perfil>;
    delete sin.domicilio;
    db.prepare('UPDATE perfil SET datos = ? WHERE id = 1').run(JSON.stringify(sin));
    guardarConvocatoria(db, { convocatoria: conv('9', 'Distrito de Usera', { nivel1: 'LOCAL', nivel2: 'MADRID', nivel3: 'DISTRITO DE USERA' }), descarte: null, condicion: null } as never, AHORA);
    guardarFase(db, { convocatoriaId: 'bdns:9', fase: 'criba_llm', descarta: false, motivo: 'vale', datos: { versionPerfil: versionCriba(sin as Perfil) } }, AHORA);

    assert.equal(migrarDomicilio(db, perfil, AHORA), true);
    assert.deepEqual(leerPerfil(db)!.domicilio, perfil.domicilio);
    assert.equal(migrarDomicilio(db, perfil, AHORA), false, 'idempotente');
    const r = reconsiderarVeredictos(db, leerPerfil(db)!);
    assert.equal(r.cribas, 1);
    assert.equal((leerFases(db, 'bdns:9').find((f) => f.fase === 'criba_llm')!.datos as { obsoleta?: boolean }).obsoleta, true);
    // Y por el arranque normal (sembrarSiVacia) también se completa.
    const db2 = bdSembrada();
    db2.prepare('UPDATE perfil SET datos = ? WHERE id = 1').run(JSON.stringify(sin));
    sembrarSiVacia(db2, RUTA_SEMILLA, AHORA);
    assert.deepEqual(leerPerfil(db2)!.domicilio, perfil.domicilio);
  });

  test('cambiar el domicilio cambia la versión de la criba (no la de un perfil sin domicilio, que conserva la suya)', () => {
    const otro = { ...perfil, domicilio: { ...perfil.domicilio!, distrito: 'Centro' } };
    assert.notEqual(versionCriba(perfil), versionCriba(otro));
    assert.notEqual(versionCriba(perfil), versionCriba({ ...perfil, domicilio: undefined }));
  });

  test('API: se lee, se edita en el perfil y se rechaza incompleto; sin enviarlo se conserva', async () => {
    const db = bdSembrada();
    const api = crearApi({ db, reloj: { now: () => AHORA } });
    const p = (await (await api.request('/perfil')).json()) as { domicilio: unknown; lineas: unknown; ambito: unknown; importeMinimo: unknown };
    assert.deepEqual(p.domicilio, perfil.domicilio);
    const put = (extra: object) => api.request('/perfil', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineas: p.lineas, ambito: p.ambito, importeMinimo: p.importeMinimo, ...extra }) });
    const r = await put({ domicilio: { municipio: ' Madrid ', provincia: 'Madrid', comunidad: 'Comunidad de Madrid', distrito: 'Usera' } });
    assert.equal(r.status, 200);
    assert.deepEqual(leerPerfil(db)!.domicilio, { municipio: 'Madrid', provincia: 'Madrid', comunidad: 'Comunidad de Madrid', distrito: 'Usera' });
    assert.equal((await put({ domicilio: { municipio: 'Madrid' } })).status, 400);
    assert.equal((await put({})).status, 200);
    assert.equal(leerPerfil(db)!.domicilio!.distrito, 'Usera', 'sin domicilio en el cuerpo no se toca');
    assert.throws(() => validarPerfilEditable({ lineas: [{ nombre: 'a', descripcion: 'b' }], ambito: { descripcion: 'x', nivelesSiempre: [], territorios: [{ comunidad: 'Madrid', provincias: [] }], regiones: [] }, domicilio: { municipio: '', provincia: 'x', comunidad: 'y' } }));
    guardarPerfilEditable(db, { lineas: perfil.lineas, ambito: perfil.ambito, importeMinimo: null }, AHORA);
    assert.ok(leerPerfil(db)!.domicilio, 'guardar sin domicilio no lo borra');
  });
});

/** Empresa del registro de huella (compensa) o DIA, con zona y día de inscripción. */
function empresa(db: DatabaseSync, nombre: string, o: { origen?: 'huella_carbono' | 'dia_boe'; zona: string; dia: string; vista?: Date }) {
  const origen = o.origen ?? 'huella_carbono';
  const boeId = origen === 'huella_carbono' ? `huella:${nombre}` : `BOE-${nombre}`;
  return registrarSenal(db, {
    nombre: `${nombre} SL`, cif: null, origen, motivo: 'motivo', cita: 'cita', provincia: o.zona,
    senal: { boeId, titulo: nombre, proyecto: null, provincia: o.zona, medidas: [{ tipo: origen === 'huella_carbono' ? 'registro_huella' : 'compensacion_habitat', cita: 'cita' }], enlace: 'https://example.org', fechaPublicacion: o.dia },
  }, o.vista ?? AHORA);
}

describe('empresas que compensan: orden por zona', () => {
  test('primero los territorios del perfil (Madrid, luego limítrofes), después el resto; dentro de cada zona, la compensación más reciente primero', () => {
    const db = bdSembrada();
    empresa(db, 'Gallega Vieja', { zona: 'Galicia', dia: '2026-10-30' });
    empresa(db, 'Madrid Antigua', { zona: 'Madrid, Comunidad de', dia: '2024-03-01' });
    empresa(db, 'Toledana', { zona: 'Castilla-La Mancha', dia: '2026-09-01' });
    empresa(db, 'Madrid Reciente', { zona: 'Madrid, Comunidad de', dia: '2026-06-01' });
    empresa(db, 'Gallega Nueva', { zona: 'Galicia', dia: '2026-11-10' });
    empresa(db, 'Segoviana', { zona: 'Segovia', dia: '2026-10-01' });
    empresa(db, 'Con DIA', { origen: 'dia_boe', zona: 'Soria', dia: '2026-01-01' });
    const nombres = (l: { nombre: string }[]) => l.map((e) => e.nombre.replace(' SL', ''));
    assert.deepEqual(nombres(leerEmpresas(db, { perfil: leerPerfil(db) })),
      ['Con DIA', 'Madrid Reciente', 'Madrid Antigua', 'Segoviana', 'Toledana', 'Gallega Nueva', 'Gallega Vieja']);
    // Sin perfil conserva el orden de siempre (por prioridad y primera vez vista).
    assert.equal(leerEmpresas(db)[0].nombre, 'Con DIA SL');
    assert.equal(ordenarPorZona([], perfil).length, 0);
  });

  test('la API de empresas lo sirve así', async () => {
    const db = bdSembrada();
    empresa(db, 'Fuera', { zona: 'Galicia', dia: '2026-11-10' });
    empresa(db, 'Casa', { zona: 'Madrid, Comunidad de', dia: '2020-01-01' });
    const api = crearApi({ db, reloj: { now: () => AHORA }, equipo: { password: null } });
    const r = (await (await api.request('/empresas')).json()) as { empresas: { nombre: string }[] };
    assert.deepEqual(r.empresas.map((e) => e.nombre), ['Casa SL', 'Fuera SL']);
  });
});

describe('"empresas nuevas" de Esta semana: solo las relevantes', () => {
  test('cuentan las de DIA y las que compensan dentro de los territorios del perfil; no el resto de lo visto por primera vez', async () => {
    const db = bdSembrada();
    const vista = new Date('2026-11-12T10:00:00Z');
    empresa(db, 'Madrid A', { zona: 'Madrid, Comunidad de', dia: '2026-01-01', vista });
    empresa(db, 'Segovia B', { zona: 'Segovia', dia: '2026-01-01', vista });
    empresa(db, 'Galicia C', { zona: 'Galicia', dia: '2026-01-01', vista });
    empresa(db, 'Cataluña D', { zona: 'Cataluña', dia: '2026-01-01', vista });
    empresa(db, 'Dia E', { origen: 'dia_boe', zona: 'Soria', dia: '2026-01-01', vista });
    empresa(db, 'Madrid vieja', { zona: 'Madrid, Comunidad de', dia: '2026-01-01', vista: new Date('2026-09-01T10:00:00Z') });
    const api = crearApi({ db, reloj: { now: () => AHORA }, puntuacion: leerConfigPuntuacion(RUTA_PUNTUACION), equipo: { password: null } });
    const s = (await (await api.request('/semana')).json()) as { resumen: { empresasNuevas: number } };
    assert.equal(s.resumen.empresasNuevas, 3, 'Madrid A, Segovia B y la de DIA; no Galicia ni Cataluña ni la vista hace meses');
  });
});

describe('título corto de las ya analizadas (Haiku, solo con el título oficial)', () => {
  function analizada(db: DatabaseSync, n: string, titulo: string, tituloCorto?: string) {
    guardarConvocatoria(db, { convocatoria: conv(n, titulo, { nivel1: 'ESTADO', nivel2: null, nivel3: null }), descarte: null, condicion: null } as never, AHORA);
    guardarFase(db, { convocatoriaId: `bdns:${n}`, fase: 'criba_llm', descarta: false, motivo: 'vale', datos: { versionPerfil: versionCriba(perfil) } }, AHORA);
    const campo = { valor: null, cita: null, documento: null };
    guardarFase(db, { convocatoriaId: `bdns:${n}`, fase: 'analisis', descarta: false, motivo: null, datos: { versionLineas: versionLineas(perfil), analisis: {
      elegibilidadEsfl: campo, importeMaximoProyecto: campo, importeTotal: campo, plazo: campo, cofinanciacion: campo, requisitos: [], lineas: [], ideaProyecto: null, correcciones: [],
      ...(tituloCorto ? { tituloCorto } : { tituloCorto: null }),
    } } }, AHORA);
  }
  const corto = (db: DatabaseSync, n: string) => (leerFases(db, `bdns:${n}`).find((f) => f.fase === 'analisis')!.datos as { analisis: { tituloCorto: string | null } }).analisis.tituloCorto;

  function llmFalso(responde: (titulo: string) => unknown) {
    const peticiones: PeticionLlm[] = [];
    const llm: Llm = {
      async generar(p) {
        peticiones.push(p);
        return { datos: responde(p.mensaje), modelo: p.modelo, uso: USO };
      },
    };
    return { llm, peticiones };
  }
  const deps = (db: DatabaseSync, llm: Llm, configLlm = {}) => ({ db, fetch: (() => { throw new Error('sin red'); }) as typeof fetch, reloj: relojFijo(AHORA), llm, fuentes: [], ganadores: false, parecidas: false, configLlm });

  test('rellena solo las que no lo tienen, con Haiku y un prompt mínimo; la segunda vez no llama; cuenta en el presupuesto', async () => {
    const db = bdSembrada();
    analizada(db, '1', 'CONVOCATORIA DE SUBVENCIONES PARA LA RESTAURACIÓN DE HÁBITATS 2027');
    analizada(db, '2', 'OTRA CONVOCATORIA', 'Ya tiene título');
    const { llm, peticiones } = llmFalso(() => ({ tituloCorto: 'Restauración de hábitats' }));
    const r = await ejecutarRadar(deps(db, llm), { diasAtras: 1 });
    const fase = r.fases.find((f) => f.fase === 'titulos_cortos')!;
    assert.equal(fase.procesadas, 1);
    assert.equal(peticiones.length, 1);
    assert.equal(peticiones[0].modelo, 'claude-haiku-5-5');
    assert.equal(peticiones[0].tarea, 'titulo');
    assert.ok(peticiones[0].mensaje.includes('RESTAURACIÓN DE HÁBITATS') && peticiones[0].mensaje.length < 300, 'solo el título oficial');
    assert.equal(corto(db, '1'), 'Restauración de hábitats');
    assert.equal(corto(db, '2'), 'Ya tiene título');
    assert.ok(fase.costeUsd > 0 && r.presupuesto.gastadoUsd >= fase.costeUsd, 'cuenta en el presupuesto de la ejecución');

    const r2 = await ejecutarRadar(deps(db, llm), { diasAtras: 1 });
    assert.equal(peticiones.length, 1, 'nada más que rellenar: no hay llamadas');
    assert.equal(r2.fases.some((f) => f.fase === 'titulos_cortos'), false);
  });

  test('la caché evita repetir la llamada, el presupuesto agotado lo deja pendiente y una respuesta mala conserva el título legible', async () => {
    const db = bdSembrada();
    analizada(db, '1', 'AYUDAS DE PRUEBA PARA ALGO');
    const mala = llmFalso(() => ({ tituloCorto: '' }));
    const r = await ejecutarRadar(deps(db, mala.llm), { diasAtras: 1 });
    const f = r.fases.find((x) => x.fase === 'titulos_cortos')!;
    assert.equal(f.procesadas, 0);
    assert.equal(f.errores.length, 1);
    assert.equal(corto(db, '1'), null, 'sin título corto: la web usa el oficial legible');

    const agotado = llmFalso(() => ({ tituloCorto: 'Ayudas de prueba' }));
    const r2 = await ejecutarRadar(deps(db, agotado.llm, { presupuestoUsd: 0 }), { diasAtras: 1 });
    assert.equal(agotado.peticiones.length, 0);
    assert.equal(r2.fases.find((x) => x.fase === 'titulos_cortos')!.omitidasPorTope, 1);

    const buena = llmFalso(() => ({ tituloCorto: 'Ayudas de prueba' }));
    await ejecutarRadar(deps(db, buena.llm), { diasAtras: 1 });
    assert.equal(corto(db, '1'), 'Ayudas de prueba');
  });
});
