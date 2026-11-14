// Fuente eu_cascada (convocatorias en cascada de la UE, FSTP) a través del motor: respuestas reales de la búsqueda SEDIA (type 8) grabadas en
// test/fixtures/eu-ft con el reloj fijo AHORA_EU_FT (13/11/2026), LLM falso y reloj fijo. Se comprueba la BD, la API y el prompt.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { leerFases, leerPlazo } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { bdns } from '../src/sources/bdns.ts';
import { config } from '../src/config.ts';
import { aCascada, crearFuenteEuCascada, descarteCascada, esRelevante, leerTemasCascada, paisesRestringidos } from '../src/sources/eu-cascada.ts';
import { euFt } from '../src/sources/eu-ft.ts';
import type { Fuente } from '../src/sources/source.ts';
import { bdSembrada, darPorCribadas, relojFijo } from './support/bd.ts';
import { AHORA_EU_FT, ESCENARIOS, esSedia, fetchGrabado } from './support/grabaciones.ts';

const cascada = crearFuenteEuCascada(() => ({ pausaMs: 0, maxPeticiones: 4 }));
const RELEVANTE = 'cascada:13903'; // WoodStock: grants de hasta 50.000 € para soluciones de madera infrautilizada del bosque, ONG admitidas, UE + asociados
const OTRO_PAIS = 'cascada:10941'; // NCC Estonia: ayudas a start-ups registradas en Estonia
const TITULO_PAIS_UE = 'cascada:15882'; // RISTANC: «Slovenian seas», pero abierta a entidades de cualquier Estado miembro: pasa a la criba, que decide por el territorio
const AJENO = 'cascada:12902'; // Phortify: becas de prácticas en fotónica

