// Ganadores previos y organizaciones parecidas: motor con concesiones reales grabadas de BDNS (825309, 782630, 703977, 626301,
// Reforesta por NIF), la búsqueda de ediciones y la convocatoria 2026 (904719), que aún no tiene concesiones.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { anioDelTitulo, claveSerie, leerBeneficiario, tituloSinAnio } from '../src/concesiones.ts';
import { leerParecidas } from '../src/db/ganadores.ts';
import { guardarConvocatoria } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { promptAnalisis } from '../src/llm/prompts.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdns } from '../src/sources/bdns.ts';
import type { Fuente } from '../src/sources/source.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, RUTA_PUNTUACION, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
import { fetchGrabado } from './support/grabaciones.ts';

const perfil = leerSemilla(RUTA_SEMILLA).perfil;
const AHORA = new Date('2026-11-13T09:00:00Z');
const ORGANO = { nivel1: 'AUTONOMICA', nivel2: 'COMUNIDAD DE MADRID', nivel3: 'CONSEJERÍA DE MEDIO AMBIENTE, AGRICULTURA E INTERIOR' };

const conv = (numero: string, titulo: string, fecha: string): Convocatoria => ({
  id: `bdns:${numero}`, fuente: 'bdns', fuenteId: numero, titulo, organo: ORGANO, fechaPublicacion: fecha,
  url: `https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/${numero}`, tipo: null, finalidad: null, regiones: ['ES30'], abierto: false, datos: {},
});
const CONV_2026 = conv('904719', 'SUBVENCIÓN ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES 2026', '2026-05-11');

/** La fuente BDNS sin nada nuevo que recoger (la candidata ya está guardada) y con el texto de la ficha. */
const fuente: Fuente = { ...bdns, recoger: async () => ({ cribadas: [], errores: [] }), documentos: (c) => [{ titulo: 'Ficha', url: null, texto: c.titulo }] };

function bdConCandidata(fechaPublicacion = CONV_2026.fechaPublicacion): DatabaseSync {
  const db = bdSembrada();
  guardarConvocatoria(db, { convocatoria: { ...CONV_2026, fechaPublicacion }, descarte: null }, AHORA);
  return db;
}

const deps = (db: DatabaseSync, extra: object = {}) => ({ db, fetch: fetchGrabado({ concesiones: true }), reloj: relojFijo(AHORA), fuentes: [fuente], ...extra });

describe('piezas puras', () => {
  test('beneficiario: entidades con NIF, personas anonimizadas sin él', () => {
    assert.deepEqual(leerBeneficiario('G78456118 GREFA'), { nif: 'G78456118', nombre: 'GREFA', esPersona: false });
    const p = leerBeneficiario('***7841** JUAN PEREZ GARCIA');
    assert.equal(p.nif, null);
    assert.equal(p.esPersona, true);
  });

  test('serie: mismo título y órgano salvo el año y los acentos', () => {
    const a = claveSerie('SUBVENCION ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES 2022', ORGANO);
    const b = claveSerie('SUBVENCIÓN ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES 2026', ORGANO);
    assert.ok(a);
    assert.equal(a, b);
    assert.notEqual(a, claveSerie('SUBVENCIÓN ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES 2026', { ...ORGANO, nivel2: 'OTRA' }));
    assert.equal(claveSerie('Ayudas 2026', ORGANO), null);
    assert.equal(tituloSinAnio('Proyectos 2025 ambientales'), 'Proyectos ambientales');
    assert.equal(anioDelTitulo('Proyectos 2025'), 2025);
  });
});

describe('motor con concesiones grabadas', () => {
  test('organizaciones parecidas: co-ganadoras de lo que ganó Reforesta, con origen calculada', async () => {
    const db = bdConCandidata();
    const r = await ejecutarRadar(deps(db));
    assert.equal(r.conErrores, false, JSON.stringify(r.ganadores?.errores));
    assert.equal(r.ganadores?.consultas, 7);
    const p = leerParecidas(db);
    const porNif = new Map(p.map((x) => [x.nif, x]));
    for (const nif of ['G78456118', 'G78616893', 'G28795961']) { // GREFA, Brinzal, SEO/BirdLife
      assert.ok(porNif.has(nif), `falta ${nif}`);
      assert.equal(porNif.get(nif)!.origen, 'calculada');
      assert.equal(porNif.get(nif)!.activa, true);
    }
    assert.equal(porNif.get('G78456118')!.nombre, 'GREFA'); // conserva el nombre de la semilla
    assert.equal(porNif.has('G80428204'), false, 'Reforesta no es parecida a sí misma');
    assert.ok(p.every((x) => !x.nombre.startsWith('*')), 'sin personas anonimizadas');
    // Ordenadas por coincidencias: Brinzal ganó las tres ediciones de Reforesta.
    assert.equal(porNif.get('G78616893')!.coincidencias, 3);
    assert.deepEqual(porNif.get('G78616893')!.evidencia, ['626301', '782630', '825309']);
    assert.ok(p[0].coincidencias >= p[p.length - 1].coincidencias);
  });

  test('segunda pasada: todo en caché; lo manual y lo desactivado sobreviven al recálculo', async () => {
    const db = bdConCandidata();
    await ejecutarRadar(deps(db));
    db.prepare("INSERT INTO organizaciones_parecidas (nif, nombre, origen) VALUES ('G11111111', 'Mi amiga', 'manual')").run();
    db.prepare("UPDATE organizaciones_parecidas SET activa = 0 WHERE nif = 'G28795961'").run();
    const r = await ejecutarRadar(deps(db));
    assert.equal(r.ganadores?.consultas, 0);
    assert.equal(r.ganadores?.desdeCache, 7);
    const porNif = new Map(leerParecidas(db).map((x) => [x.nif, x]));
    assert.equal(porNif.get('G11111111')?.origen, 'manual');
    assert.equal(porNif.get('G28795961')?.activa, false);
    assert.equal(leerParecidas(db, true).some((x) => x.nif === 'G28795961'), false);
  });

  test('sin red las consultas fallan sin cortar la ejecución ni borrar lo anterior', async () => {
    const db = bdConCandidata();
    await ejecutarRadar(deps(db));
    const antes = leerParecidas(db).length;
    const r = await ejecutarRadar(deps(db, { fetch: (() => Promise.reject(new Error('sin red'))) as typeof fetch, ganadores: { diasCache: 0 } }));
    assert.ok(r.conErrores);
    assert.ok((r.ganadores?.errores.length ?? 0) > 0);
    assert.equal(leerParecidas(db).length, antes);
  });

  test('ganadores: false salta la fase', async () => {
    const db = bdConCandidata();
    const r = await ejecutarRadar(deps(db, { ganadores: false }));
    assert.equal(r.ganadores, null);
  });
});

