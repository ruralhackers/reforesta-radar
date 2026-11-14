// Ranking a través del motor (BDNS grabado + LLM falso + reloj fijo) y de la API: orden esperado, secciones,
// cerradas y excluidas fuera, desglose en la ficha. Escenario abril 2025 (reloj: martes 08/04/2025).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { guardarFase, leerPuntuacion } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdns } from '../src/sources/bdns.ts';
import type { Fuente } from '../src/sources/source.ts';
import { bdSembrada, RUTA_PUNTUACION, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
import { ESCENARIOS, fetchGrabado } from './support/grabaciones.ts';

const perfil = leerSemilla(RUTA_SEMILLA).perfil;
const config = leerConfigPuntuacion(RUTA_PUNTUACION);
const e = ESCENARIOS.abril2025;

interface Caso {
  esfl: 'si' | 'no';
  lineas: number;
  importe: string | null;
  cofi: string | null;
  reqs: number;
}

// Casos (cierre en abril 2025: 434 → 23/04; 889 → 21/04; 309 y 256 → 05/05; 251 → 15/09; 395 → 21/01, cerrada; 807 → 09/05).
const CASOS: Record<string, Caso> = {
  'bdns:825309': { esfl: 'si', lineas: 2, importe: '60.000 euros', cofi: 'cofinanciación del 10 %', reqs: 1 }, // la mejor
  'bdns:825434': { esfl: 'si', lineas: 1, importe: '20.000 euros', cofi: 'cofinanciación del 10 %', reqs: 1 },
  'bdns:825889': { esfl: 'si', lineas: 1, importe: null, cofi: 'cofinanciación del 40 %', reqs: 4 },
  'bdns:825251': { esfl: 'si', lineas: 1, importe: '8.000 euros', cofi: null, reqs: 2 },
  'bdns:825395': { esfl: 'si', lineas: 3, importe: '100.000 euros', cofi: 'sin cofinanciación', reqs: 0 }, // cerrada
  'bdns:825807': { esfl: 'no', lineas: 3, importe: '100.000 euros', cofi: 'sin cofinanciación', reqs: 0 }, // no admite ESFL
  'bdns:825256': { esfl: 'si', lineas: 0, importe: null, cofi: null, reqs: 0 }, // todo desconocido
};

const frases = (c: Caso) => ({
  esfl: c.esfl === 'si' ? 'Podrán ser beneficiarias las entidades sin ánimo de lucro.' : 'No podrán ser beneficiarias las entidades sin ánimo de lucro.',
  importe: c.importe && `El importe máximo por proyecto será de ${c.importe}.`,
  cofi: c.cofi && `Se exige ${c.cofi}.`,
  req: (i: number) => `Requisito número ${i} de la convocatoria.`,
});

/** La fuente BDNS, pero con textos ya disponibles (sin descargar PDF): el de cada caso, con lo que dice el LLM falso. */
const fuente: Fuente = {
  ...bdns,
  documentos: (c) => {
    const caso = CASOS[c.id];
    if (!caso) return [{ titulo: 'Ficha', url: null, texto: c.titulo }];
    const f = frases(caso);
    const reqs = Array.from({ length: caso.reqs }, (_, i) => f.req(i + 1));
    return [{ titulo: 'Bases', url: null, texto: [f.esfl, f.importe, f.cofi, ...reqs].filter(Boolean).join(' ') }];
  },
};

const sinValor = { valor: '', cita: '', documento: '' };
const citado = (valor: string | null, cita: string | null) => (valor && cita ? { valor, cita, documento: 'Bases' } : sinValor);

function analisisFalso(id: string) {
  const caso = CASOS[id];
  if (!caso) return null;
  const f = frases(caso);
  return {
    elegibilidadEsfl: citado(caso.esfl, f.esfl),
    importeMaximoProyecto: citado(caso.importe, f.importe),
    importeTotal: sinValor,
    plazo: sinValor,
    cofinanciacion: citado(caso.cofi && caso.cofi.replace(/^.*?(\d+ %)$/, 'cofinanciación del $1'), f.cofi),
    requisitos: Array.from({ length: caso.reqs }, (_, i) => citado(`Requisito ${i + 1}`, f.req(i + 1))),
    lineas: perfil.lineas.slice(0, caso.lineas).map((l) => ({ linea: l.nombre, motivo: 'encaja', cita: '', documento: '' })),
    ideaProyecto: '', tituloCorto: 'Título corto de prueba',
  };
}

const idDe = (p: PeticionLlm) => /Convocatoria (bdns:\d+)/.exec(p.mensaje)?.[1] ?? '';
const USO = { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 };

const llm: Llm = {
  async generar(p) {
    const id = idDe(p);
    if (p.tarea === 'criba') {
      const pasa = id in CASOS;
      return { datos: { decision: pasa ? 'puede_encajar' : 'descartar', motivo: 'x', exigeSedeEnOtraComunidad: 'no_aplica' }, modelo: p.modelo, uso: USO };
    }
    return { datos: analisisFalso(id), modelo: p.modelo, uso: USO };
  },
};

async function pasada(): Promise<{ db: DatabaseSync; reloj: ReturnType<typeof relojFijo> }> {
  const db = bdSembrada();
  const reloj = relojFijo(e.ahora);
  const r = await ejecutarRadar({ db, fetch: fetchGrabado(), reloj, llm, fuentes: [fuente], puntuacion: config }, { diasAtras: e.diasAtras });
  assert.equal(r.conErrores, false, JSON.stringify(r.fases.map((f) => f.errores)));
  return { db, reloj };
}

interface Item {
  id: string;
  seccion: 'cierran_pronto' | 'nuevas' | 'abiertas';
  puntuacion: { total: number; analizada: boolean; factores: { id: string; subpuntuacion: number; conocido: boolean; explicacion: string; peso: number; nombre: string }[] } | null;
  plazo: { diasHastaCierre: number | null } | null;
}
interface Semana { nuevasDias: number; cierranProntoDias: number; convocatorias: Item[] }

const semana = async (db: DatabaseSync, ahora: Date) => (await (await crearApi({ db, reloj: { now: () => ahora }, fuentes: [fuente], puntuacion: config }).request('/semana')).json()) as Semana;

describe('ranking de "Esta semana" con el motor (LLM falso, reloj fijo)', () => {
  test('orden esperado por secciones; la cerrada y la que no admite ESFL no aparecen', async () => {
    const { db, reloj } = await pasada();
    const s = await semana(db, reloj.now());

    // "cierran pronto" (≤ 21 días) primero, por puntuación; luego "nuevas" por puntuación; ninguna repetida.
    assert.deepEqual(s.convocatorias.map((c) => [c.id, c.seccion]), [
      ['bdns:825434', 'cierran_pronto'], // 15 días
      ['bdns:825889', 'cierran_pronto'], // 13 días
      ['bdns:825309', 'nuevas'], // 86: la mejor, pero cierra en 27 días
      ['bdns:825251', 'nuevas'],
      ['bdns:825256', 'nuevas'], // todo desconocido
    ]);
    const ids = s.convocatorias.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(!ids.includes('bdns:825395'), 'cerrada: no aparece');
    assert.ok(!ids.includes('bdns:825807'), 'no admite ESFL: no aparece');

    const total = (id: string) => s.convocatorias.find((c) => c.id === id)!.puntuacion!.total;
    assert.ok(total('bdns:825309') > total('bdns:825251') && total('bdns:825251') > total('bdns:825256'));
    assert.ok(total('bdns:825434') > total('bdns:825889'));
    assert.ok(total('bdns:825309') > total('bdns:825434'), 'la 309 puntúa más aunque salga en "nuevas"');
    assert.deepEqual([total('bdns:825309'), total('bdns:825434'), total('bdns:825889')], [86, 74, 57]);

    // La cerrada sí está puntuada y guardada, con su motivo; también la no elegible.
    assert.match(leerPuntuacion(db, 'bdns:825395')!.excluida!, /^Cerrada el 21 de enero de 2025$/);
    assert.equal(leerPuntuacion(db, 'bdns:825807'), null, 'descartada en el análisis: ya no está en juego, no se puntúa');
  });

  test('el desglose guardado explica cada factor y marca lo desconocido', async () => {
    const { db, reloj } = await pasada();
    const s = await semana(db, reloj.now());
    const f = (id: string, factor: string) => s.convocatorias.find((c) => c.id === id)!.puntuacion!.factores.find((x) => x.id === factor)!;

    assert.match(f('bdns:825309', 'encaje').explicacion, /encaja con 2 líneas.*admite entidades sin ánimo de lucro/);
    assert.match(f('bdns:825309', 'importe').explicacion, /máximo por proyecto 60\.000 €/);
    assert.match(f('bdns:825309', 'cierre').explicacion, /faltan 27 días \(fecha calculada\)/);
    assert.match(f('bdns:825309', 'esfuerzo').explicacion, /cofinanciación del 10 %; 1 requisito/);
    assert.match(f('bdns:825251', 'cierre').explicacion, /faltan 160 días: plazo lejano, sin prisa/);
    assert.match(f('bdns:825251', 'importe').explicacion, /máximo por proyecto 8\.000 €/);
    assert.match(f('bdns:825309', 'probabilidad').explicacion, /^desconocida/);

    const desconocida = s.convocatorias.find((c) => c.id === 'bdns:825256')!.puntuacion!;
    assert.deepEqual(desconocida.factores.filter((x) => !x.conocido).map((x) => x.id), ['importe', 'esfuerzo', 'probabilidad']);
    assert.match(f('bdns:825256', 'importe').explicacion, /^desconocido/);
    assert.equal(f('bdns:825256', 'encaje').subpuntuacion, 0, 'ninguna línea de Reforesta');
  });

  test('recalcular cada ejecución: otra pasada con otro reloj refleja los cambios de plazo', async () => {
    const { db, reloj } = await pasada();
    const antes = leerPuntuacion(db, 'bdns:825889')!;
    assert.equal(antes.excluida, null);
    reloj.adelantar(14 * 86_400_000); // 22/04: la 889 (cierre 21/04) ya cerró; la 434 (23/04) cierra mañana
    // Sin red: la fuente falla (queda en el registro) pero las fases deterministas recalculan sobre lo guardado.
    await ejecutarRadar({ db, fetch: (() => Promise.reject(new Error('sin red'))) as typeof fetch, reloj, llm, fuentes: [fuente], puntuacion: config }, { diasAtras: 1 });
    assert.match(leerPuntuacion(db, 'bdns:825889')!.excluida!, /^Cerrada el 21 de abril de 2025$/);
    const s = await semana(db, reloj.now());
    assert.ok(!s.convocatorias.some((c) => c.id === 'bdns:825889'));
    const c434 = s.convocatorias.find((c) => c.id === 'bdns:825434')!;
    assert.equal(c434.plazo?.diasHastaCierre, 1);
    assert.match(c434.puntuacion!.factores.find((x) => x.id === 'cierre')!.explicacion, /^cierra mañana/);
  });

  test('"nuevas" son las vistas en los últimos 7 días según el reloj; con el tiempo pasan a no salir o a cierran pronto', async () => {
    const { db, reloj } = await pasada();
    // 16/04: ya han pasado 8 días desde que se vieron por primera vez (08/04), la ventana de 7 días llega al 10/04.
    const s = await semana(db, new Date(reloj.now().getTime() + 8 * 86_400_000));
    const secciones = Object.fromEntries(s.convocatorias.map((c) => [c.id, c.seccion]));
    // 434 y 889 cierran el 23 y el 21 (ya en cierran pronto); la 309 y la 256 (05/05) ahora a 19 días: cierran pronto;
    // la 251 (15/09, 152 días) ya no es nueva ni cierra pronto, pero sigue abierta y encaja: sale en "abiertas" (nunca se pierde).
    assert.deepEqual(secciones, {
      'bdns:825434': 'cierran_pronto', 'bdns:825889': 'cierran_pronto', 'bdns:825309': 'cierran_pronto', 'bdns:825256': 'cierran_pronto',
      'bdns:825251': 'abiertas',
    });
    assert.equal(s.convocatorias.at(-1)!.id, 'bdns:825251', '"abiertas" va después de las otras secciones');
    assert.ok(!s.convocatorias.some((c) => c.id === 'bdns:825395' || c.id === 'bdns:825807'), 'cerrada y no elegible siguen fuera');
  });

  test('una abierta con cierre desconocido nunca desaparece: pasa a "abiertas" tras la primera semana', async () => {
    const { db, reloj } = await pasada();
    db.prepare("UPDATE plazos SET fecha_cierre = NULL, tipo = 'desconocida' WHERE convocatoria_id = 'bdns:825256'").run();
    const s = await semana(db, new Date(reloj.now().getTime() + 30 * 86_400_000));
    const c = s.convocatorias.find((x) => x.id === 'bdns:825256')!;
    assert.equal(c.seccion, 'abiertas');
    assert.equal(c.plazo?.diasHastaCierre, null);
    assert.match(c.puntuacion!.factores.find((f) => f.id === 'cierre')!.explicacion, /^desconocido/);
  });

  test('la puntuación se calcula con el reloj de la petición: con dos relojes cambian la explicación de cierre y el total, sin nueva pasada', async () => {
    const { db, reloj } = await pasada();
    const ver = async (dias: number) => {
      const s = await semana(db, new Date(reloj.now().getTime() + dias * 86_400_000));
      const c = s.convocatorias.find((x) => x.id === 'bdns:825434')!; // cierre 23/04
      return { total: c.puntuacion!.total, cierre: c.puntuacion!.factores.find((f) => f.id === 'cierre')!, dias: c.plazo!.diasHastaCierre };
    };
    const a = await ver(0); // 08/04: 15 días
    const c = await ver(13); // 21/04: faltan 2 días
    assert.deepEqual([a.dias, a.cierre.subpuntuacion], [15, 1]);
    assert.match(a.cierre.explicacion, /faltan 15 días/);
    assert.deepEqual([c.dias, c.cierre.subpuntuacion], [2, 0.15]);
    assert.match(c.cierre.explicacion, /faltan 2 días/);
    assert.ok(c.total < a.total, `${c.total} < ${a.total}`);
    const s26 = await semana(db, new Date(reloj.now().getTime() + 18 * 86_400_000));
    assert.ok(!s26.convocatorias.some((x) => x.id === 'bdns:825434'), 'cerrada con el reloj de la petición');
  });

  test('una convocatoria descartada después de puntuarse no conserva ni muestra su puntuación', async () => {
    const { db, reloj } = await pasada();
    assert.ok(leerPuntuacion(db, 'bdns:825309'));
    guardarFase(db, { convocatoriaId: 'bdns:825309', fase: 'analisis', descarta: true, motivo: 'No admite ESFL', datos: {} }, reloj.now());
    const api = crearApi({ db, reloj: { now: () => reloj.now() }, fuentes: [fuente], puntuacion: config });
    const ficha = await (await api.request('/convocatorias/bdns:825309')).json() as { enJuego: boolean; puntuacion: unknown };
    assert.equal(ficha.enJuego, false);
    assert.equal(ficha.puntuacion, null);
    // Y la siguiente pasada borra la fila guardada.
    await ejecutarRadar({ db, fetch: (() => Promise.reject(new Error('sin red'))) as typeof fetch, reloj, llm, fuentes: [fuente], puntuacion: config }, { diasAtras: 1 });
    assert.equal(leerPuntuacion(db, 'bdns:825309'), null);
    assert.ok(leerPuntuacion(db, 'bdns:825434'), 'las demás siguen');
  });

  test('sin LLM ni análisis, las candidatas puntúan con el encaje desconocido (no desaparecen)', async () => {
    const db = bdSembrada();
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora), fuentes: [fuente], puntuacion: config }, { diasAtras: e.diasAtras });
    const p = leerPuntuacion(db, 'bdns:825309')!;
    assert.equal(p.analizada, false);
    assert.equal(p.factores.find((f) => f.id === 'encaje')!.conocido, false);
    assert.ok(p.total < 50);
  });
});

