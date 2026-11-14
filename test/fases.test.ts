// Criba LLM (Haiku) y análisis (Sonnet) a través del motor: fetch con respuestas reales grabadas (BDNS + PDF),
// LLM falso y reloj fijo. Se comprueba lo que queda en la BD.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { candidatasEntre, descartesEntre, leerFases, ultimasEjecuciones } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Analisis } from '../src/fases/analisis-esquema.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdns } from '../src/sources/bdns.ts';
import type { Fuente } from '../src/sources/source.ts';
import { bdSembrada, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
import { ESCENARIOS, fetchGrabado } from './support/grabaciones.ts';

const perfil = leerSemilla(RUTA_SEMILLA).perfil;
const USO = { entrada: 1000, salida: 100, cacheLectura: 0, cacheEscritura: 0 };
// Precios de la tabla: Haiku 0,10/0,50 $/MTok; Sonnet 2/10 $/MTok.
const COSTE_CRIBA = (1000 * 0.1 + 100 * 0.5) / 1e6;
const COSTE_ANALISIS = (1000 * 2 + 100 * 10) / 1e6;

const idDe = (p: PeticionLlm) => /Convocatoria (bdns:\d+)/.exec(p.mensaje)?.[1] ?? '';

/** Criba falsa: pasan las de `pasan`; 923229 (Extremadura) "puede encajar" pero exige sede allí; el resto se descarta. */
function cribaFalsa(p: PeticionLlm, pasan: string[]) {
  const id = idDe(p);
  if (id === 'bdns:923229') return { decision: 'puede_encajar', motivo: 'Proyectos ambientales', exigeSedeEnOtraComunidad: 'si' };
  if (pasan.includes(id)) return { decision: 'puede_encajar', motivo: 'Ayudas a ONG ambientales de ámbito estatal', exigeSedeEnOtraComunidad: 'no_aplica' };
  return { decision: 'descartar', motivo: `No encaja (${id})`, exigeSedeEnOtraComunidad: 'no_aplica' };
}

/** Análisis falso de la 923290, con citas reales del extracto, del PDF de la convocatoria y de las bases, y trampas. */
function analisisFalso(p: PeticionLlm) {
  if (idDe(p) !== 'bdns:923290') {
    return {
      elegibilidadEsfl: { valor: null, cita: null, documento: null }, importeMaximoProyecto: { valor: null, cita: null, documento: null },
      importeTotal: { valor: null, cita: null, documento: null }, plazo: { valor: null, cita: null, documento: null },
      cofinanciacion: { valor: null, cita: null, documento: null }, requisitos: [], lineas: [], ideaProyecto: null,
    };
  }
  return {
    elegibilidadEsfl: {
      valor: 'si',
      cita: 'destinadas a entidades del Tercer Sector u organizaciones no gubernamentales de ámbito estatal',
      documento: 'Extracto BOE-B-2026-26402',
    },
    // Trampa: cita real pero de otro dato (el plazo): la cifra no está en la cita → desconocido.
    importeMaximoProyecto: {
      valor: '100.000 €',
      cita: 'El plazo para la presentación de las solicitudes será de quince días hábiles',
      documento: 'Extracto BOE-B-2026-26402',
    },
    importeTotal: { valor: '17.389.322,52 €', cita: 'en una cuantía total de 17.389.322,52 €', documento: 'Extracto BOE-B-2026-26402' },
    plazo: {
      valor: '15 días hábiles desde el día siguiente a la publicación del extracto en el BOE',
      cita: 'El plazo para la presentación de las solicitudes será de quince días hábiles',
      documento: 'Extracto BOE-B-2026-26402',
    },
    // Trampa: valor sin cita → desconocido.
    cofinanciacion: { valor: 'Sí, 20 %', cita: null, documento: null },
    requisitos: [
      // Cita de las bases (PDF del BOE), partida en varias líneas en el texto extraído.
      {
        valor: 'Inscrita en el Registro Nacional de Asociaciones y declarada de utilidad pública, o en el de Fundaciones estatales',
        cita: 'Estar inscritas, según su estatuto jurídico, en el Registro Nacional de Asociaciones y haber sido declaradas de utilidad pública',
        documento: 'Bases reguladoras',
      },
      // Del PDF de la convocatoria (sin decir el documento).
      {
        valor: 'Financiar con recursos propios la diferencia si se concede menos',
        cita: 'la entidad beneficiaria deberá financiar la diferencia con recursos propios',
        documento: null,
      },
      { valor: 'Requisito sin cita', cita: null, documento: null },
      // Trampa: cita inventada (no aparece en ningún texto) → fuera.
      { valor: 'Sede en Madrid', cita: 'Las entidades deberán tener su sede social en la Comunidad de Madrid', documento: 'Bases reguladoras' },
    ],
    lineas: [
      { linea: perfil.lineas[0].nombre, motivo: 'Protección del medio ambiente', cita: null, documento: null },
      { linea: 'Línea que no existe', motivo: 'x', cita: null, documento: null },
    ],
    ideaProyecto: 'Investigación aplicada sobre restauración de charcas para anfibios, pidiendo 80.000 € de un total de 17.389.322,52 €.',
  };
}

function llmFalso(pasan: string[] = ['bdns:923290']) {
  const llamadas: PeticionLlm[] = [];
  const llm: Llm = {
    async generar(p) {
      llamadas.push(p);
      return { datos: p.tarea === 'criba' ? cribaFalsa(p, pasan) : analisisFalso(p), modelo: p.modelo, uso: USO };
    },
  };
  return { llm, llamadas };
}

function fetchContado() {
  const grabado = fetchGrabado();
  const urls: string[] = [];
  const f = ((url: string, init?: RequestInit) => {
    urls.push(String(url));
    return grabado(url, init);
  }) as typeof fetch;
  return { f, urls };
}

function fase(db: DatabaseSync, id: string, nombre: string) {
  return leerFases(db, id).find((f) => f.fase === nombre);
}

const e = ESCENARIOS.agosto2026;

describe('criba LLM y análisis con citas (LLM falso)', () => {
  test('la 923290 sale elegible para ESFL pese a sus metadatos; campo sin cita o con cita inventada → desconocido', async () => {
    const db = bdSembrada();
    const { llm, llamadas } = llmFalso();
    const r = await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora), llm }, { diasAtras: e.diasAtras });

    // Los metadatos de BDNS dicen "personas físicas": no han provocado un descarte de reglas…
    const fila = db.prepare("SELECT descarte_regla, datos FROM convocatorias WHERE id = 'bdns:923290'").get() as { descarte_regla: string | null; datos: string };
    assert.equal(fila.descarte_regla, null);
    assert.match(fila.datos, /PERSONAS F[ÍI]SICAS QUE NO DESARROLLAN ACTIVIDAD/i);
    // …ni llegan al LLM: la elegibilidad se decide por el texto.
    const delas923290 = llamadas.filter((p) => idDe(p) === 'bdns:923290');
    assert.equal(delas923290.length, 2, 'una criba y un análisis');
    for (const p of delas923290) assert.doesNotMatch(p.mensaje, /PERSONAS F[ÍI]SICAS QUE NO DESARROLLAN/i);

    const analisisFase = fase(db, 'bdns:923290', 'analisis');
    assert.ok(analisisFase, 'la 923290 se ha analizado');
    assert.equal(analisisFase.descarta, false);
    const a = (analisisFase.datos as { analisis: Analisis }).analisis;

    assert.equal(a.elegibilidadEsfl.valor, 'si');
    assert.equal(a.elegibilidadEsfl.documento, 'Extracto BOE-B-2026-26402');
    assert.match(a.elegibilidadEsfl.cita!, /Tercer Sector/);

    assert.equal(a.importeMaximoProyecto.valor, null, '"100.000 €" con la cita del plazo → desconocido');
    assert.equal(a.importeMaximoProyecto.motivo, 'el valor no está en la cita');
    assert.equal(a.cofinanciacion.valor, null, 'valor sin cita → desconocido');
    assert.equal(a.cofinanciacion.motivo, 'sin cita literal');
    assert.ok(a.correcciones.some((c) => /requisitos\[3\]: la cita no aparece en los textos/.test(c)), 'cita inventada → fuera');

    assert.equal(a.importeTotal.valor, '17.389.322,52 €');
    assert.equal(a.plazo.documento, 'Extracto BOE-B-2026-26402', '"15 días" casa con "quince días" de la cita');

    // Requisitos: el de las bases (PDF del BOE) y el del PDF de la convocatoria se comprueban contra el texto extraído.
    assert.deepEqual(a.requisitos.map((q) => q.documento), ['Bases reguladoras', 'Documento: Texto en castellano de la convocatoria']);
    assert.deepEqual(a.lineas.map((l) => l.linea), [perfil.lineas[0].nombre]);
    assert.match(a.ideaProyecto!, /\(importe por confirmar\) de un total de 17\.389\.322,52 €/);
    assert.ok(a.correcciones.some((c) => /importeMaximoProyecto/.test(c)));
    assert.ok(a.correcciones.some((c) => /Línea que no existe/.test(c)));

    // El análisis recibió el PDF de la convocatoria y las bases ya convertidos a texto.
    const peticionAnalisis = llamadas.find((p) => p.tarea === 'analisis')!;
    assert.equal(peticionAnalisis.modelo, 'claude-sonnet-5-5');
    assert.match(peticionAnalisis.mensaje, /<documento-[0-9a-f]{16} titulo="Bases reguladoras">[\s\S]*Orden TED\/898\/2023/);
    assert.match(peticionAnalisis.mensaje, /<documento-[0-9a-f]{16} titulo="Documento: Texto en castellano de la convocatoria">/);

    assert.equal(r.conErrores, false);
    assert.ok(candidatasEntre(db, '2026-08-03', '2026-08-04').some((c) => c.id === 'bdns:923290'));
  });

  test('descartes de la criba con motivo; otra comunidad que exige sede queda fuera; coste registrado', async () => {
    const db = bdSembrada();
    const { llm, llamadas } = llmFalso();
    const r = await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora), llm }, { diasAtras: e.diasAtras });

    const criba923289 = fase(db, 'bdns:923289', 'criba_llm');
    assert.equal(criba923289?.descarta, true);
    assert.equal(criba923289?.motivo, 'No encaja (bdns:923289)');
    const sede = fase(db, 'bdns:923229', 'criba_llm');
    assert.equal(sede?.descarta, true, 'exige sede en Extremadura');
    assert.match(sede!.motivo!, /^Exige sede o actividad en otra comunidad/);

    const descartesCriba = descartesEntre(db, '2026-08-03', '2026-08-04', 'criba_llm');
    assert.ok(descartesCriba.length > 0);
    assert.ok(descartesCriba.every((d) => d.motivo), 'ningún descarte de la criba sin motivo');
    assert.ok(!candidatasEntre(db, '2026-08-03', '2026-08-04').some((c) => c.id === 'bdns:923289'));

    const cribas = llamadas.filter((p) => p.tarea === 'criba');
    assert.ok(cribas.every((p) => p.modelo === 'claude-haiku-5-5'));
    const [criba, analisis] = r.fases;
    assert.equal(criba.llamadas, cribas.length);
    assert.equal(analisis.llamadas, 1);
    const [ejecucion] = ultimasEjecuciones(db, 1);
    assert.equal(ejecucion.fases.length, 2);
    assert.ok(Math.abs(ejecucion.costeLlmUsd - (cribas.length * COSTE_CRIBA + COSTE_ANALISIS)) < 1e-12);
    assert.equal(ejecucion.fases[0].tokensEntrada, cribas.length * 1000);
  });

  test('el tope de análisis por ejecución se respeta, se registra y lo que falta se analiza en la siguiente', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(e.ahora);
    const { llm, llamadas } = llmFalso(['bdns:923289', 'bdns:923290', 'bdns:923292']);
    const deps = { db, fetch: fetchGrabado(), reloj, llm, configLlm: { maxAnalisis: 2 } };

    const r1 = await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    const analisis1 = r1.fases.find((f) => f.fase === 'analisis')!;
    assert.equal(llamadas.filter((p) => p.tarea === 'analisis').length, 2);
    assert.equal(analisis1.llamadas, 2);
    assert.equal(analisis1.omitidasPorTope, 1);
    assert.match(analisis1.avisos.join('\n'), /Tope de 2 análisis por ejecución alcanzado: 1 convocatorias quedan sin analizar/);
    const analizadas = () => ['bdns:923289', 'bdns:923290', 'bdns:923292'].filter((id) => fase(db, id, 'analisis'));
    assert.equal(analizadas().length, 2);
    assert.equal(ultimasEjecuciones(db, 1)[0].fases.find((f) => f.fase === 'analisis')?.omitidasPorTope, 1);

    reloj.adelantar(60 * 60 * 1000);
    llamadas.length = 0;
    const r2 = await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    assert.equal(llamadas.filter((p) => p.tarea === 'criba').length, 0, 'la criba no se repite');
    assert.equal(llamadas.filter((p) => p.tarea === 'analisis').length, 1, 'solo la que faltaba');
    assert.equal(r2.fases.find((f) => f.fase === 'analisis')!.omitidasPorTope, 0);
    assert.equal(analizadas().length, 3);
  });

  test('un PDF ya leído no se vuelve a descargar ni a enviar al LLM', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(e.ahora);
    const { llm, llamadas } = llmFalso();
    const { f, urls } = fetchContado();
    const deps = { db, fetch: f, reloj, llm };
    await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    const descargasPdf = () => urls.filter((u) => /documentos\?idDocumento=|boe\.es\/boe\/dias/.test(u)).length;
    assert.equal(descargasPdf(), 2);
    assert.equal((db.prepare('SELECT count(*) AS n FROM textos').get() as { n: number }).n, 2);

    // Se borra el veredicto del análisis (p. ej. para rehacerlo): ni se descargan otra vez los PDF ni se repite la llamada.
    db.prepare("DELETE FROM convocatoria_fases WHERE convocatoria_id = 'bdns:923290' AND fase = 'analisis'").run();
    reloj.adelantar(60 * 60 * 1000);
    llamadas.length = 0;
    const r = await ejecutarRadar(deps, { diasAtras: e.diasAtras });
    assert.equal(descargasPdf(), 2, 'sin descargas nuevas');
    assert.equal(llamadas.length, 0, 'sin llamadas nuevas al LLM');
    const analisis = r.fases.find((x) => x.fase === 'analisis')!;
    assert.equal(analisis.desdeCache, 1);
    assert.equal(analisis.costeUsd, 0);
    assert.equal((fase(db, 'bdns:923290', 'analisis')?.datos as { desdeCache: boolean }).desdeCache, true);
  });

  test('sin LLM las fases se saltan con un aviso y las de otra comunidad no salen en la lista', async () => {
    const db = bdSembrada();
    const r = await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora), llm: null }, { diasAtras: e.diasAtras });
    assert.equal(r.conErrores, false);
    const [ejecucion] = ultimasEjecuciones(db, 1);
    assert.deepEqual(ejecucion.fases.map((f) => f.fase), ['criba_llm', 'analisis']);
    for (const f of ejecucion.fases) assert.match(f.avisos[0], /falta ANTHROPIC_API_KEY/);
    assert.equal(ejecucion.costeLlmUsd, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM convocatoria_fases').get() as { n: number }).n, 0);
    const lista = candidatasEntre(db, '2026-08-03', '2026-08-04').map((c) => c.id);
    assert.ok(lista.includes('bdns:923290'));
    assert.ok(!lista.includes('bdns:923229'));
  });

  test('una respuesta inválida del LLM queda como error de la fase y no deja veredicto (se reintenta)', async () => {
    const db = bdSembrada();
    const llm: Llm = { generar: async (p) => ({ datos: { decision: 'quizá' }, modelo: p.modelo, uso: USO }) };
    const r = await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora), llm }, { diasAtras: e.diasAtras });
    assert.equal(r.conErrores, true);
    assert.match(r.fases[0].errores[0], /decisión no válida/);
    assert.equal(fase(db, 'bdns:923290', 'criba_llm'), undefined);
    assert.equal(ultimasEjecuciones(db, 1)[0].estado, 'con_errores');
  });
  test('lo que dejó el tope se analiza en la siguiente ejecución aunque la fuente ya no lo devuelva', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(e.ahora);
    const { llm, llamadas } = llmFalso(['bdns:923289', 'bdns:923290', 'bdns:923292']);
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj, llm, configLlm: { maxAnalisis: 2 } }, { diasAtras: e.diasAtras });
    const ids = ['bdns:923289', 'bdns:923290', 'bdns:923292'];
    const sinAnalisis = ids.filter((id) => !fase(db, id, 'analisis'));
    assert.equal(sinAnalisis.length, 1);

    // Cinco días después: la ventana de BDNS (2 días) ya no la incluye y la fuente no devuelve nada.
    reloj.adelantar(5 * 24 * 60 * 60 * 1000);
    const bdnsMuda: Fuente = { ...bdns, recoger: async () => ({ cribadas: [], errores: [] }) };
    llamadas.length = 0;
    const r = await ejecutarRadar({ db, fetch: fetchGrabado(), reloj, llm, configLlm: { maxAnalisis: 2 }, fuentes: [bdnsMuda] }, { diasAtras: e.diasAtras });
    assert.equal(r.fuentes[0].recibidas, 0);
    assert.deepEqual(llamadas.map((p) => [p.tarea, idDe(p)]), [['analisis', sinAnalisis[0]]]);
    assert.ok(fase(db, sinAnalisis[0], 'analisis'), 'analizada sin que BDNS la haya vuelto a devolver');

    // Fuera de los días de pendientes (30 por defecto) ya no se buscan.
    db.prepare("DELETE FROM convocatoria_fases WHERE fase = 'analisis'").run();
    db.prepare('DELETE FROM llm_cache').run();
    reloj.adelantar(40 * 24 * 60 * 60 * 1000);
    llamadas.length = 0;
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj, llm, fuentes: [bdnsMuda] }, { diasAtras: e.diasAtras });
    assert.equal(llamadas.length, 0);
  });

  test('si un documento falla por algo pasajero, no se llama a Sonnet ni se guarda veredicto: se reintenta', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(e.ahora);
    const { llm, llamadas } = llmFalso();
    const grabado = fetchGrabado();
    const basesCaidas = ((url: string, init?: RequestInit) =>
      String(url).includes('BOE-A-2023-17623') ? Promise.resolve(new Response('', { status: 503 })) : grabado(url, init)) as typeof fetch;

    const r1 = await ejecutarRadar({ db, fetch: basesCaidas, reloj, llm }, { diasAtras: e.diasAtras });
    assert.equal(llamadas.filter((p) => p.tarea === 'analisis').length, 0, 'sin gasto en un análisis incompleto');
    assert.equal(fase(db, 'bdns:923290', 'analisis'), undefined);
    const analisis1 = r1.fases.find((f) => f.fase === 'analisis')!;
    assert.match(analisis1.errores[0], /bdns:923290 aplazado.*Bases reguladoras.*HTTP 503/);
    assert.equal(r1.conErrores, true);

    reloj.adelantar(60 * 60 * 1000);
    await ejecutarRadar({ db, fetch: grabado, reloj, llm }, { diasAtras: e.diasAtras });
    assert.equal(llamadas.filter((p) => p.tarea === 'analisis').length, 1);
    const a = (fase(db, 'bdns:923290', 'analisis')!.datos as { analisis: Analisis; documentosConError: string[] });
    assert.deepEqual(a.documentosConError, []);
    assert.equal(a.analisis.requisitos[0].documento, 'Bases reguladoras');
  });

  test('un documento ilegible de forma definitiva (404) no bloquea el análisis: se anota y se analiza con el resto', async () => {
    const db = bdSembrada();
    const { llm } = llmFalso();
    const grabado = fetchGrabado();
    const basesNoExisten = ((url: string, init?: RequestInit) =>
      String(url).includes('BOE-A-2023-17623') ? Promise.resolve(new Response('', { status: 404 })) : grabado(url, init)) as typeof fetch;
    const r = await ejecutarRadar({ db, fetch: basesNoExisten, reloj: relojFijo(e.ahora), llm }, { diasAtras: e.diasAtras });
    const d = fase(db, 'bdns:923290', 'analisis')!.datos as { documentosConError: string[] };
    assert.match(d.documentosConError[0], /Bases reguladoras.*HTTP 404/);
    assert.match(r.fases.find((f) => f.fase === 'analisis')!.avisos.join('\n'), /Documento ilegible en bdns:923290/);
  });
  test('un documento que falla en 3 ejecuciones seguidas se da por ilegible y el análisis sigue sin él', async () => {
    const db = bdSembrada();
    const reloj = relojFijo(e.ahora);
    const { llm, llamadas } = llmFalso();
    const grabado = fetchGrabado();
    const basesCaidas = ((url: string, init?: RequestInit) =>
      String(url).includes('BOE-A-2023-17623') ? Promise.reject(new TypeError('fetch failed')) : grabado(url, init)) as typeof fetch;
    for (let i = 0; i < 2; i++) {
      await ejecutarRadar({ db, fetch: basesCaidas, reloj, llm }, { diasAtras: e.diasAtras });
      reloj.adelantar(60 * 60 * 1000);
    }
    assert.equal(fase(db, 'bdns:923290', 'analisis'), undefined, 'dos fallos: sigue aplazada');
    await ejecutarRadar({ db, fetch: basesCaidas, reloj, llm }, { diasAtras: e.diasAtras });
    const d = fase(db, 'bdns:923290', 'analisis')!.datos as { documentosConError: string[] };
    assert.match(d.documentosConError[0], /Bases reguladoras.*sin respuesta en 3 intentos/);
    assert.equal(llamadas.filter((p) => p.tarea === 'analisis').length, 1);
  });
});