async function pasada(db: DatabaseSync, fuentes: Fuente[], fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) {
  return ejecutarRadar({ db, fetch, reloj: relojFijo(AHORA_EU_FT), fuentes, ganadores: false, parecidas: false, ...extra }, { diasAtras: 7 });
}
const fila = (db: DatabaseSync, id: string) => db.prepare('SELECT * FROM convocatorias WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;

describe('fuente EU en cascada (FSTP)', () => {
  test('la relevante y elegible llega al ranking principal con su enlace; la de otro país y la ajena quedan descartadas con motivo', async () => {
    const db = bdSembrada();
    const r = await pasada(db, [cascada], fetchGrabado({ euCascada: true }));
    assert.equal(r.conErrores, false);
    const f = r.fuentes[0];
    assert.equal(f.fuente, 'eu_cascada');
    assert.equal(f.recibidas, 109);
    assert.equal(f.candidatas + f.descartadas, f.recibidas);
    assert.ok(f.candidatas >= 40 && f.candidatas < 70, `candidatas: ${f.candidatas}`);

    const c = fila(db, RELEVANTE)!;
    assert.equal(c.fuente, 'eu_cascada');
    assert.equal(c.fuente_id, '13903');
    assert.equal(c.descarte_regla, null);
    assert.equal(c.organo_nivel1, 'UE');
    assert.equal(c.organo_nivel2, 'WoodStock');
    assert.equal(c.organo_nivel3, 'Horizon Europe');
    assert.equal(c.url, 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/competitive-calls-cs/45656490');

    const otro = fila(db, OTRO_PAIS)!;
    assert.equal(otro.descarte_regla, 'pais');
    assert.match(String(otro.descarte_motivo), /Estonia/);
    assert.equal(fila(db, TITULO_PAIS_UE)!.descarte_regla, null);
    const ajeno = fila(db, AJENO)!;
    assert.equal(ajeno.descarte_regla, 'tema');
    assert.match(String(ajeno.descarte_motivo), /Fuera de los temas del perfil/);

    darPorCribadas(db);
    await pasada(db, [cascada], fetchGrabado({ euCascada: true })); // con la condición de ámbito aceptada ya está en juego: se calcula el plazo
    assert.equal(leerPlazo(db, RELEVANTE, '2026-11-13')!.fechaCierre, '2026-12-15');
    const api = crearApi({ db, reloj: { now: () => AHORA_EU_FT }, fuentes: [cascada] });
    const semana = await (await api.request('/semana')).json() as { convocatorias: { id: string; fuente: string; seccion: string; url: string }[] };
    const x = semana.convocatorias.find((y) => y.id === RELEVANTE)!;
    assert.ok(x, 'la cascada relevante está en el ranking');
    assert.equal(x.fuente, 'eu_cascada'); // el chip "UE · en cascada" de la web sale de esta fuente
    assert.notEqual(x.seccion, 'consorcio', 'va en el ranking principal, no en la sección de consorcio');
    assert.ok(!semana.convocatorias.some((y) => y.id === OTRO_PAIS || y.id === AJENO));

    const ficha = await (await api.request(`/convocatorias/${encodeURIComponent(RELEVANTE)}`)).json() as { fuente: string; enlaces: { tipo: string; url: string }[] };
    assert.equal(ficha.fuente, 'eu_cascada');
    assert.deepEqual(ficha.enlaces.map((e) => e.tipo), ['ficha']);
  });

  test('es idempotente: otra pasada no duplica filas', async () => {
    const db = bdSembrada();
    await pasada(db, [cascada], fetchGrabado({ euCascada: true }));
    const n = (db.prepare('SELECT COUNT(*) AS n FROM convocatorias').get() as { n: number }).n;
    const r2 = await pasada(db, [cascada], fetchGrabado({ euCascada: true }));
    assert.equal(r2.fuentes[0].nuevas, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM convocatorias').get() as { n: number }).n, n);
  });

  test('un fallo del portal queda en el registro y no impide BDNS; y al revés', async () => {
    const db = bdSembrada();
    const grabado = fetchGrabado();
    const portalCaido = ((url: string, init?: RequestInit) => (esSedia(String(url)) ? Promise.resolve(new Response('Service Unavailable', { status: 503 })) : grabado(url, init))) as typeof fetch;
    const e = ESCENARIOS.agosto2026;
    const r = await ejecutarRadar({ db, fetch: portalCaido, reloj: relojFijo(e.ahora), fuentes: [bdns, euFt, cascada], ganadores: false, parecidas: false }, { diasAtras: e.diasAtras });
    const [rb, rft, rc] = r.fuentes;
    assert.equal(rb.errores.length, 0);
    assert.ok(rb.candidatas > 0 && fila(db, 'bdns:923290'));
    assert.equal(rc.fuente, 'eu_cascada');
    assert.equal(rc.recibidas, 0);
    assert.match(rc.errores.join(' '), /Funding & Tenders \(cascada\) 503/);
    assert.match(rft.errores.join(' '), /503/); // cada fuente falla por su cuenta
    assert.equal(r.conErrores, true);

    const db2 = bdSembrada();
    const bueno = fetchGrabado({ euCascada: true });
    const bdnsCaido = ((url: string, init?: RequestInit) => (esSedia(String(url)) ? bueno(url, init) : Promise.reject(new Error('red caída')))) as typeof fetch;
    const r2 = await ejecutarRadar({ db: db2, fetch: bdnsCaido, reloj: relojFijo(AHORA_EU_FT), fuentes: [bdns, cascada], ganadores: false, parecidas: false }, { diasAtras: 7 });
    assert.match(r2.fuentes[0].errores.join(' '), /Fallo de la fuente/);
    assert.ok(r2.fuentes[1].candidatas >= 40);
    assert.ok(fila(db2, RELEVANTE));
  });

  test('politeness: pausa entre páginas y tope de peticiones, que queda registrado', async () => {
    const db = bdSembrada();
    const grabado = fetchGrabado({ euCascada: true });
    let peticiones = 0;
    const contado = ((url: string, init?: RequestInit) => { peticiones++; return grabado(url, init); }) as typeof fetch;
    const pausas: number[] = [];
    const limitada = crearFuenteEuCascada(() => ({ pausaMs: 500, maxPeticiones: 2 }));
    const r = await pasada(db, [limitada], contado, { dormir: async (ms: number) => { pausas.push(ms); } });
    assert.equal(peticiones, 2);
    assert.deepEqual(pausas, [500]);
    assert.match(r.fuentes[0].errores.join(' '), /Tope de 2 peticiones/);
    assert.equal(r.fuentes[0].recibidas, 100);
  });

  test('criba y análisis (LLM falso): criterio de cascada con regla de territorio, sin consorcio, textos en inglés y respuesta en castellano', async () => {
    const db = bdSembrada();
    const peticiones: PeticionLlm[] = [];
    const vacio = { valor: null, cita: null, documento: null };
    const llm: Llm = {
      async generar(p) {
        peticiones.push(p);
        const datos = p.tarea === 'criba'
          ? { decision: p.mensaje.includes(`Convocatoria ${RELEVANTE}:`) ? 'puede_encajar' : 'descartar', motivo: 'Línea: Restauración; admite ONG', exigeSedeEnOtraComunidad: 'no' }
          : { elegibilidadEsfl: vacio, importeMaximoProyecto: vacio, importeTotal: vacio, plazo: vacio, cofinanciacion: vacio, requisitos: [], lineas: [], ideaProyecto: null, tituloCorto: 'WoodStock' };
        return { datos, modelo: p.modelo, uso: { entrada: 1000, salida: 100, cacheLectura: 0, cacheEscritura: 0 } };
      },
    };
    const r = await pasada(db, [cascada], fetchGrabado({ euCascada: true }), { llm });
    assert.equal(r.conErrores, false);
    const criba = peticiones.find((p) => p.tarea === 'criba' && p.mensaje.includes(`Convocatoria ${RELEVANTE}:`))!;
    assert.match(criba.sistema, /están en inglés\. Responde en castellano/);
    assert.match(criba.sistema, /CONVOCATORIAS EN CASCADA DE LA UE/);
    assert.match(criba.sistema, /sin consorcio/);
    assert.match(criba.mensaje, /Condición de ámbito: el proyecto debe poder ejecutarse en .*Comunidad de Madrid/);
    assert.match(criba.mensaje, /abierta a toda España o a toda la UE/);
    assert.match(criba.mensaje, /<documento-[0-9a-f]{16} titulo="Quién puede presentarse y cómo \(inglés\)">/);
    assert.match(criba.mensaje, /non-profit organisation/);
    assert.doesNotMatch(criba.sistema, /socia de un consorcio/); // el criterio de eu_ft no se mezcla
    assert.match(peticiones.find((p) => p.tarea === 'analisis')!.sistema, /citas, que se copian literalmente en inglés/);
    assert.equal(leerFases(db, RELEVANTE).find((f) => f.fase === 'criba_llm')?.descarta, false);
    assert.ok(leerFases(db, RELEVANTE).find((f) => f.fase === 'analisis'));
    assert.equal(peticiones.filter((p) => p.tarea === 'analisis').length, 1);
  });
});

describe('aCascada y país', () => {
  const base = (m: Record<string, string[]>) => ({ metadata: { callccm2Id: ['1'], ccm2Id: ['2'], callTitle: ['Nature call'], status: ['31094502'], deadlineDate: ['2027-03-01T17:00:00.000+0000'], ...m } });

  test('sin fecha límite futura, cerrada o sin id no es convocatoria', () => {
    assert.equal(aCascada(base({ deadlineDate: ['2026-01-01T00:00:00.000+0000'] }), '2026-11-13'), null);
    assert.equal(aCascada(base({ status: ['31094503'] }), '2026-11-13'), null);
    assert.equal(aCascada(base({ callccm2Id: [] }), '2026-11-13'), null);
    assert.equal(aCascada(base({}), '2026-11-13')?.id, '1');
  });

  test('países: limitada a otro país descarta; con España o «Estados miembros» no', () => {
    const c = (quienPuede: string, titulo = 'Call', proyecto = 'Proyecto') => ({ titulo, tituloConvocatoria: null, proyecto, quienPuede, descripcion: '', masInformacion: '' });
    assert.deepEqual(paisesRestringidos(c('Applicants must be legally established in Hungary or Slovakia.')), ['Hungría', 'Eslovaquia']);
    assert.deepEqual(paisesRestringidos(c('Applicants must be registered in Spain, Portugal or France.')), []);
    assert.deepEqual(paisesRestringidos(c('Applicants must be based in an EU Member State, e.g. Germany.')), []);
    assert.deepEqual(paisesRestringidos(c('Open to all.', 'Funding for Estonian SMEs')), ['Estonia']);
    assert.deepEqual(paisesRestringidos(c('Open to all.', 'Nature call')), []);
    // Título con país, pero abierta a todos los Estados miembros: no se descarta en código (decide la criba con la condición de ámbito).
    assert.deepEqual(paisesRestringidos(c('Applicants must be established in an EU Member State or an associated country.', 'Restoration in Slovenian seas')), []);
  });

  test('recall del tema: una mención en el cuerpo basta; lo claramente ajeno (ciber, becas) sigue fuera; las raíces y el umbral salen de la configuración', () => {
    const temas = leerTemasCascada();
    const x = (titulo: string, cuerpo = '') => ({ id: '1', titulo, tituloConvocatoria: null, proyecto: 'P', descripcion: cuerpo, quienPuede: '', masInformacion: '' }) as Parameters<typeof esRelevante>[0];
    assert.equal(temas.mencionesCuerpo, 1);
    assert.ok(esRelevante(x('Open Call for NBS pilots in cities', 'We fund nature-based solutions for urban heat.'), temas));
    assert.ok(esRelevante(x('Open Call for local pilots', 'Pilots must contribute to the green transition.'), temas), 'una sola mención en el cuerpo');
    assert.ok(esRelevante(x('Citizen labs', 'Water quality monitoring by volunteers.'), temas));
    assert.ok(!esRelevante(x('Cybersecurity boost for SMEs', 'Funding for penetration testing and SOC services.'), temas));
    assert.ok(!esRelevante(x('Master scholarship in photonics', 'Tuition fee waiver for students.'), temas));
    // Configuración: raíces extra por entorno y umbral propio.
    const extra = leerTemasCascada({ ...config.euCascada, terminosExtra: ['photonic'], mencionesCuerpo: 2 });
    assert.ok(esRelevante(x('Master scholarship in photonics'), extra));
    assert.ok(!esRelevante(x('Local pilots', 'One green mention.'), extra));
    // El motivo del descarte sale de las líneas del perfil.
    const d = descarteCascada(x('Cybersecurity boost for SMEs'), temas, ['Restauración forestal', 'Educación ambiental']);
    assert.equal(d?.regla, 'tema');
    assert.match(d!.motivo, /Restauración forestal; Educación ambiental/);
  });
});