describe('ficha, probabilidad y análisis', () => {
  async function api() {
    const db = bdConCandidata();
    await ejecutarRadar(deps(db));
    return { db, app: crearApi({ db, reloj: relojFijo(AHORA), fuentes: [fuente], puntuacion: leerConfigPuntuacion(RUTA_PUNTUACION) }) };
  }

  test('la ficha de la edición 2026 enseña quién ganó antes y que Reforesta ganó 2025, 2024 y 2022', async () => {
    const { app } = await api();
    const ficha = await (await app.request('/convocatorias/bdns:904719')).json() as any;
    const g = ficha.ganadoresPrevios;
    assert.equal(g.esSerie, true);
    assert.deepEqual(g.ediciones.map((e: any) => e.anio), [2025, 2024, 2023, 2022]);
    const e2025 = g.ediciones[0];
    assert.equal(e2025.numeroConvocatoria, '825309');
    assert.equal(e2025.ganadores.length, 19);
    assert.equal(e2025.reforesta, 'gano');
    assert.equal(e2025.importeReforesta, 29378.15);
    assert.ok(e2025.ganadores.some((w: any) => w.nombre.includes('BRINZAL') && w.esParecida));
    // 2023: hay 13 ganadores y Reforesta no está; se dice "no figura", nunca "perdió".
    assert.equal(g.ediciones[2].reforesta, 'no_figura');
    assert.deepEqual(g.reforestaGano.map((x: any) => x.anio), [2025, 2024, 2022]);
    assert.ok(g.parecidas.some((p: any) => p.nombre === 'GREFA'));
    assert.ok(!JSON.stringify(ficha).includes('perdió'));
  });

  test('probabilidad sube con el historial propio y las parecidas, y lo explica en castellano', async () => {
    const { app } = await api();
    const ficha = await (await app.request('/convocatorias/bdns:904719')).json() as any;
    const f = ficha.puntuacion.factores.find((x: any) => x.id === 'probabilidad');
    assert.equal(f.conocido, true);
    assert.ok(f.subpuntuacion >= 0.9, String(f.subpuntuacion));
    assert.match(f.explicacion, /Reforesta ganó las ediciones 2025 \(29\.378,15 €\), 2024 \(29\.076,85 €\) y 2022 \(50\.532,31 €\)/);
    assert.match(f.explicacion, /La ganaron .* \(la más reciente, en 2025\)/);
  });

  test('sin ganadores previos la probabilidad es neutral y lo dice', async () => {
    const db = bdSembrada();
    guardarConvocatoria(db, { convocatoria: conv('999001', 'Convocatoria única sin historia', '2026-11-10'), descarte: null }, AHORA);
    const app = crearApi({ db, reloj: relojFijo(AHORA), fuentes: [fuente], puntuacion: leerConfigPuntuacion(RUTA_PUNTUACION) });
    const ficha = await (await app.request('/convocatorias/bdns:999001')).json() as any;
    const f = ficha.puntuacion.factores.find((x: any) => x.id === 'probabilidad');
    assert.equal(f.conocido, false);
    assert.match(f.explicacion, /^desconocida: sin ganadores previos conocidos/);
    assert.deepEqual(ficha.ganadoresPrevios.ediciones, []);
  });

  test('el análisis de una convocatoria nueva recibe los ganadores previos como contexto', async () => {
    const db = bdConCandidata('2026-11-10'); // dentro de la ventana de pendientes del análisis
    const peticiones: PeticionLlm[] = [];
    const llm: Llm = {
      async generar(p) {
        peticiones.push(p);
        const vacio = { valor: null, cita: null, documento: null };
        const datos = p.tarea === 'criba' ? { decision: 'puede_encajar', motivo: 'x', exigeSedeEnOtraComunidad: 'no_aplica' }
          : { elegibilidadEsfl: vacio, importeMaximoProyecto: vacio, importeTotal: vacio, plazo: vacio, cofinanciacion: vacio, requisitos: [], lineas: [], ideaProyecto: null };
        return { datos, modelo: p.modelo, uso: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 } };
      },
    };
    await ejecutarRadar(deps(db, { llm }));
    const analisis = peticiones.filter((p) => p.tarea === 'analisis');
    assert.equal(analisis.length, 1);
    assert.match(analisis[0].mensaje, /Ganadores de ediciones anteriores/);
    assert.match(analisis[0].mensaje, /2025 \(convocatoria BDNS 825309, 19 concesiones\)/);
    assert.match(analisis[0].mensaje, /GRUPO BRINZAL/);
    // Sin ganadores el prompt es el de siempre (la caché de lo ya analizado sigue valiendo).
    assert.ok(!promptAnalisis(perfil, CONV_2026, []).mensaje.includes('Ganadores de ediciones anteriores'));
  });
});
