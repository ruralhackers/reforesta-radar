// Fuente EU Funding & Tenders a través del motor: respuestas reales de la búsqueda SEDIA grabadas (test/fixtures/eu-ft, con el reloj
// fijo AHORA_EU_FT = 13/11/2026), LLM falso y reloj fijo. Se comprueba la BD y la API.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { guardarConvocatoria, leerConvocatoria, leerFases, leerPlazo } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { bdns } from '../src/sources/bdns.ts';
import { aTopic, crearFuenteEuFt, esRelevante } from '../src/sources/eu-ft.ts';
import type { Fuente } from '../src/sources/source.ts';
import { bdSembrada, relojFijo } from './support/bd.ts';
import { AHORA_EU_FT, ESCENARIOS, esSedia, fetchGrabado } from './support/grabaciones.ts';

const euFt = crearFuenteEuFt(() => ({ pausaMs: 0, maxPeticiones: 8 }));
const NATURALEZA = 'ft:HORIZON-NATURE-2027-02-02'; // "Living labs co-creating solutions for the restoration of ecosystems…", cierre 14/01/2027
const AJENO = 'ft:HORIZON-CL5-2027-03-D5-03'; // "Data-driven circular economy for e-mobility ecosystem (2ZERO Partnership)"
const CANCELADO = 'ft:HORIZON-EIE-2027-01-CONNECT-01-CANCELLED';

async function pasada(db: DatabaseSync, fuentes: Fuente[], fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  return ejecutarRadar({ db, fetch, reloj: relojFijo(AHORA_EU_FT), fuentes, ganadores: false, parecidas: false, ...extra }, { diasAtras: 7 });
}