describe('forma de la API', () => {
  test('/semana: secciones, parámetros, plazo y puntuación; la ficha trae el desglose completo', async () => {
    const { db, reloj } = await pasada();
    const s = await semana(db, reloj.now());
    assert.deepEqual([s.nuevasDias, s.cierranProntoDias], [7, 21]);
    const c = s.convocatorias[0];
    assert.deepEqual(Object.keys(c.puntuacion!).sort(), ['analizada', 'calculadoEn', 'factores', 'total']);
    assert.deepEqual(c.puntuacion!.factores.map((f) => f.id), ['encaje', 'importe', 'cierre', 'esfuerzo', 'probabilidad']);
    assert.deepEqual(Object.keys(c.puntuacion!.factores[0]).sort(), ['conocido', 'explicacion', 'id', 'nombre', 'peso', 'subpuntuacion']);

    const api = crearApi({ db, reloj: { now: () => reloj.now() }, fuentes: [fuente], puntuacion: config });
    const ficha = await (await api.request('/convocatorias/bdns:825309')).json() as { puntuacion: { total: number; excluida: string | null; factores: unknown[] } };
    assert.equal(ficha.puntuacion.total, 86);
    assert.equal(ficha.puntuacion.excluida, null);
    assert.equal(ficha.puntuacion.factores.length, 5);
    const cerrada = await (await api.request('/convocatorias/bdns:825395')).json() as { puntuacion: { excluida: string } | null };
    assert.match(cerrada.puntuacion!.excluida, /Cerrada/);
  });

  test('con la configuración de pesos cambiada, el total y el orden cambian sin tocar el código', async () => {
    const db = bdSembrada();
    // Solo cuenta el tiempo hasta el cierre.
    const soloCierre = { ...config, pesos: { encaje: 0, importe: 0, cierre: 1, esfuerzo: 0, probabilidad: 0 } };
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora), llm, fuentes: [fuente], puntuacion: soloCierre }, { diasAtras: e.diasAtras });
    assert.equal(leerPuntuacion(db, 'bdns:825309')!.total, 100);
    assert.equal(leerPuntuacion(db, 'bdns:825889')!.total, 80);
  });
});