const fila = (db: DatabaseSync, id: string) => db.prepare('SELECT * FROM convocatorias WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;

describe('fuente EU Funding & Tenders', () => {
  test('las abiertas relevantes llegan al ranking con su enlace al portal; las ajenas y canceladas quedan descartadas con motivo', async () => {
    const db = bdSembrada();
    const r = await pasada(db, [euFt], fetchGrabado({ euFt: true }));
    assert.equal(r.conErrores, false);
    const f = r.fuentes[0];
    assert.equal(f.fuente, 'eu_ft');
    assert.equal(f.recibidas, 247); // topics con fecha límite futura de la consulta grabada
    assert.equal(f.candidatas + f.descartadas, f.recibidas);
    assert.ok(f.candidatas >= 50 && f.candidatas < f.recibidas, `candidatas: ${f.candidatas}`);

    const c = fila(db, NATURALEZA)!;
    assert.equal(c.fuente, 'eu_ft');
    assert.equal(c.fuente_id, 'HORIZON-NATURE-2027-02-02');
    assert.equal(c.descarte_regla, null);
    assert.equal(c.organo_nivel1, 'UE');
    assert.equal(c.organo_nivel2, 'Horizon Europe');
    assert.equal(c.url, 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-NATURE-2027-02-02');

    const ajeno = fila(db, AJENO)!;
    assert.equal(ajeno.descarte_regla, 'tema');
    assert.match(String(ajeno.descarte_motivo), /Fuera de los temas del perfil/);
    assert.equal(fila(db, CANCELADO)?.descarte_regla, 'tema');

    // Fecha límite explícita → plazo literal (14/01/2027, hora de Bruselas).
    const p = leerPlazo(db, NATURALEZA, '2026-11-13')!;
    assert.deepEqual([p.tipo, p.fechaCierre, p.diasHastaCierre], ['literal', '2027-01-14', 62]);

    // Ranking (API): la relevante sale con su enlace al portal y su fuente; la ajena no.
    const api = crearApi({ db, reloj: { now: () => AHORA_EU_FT }, fuentes: [euFt] });
    const semana = await (await api.request('/semana')).json() as { convocatorias: { id: string; fuente: string; url: string; organo: string; plazo: { fechaCierre: string } | null }[] };
    const ids = semana.convocatorias.map((x) => x.id);
    assert.ok(ids.includes(NATURALEZA));
    assert.ok(!ids.includes(AJENO));
    assert.ok(!ids.includes(CANCELADO));
    const x = semana.convocatorias.find((y) => y.id === NATURALEZA)!;
    assert.equal(x.fuente, 'eu_ft');
    assert.match(x.url, /topic-details\/HORIZON-NATURE-2027-02-02$/);
    assert.equal(x.plazo?.fechaCierre, '2027-01-14');

    // Ficha: enlace al portal.
    const ficha = await (await api.request(`/convocatorias/${encodeURIComponent(NATURALEZA)}`)).json() as { enlaces: { tipo: string; url: string }[]; presupuesto?: unknown };
    assert.deepEqual(ficha.enlaces.map((e) => e.tipo), ['ficha']);
    assert.match(ficha.enlaces[0].url, /topic-details\/HORIZON-NATURE-2027-02-02$/);
  });

  test('es idempotente: otra pasada no duplica ni cambia el número de filas', async () => {
    const db = bdSembrada();
    await pasada(db, [euFt], fetchGrabado({ euFt: true }));
    const n = (db.prepare('SELECT COUNT(*) AS n FROM convocatorias').get() as { n: number }).n;
    const r2 = await pasada(db, [euFt], fetchGrabado({ euFt: true }));
    assert.equal(r2.fuentes[0].nuevas, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM convocatorias').get() as { n: number }).n, n);
  });

  test('un fallo del portal queda en el registro de la ejecución y no impide BDNS', async () => {
    const db = bdSembrada();
    const grabado = fetchGrabado();
    const fetchPortalCaido = ((url: string, init?: RequestInit) => (esSedia(String(url)) ? Promise.resolve(new Response('Service Unavailable', { status: 503 })) : grabado(url, init))) as typeof fetch;
    const e = ESCENARIOS.agosto2026;
    const r = await ejecutarRadar({ db, fetch: fetchPortalCaido, reloj: relojFijo(e.ahora), fuentes: [bdns, euFt], ganadores: false, parecidas: false }, { diasAtras: e.diasAtras });
    const [rb, rf] = r.fuentes;
    assert.equal(rb.fuente, 'bdns');
    assert.equal(rb.errores.length, 0);
    assert.ok(rb.candidatas > 0);
    assert.ok(fila(db, 'bdns:923290'));
    assert.equal(rf.fuente, 'eu_ft');
    assert.equal(rf.recibidas, 0);
    assert.match(rf.errores.join(' '), /Funding & Tenders 503/);
    assert.equal(r.conErrores, true);
    const registro = db.prepare('SELECT errores FROM ejecucion_fuentes WHERE ejecucion_id = ? AND fuente = ?').get(r.ejecucionId, 'eu_ft') as { errores: string };
    assert.match(registro.errores, /503/);
  });

  test('y al revés: si BDNS cae, las convocatorias de la UE se recogen igual', async () => {
    const db = bdSembrada();
    const grabado = fetchGrabado({ euFt: true });
    const fetchBdnsCaido = ((url: string, init?: RequestInit) => (esSedia(String(url)) ? grabado(url, init) : Promise.reject(new Error('red caída')))) as typeof fetch;
    const r = await ejecutarRadar({ db, fetch: fetchBdnsCaido, reloj: relojFijo(AHORA_EU_FT), fuentes: [bdns, euFt], ganadores: false, parecidas: false }, { diasAtras: 7 });
    assert.match(r.fuentes[0].errores.join(' '), /Fallo de la fuente/);
    assert.ok(r.fuentes[1].candidatas > 50);
    assert.ok(fila(db, NATURALEZA));
  });

  test('politeness: pausa entre páginas y tope de peticiones, que queda registrado', async () => {
    const db = bdSembrada();
    const grabado = fetchGrabado({ euFt: true });
    let peticiones = 0;
    const contado = ((url: string, init?: RequestInit) => { peticiones++; return grabado(url, init); }) as typeof fetch;
    const pausas: number[] = [];
    const limitada = crearFuenteEuFt(() => ({ pausaMs: 500, maxPeticiones: 2 }));
    const r = await pasada(db, [limitada], contado, { dormir: async (ms: number) => { pausas.push(ms); } });
    assert.equal(peticiones, 2);
    assert.deepEqual(pausas, [500]);
    assert.match(r.fuentes[0].errores.join(' '), /Tope de 2 peticiones/);
    assert.ok(r.fuentes[0].recibidas > 0);
  });

  test('duplicadas con BDNS: si la misma convocatoria ya está en BDNS (mismo título), se conserva la de BDNS', async () => {
    const db = bdSembrada();
    const antes = await pasada(db, [euFt], fetchGrabado({ euFt: true }));
    assert.equal(antes.fuentes[0].nuevas, 247);
    const titulo = String(fila(db, NATURALEZA)!.titulo);
    // La misma convocatoria registrada en BDNS, con el título en otra tipografía.
    guardarConvocatoria(db, {
      convocatoria: {
        id: 'bdns:999001', fuente: 'bdns', fuenteId: '999001', titulo: titulo.toUpperCase().replace(/ /g, '  ') + '.',
        organo: { nivel1: 'ESTADO', nivel2: 'MINISTERIO', nivel3: null }, fechaPublicacion: '2026-11-12',
        url: 'https://example.org/999001', tipo: null, finalidad: null, regiones: [], abierto: true, datos: {},
      },
      descarte: null,
    }, AHORA_EU_FT);

    const r = await pasada(db, [euFt], fetchGrabado({ euFt: true }));
    assert.equal(r.duplicadas?.marcadas, 1);
    const fase = leerFases(db, NATURALEZA).find((f) => f.fase === 'duplicada')!;
    assert.equal(fase.descarta, true);
    assert.deepEqual(fase.datos, { duplicadaDe: 'bdns:999001' });
    assert.match(String(fase.motivo), /Duplicada de bdns:999001/);

    const api = crearApi({ db, reloj: { now: () => AHORA_EU_FT }, fuentes: [euFt] });
    const ids = ((await (await api.request('/semana')).json()) as { convocatorias: { id: string }[] }).convocatorias.map((x) => x.id);
    assert.ok(ids.includes('bdns:999001'));
    assert.ok(!ids.includes(NATURALEZA));
    // Otra pasada: sigue marcada, sin duplicar el veredicto, y la de BDNS intacta.
    await pasada(db, [euFt], fetchGrabado({ euFt: true }));
    assert.equal(leerFases(db, NATURALEZA).filter((f) => f.fase === 'duplicada').length, 1);
    assert.equal(leerFases(db, 'bdns:999001').length, 0);
  });

  test('criba y análisis (LLM falso): los textos van en inglés, el prompt pide castellano y las de BDNS no cambian', async () => {
    const db = bdSembrada();
    const peticiones: PeticionLlm[] = [];
    const vacio = { valor: null, cita: null, documento: null };
    const llm: Llm = {
      async generar(p) {
        peticiones.push(p);
        const datos = p.tarea === 'criba'
          ? { decision: /Convocatoria ft:HORIZON-NATURE-2027-02-02:/.test(p.mensaje) ? 'puede_encajar' : 'descartar', motivo: 'Restauración de ecosistemas', exigeSedeEnOtraComunidad: 'no_aplica' }
          : { elegibilidadEsfl: vacio, importeMaximoProyecto: vacio, importeTotal: vacio, plazo: vacio, cofinanciacion: vacio, requisitos: [], lineas: [], ideaProyecto: null };
        return { datos, modelo: p.modelo, uso: { entrada: 1000, salida: 100, cacheLectura: 0, cacheEscritura: 0 } };
      },
    };
    const r = await pasada(db, [euFt], fetchGrabado({ euFt: true }), { llm });
    assert.equal(r.conErrores, false);
    const criba = peticiones.find((p) => p.tarea === 'criba' && p.mensaje.includes(`Convocatoria ${NATURALEZA}:`))!;
    assert.match(criba.sistema, /están en inglés\. Responde en castellano/);
    assert.match(criba.mensaje, /<documento titulo="Ficha Funding & Tenders">/);
    assert.match(criba.mensaje, /Fecha límite \(hora de Bruselas\): 2027-01-14/);
    assert.match(criba.mensaje, /<documento titulo="Descripción del topic \(inglés\)">/);
    assert.match(criba.mensaje, /restoration/i);
    assert.match(criba.sistema, /CONVOCATORIAS DE LA UE .*prevalece sobre "ante la duda"/);
    assert.match(criba.sistema, /socia de un consorcio|socia de consorcio/);
    // La fecha de publicación es la apertura real (13/10/2026, fuera de la ventana de 30 días) y aun así la criba la leyó.
    assert.equal(fila(db, NATURALEZA)!.fecha_publicacion, '2026-10-13');
    const analisis = peticiones.find((p) => p.tarea === 'analisis')!;
    assert.match(analisis.sistema, /citas, que se copian literalmente en inglés/);
    // La criba descartó el resto: quedan sus veredictos; la elegida tiene análisis.
    assert.equal(leerFases(db, NATURALEZA).find((f) => f.fase === 'criba_llm')?.descarta, false);
    assert.ok(leerFases(db, NATURALEZA).find((f) => f.fase === 'analisis'));
    assert.equal(peticiones.filter((p) => p.tarea === 'analisis').length, 1);
    assert.ok(leerConvocatoria(db, NATURALEZA));
  });
});

describe('aTopic y esRelevante', () => {
  const base = (m: Record<string, string[]>) => ({ metadata: { identifier: ['LIFE-2027-X'], title: ['Nature restoration'], status: ['31094502'], deadlineDate: ['2027-03-01T17:00:00.000+0000'], ...m } });

  test('sin fecha límite futura (ficha antigua que el índice conserva como "abierta") no hay convocatoria', () => {
    assert.equal(aTopic(base({ deadlineDate: ['2023-09-06T17:00:00.000+0000'] }), '2026-11-13'), null);
    assert.equal(aTopic(base({ deadlineDate: [] }), '2026-11-13'), null);
    assert.equal(aTopic(base({ status: ['31094503'] }), '2026-11-13'), null); // cerrada
  });

  test('varios cortes: cuenta el primero que no ha pasado; la hora de Bruselas puede cambiar el día', () => {
    const t = aTopic(base({ deadlineDate: ['2026-01-31T22:59:00.000+0000', '2026-12-30T23:30:00.000+0000', '2027-02-01T10:00:00.000+0000'] }), '2026-11-13')!;
    assert.deepEqual(t.fechasLimite, ['2026-01-31', '2026-12-31', '2027-02-01']);
    assert.equal(t.fechaLimite, '2026-12-31');
  });

  test('relevancia: LIFE siempre; "innovation ecosystem" y "the nature of" no', () => {
    assert.equal(esRelevante(aTopic(base({ title: ['Energy transition'] }), '2026-11-13')!), true); // LIFE
    const ajeno = aTopic({ metadata: { identifier: ['HORIZON-X-1'], title: ['Build a thriving innovation ecosystem'], status: ['31094502'], deadlineDate: ['2027-03-01T17:00:00.000+0000'], descriptionByte: ['<p>The nature of the ecosystem</p>'] } }, '2026-11-13')!;
    assert.equal(esRelevante(ajeno), false);
    const propio = aTopic({ metadata: { identifier: ['HORIZON-X-2'], title: ['Restoring peatlands'], status: ['31094502'], deadlineDate: ['2027-03-01T17:00:00.000+0000'] } }, '2026-11-13')!;
    assert.equal(esRelevante(propio), true);
  });
});
