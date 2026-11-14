// Fuente placsp (licitaciones de la Plataforma de Contratación del Sector Público) a través del motor: entradas ATOM reales grabadas en test/fixtures/placsp
// (scripts/record-placsp.ts) con el reloj fijo AHORA_PLACSP, LLM falso y BD en memoria. Se comprueba la BD, la paginación con cursor, los topes, la API y la puntuación.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { versionCriba, versionLineas } from '../src/perfil.ts';
import { guardarEstadoFuente, guardarFase, leerEstadoFuente, leerFases, leerPerfil, leerPlazo } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { leerDocumentos } from '../src/documentos.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { type ConfigPuntuacion, leerConfigPuntuacion, parsearImporteEuros, puntuar } from '../src/puntuacion.ts';
import { ubicacionEnAmbito } from '../src/rules.ts';
import { aLicitacion, type Cobertura, crearFuentePlacsp, leerCobertura, fichaLicitacion, leerFiltroPlacsp, type Licitacion, type OpcionesFuentePlacsp, parsearXml, temaDeLicitacion, trocearFeed } from '../src/sources/placsp.ts';
import type { Fuente } from '../src/sources/source.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, RUTA_PUNTUACION, relojFijo } from './support/bd.ts';
import { AHORA_PLACSP, DIR_PLACSP, fetchPlacsp, RECHAZO_PLACSP, URL_FEED_PLACSP, URL_PAGINA_2_PLACSP } from './support/grabaciones.ts';

const OPCIONES: OpcionesFuentePlacsp = { urlFeed: URL_FEED_PLACSP, maxPaginas: 5, maxBytesPagina: 5_000_000, maxBytesTotal: 20_000_000, pausaMs: 0, timeoutMs: 10_000 };
const placsp = (o: Partial<OpcionesFuentePlacsp> = {}) => crearFuentePlacsp(() => ({ ...OPCIONES, ...o }));

const RELEVANTE = 'licitacion:20797834'; // jardinería de la Base Coronel Maté (Madrid, 24.793 €): pequeña, de Madrid y del tema
const GRANDE = 'licitacion:20906461'; // jardinería de edificios, Madrid, 4,1 M€: pasa el pre-filtro, la criba la da por fuera de escala
const OBRA_PARQUE = 'licitacion:20867623'; // bike park en Paracuellos de Jarama (CPV de paisajismo)
const PODA = 'licitacion:20806710'; // poda del arbolado municipal en Guadalajara (territorio admitido)
const OTRO_TERRITORIO = 'licitacion:20906084'; // plagas y poda en Badajoz: tema sí, territorio no
const FUERA_DE_TEMA = 'licitacion:20906046'; // transporte escolar en San Fernando de Henares: Madrid, sin tema
const YA_CERRADA = 'licitacion:20787920'; // jardinería en estado EV: ya no se puede ofertar
const SUMINISTRO = 'licitacion:20906429'; // repuestos de maquinaria forestal: un suministro no es servicio ni obra

const fila = (db: DatabaseSync, id: string) => db.prepare('SELECT * FROM convocatorias WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
const ids = (db: DatabaseSync) => (db.prepare("SELECT id FROM convocatorias WHERE fuente = 'placsp' ORDER BY id").all() as { id: string }[]).map((r) => r.id);

async function pasada(db: DatabaseSync, fuentes: Fuente[], fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}, ahora = AHORA_PLACSP) {
  return ejecutarRadar({ db, fetch, reloj: relojFijo(ahora), fuentes, ganadores: false, parecidas: false, ...extra }, { diasAtras: 7 });
}

describe('fuente PLACSP (licitaciones)', () => {
  test('pasa la licitación pequeña de Madrid del tema; fuera la de otro territorio, la ajena al tema, la ya cerrada (EV) y el suministro', async () => {
    const db = bdSembrada();
    const r = await pasada(db, [placsp()], fetchPlacsp());
    assert.equal(r.conErrores, false);
    const f = r.fuentes[0];
    assert.equal(f.fuente, 'placsp');
    assert.deepEqual(ids(db), [PODA, OBRA_PARQUE, GRANDE, RELEVANTE].sort());
    assert.equal(f.recibidas, 4);
    for (const fuera of [OTRO_TERRITORIO, FUERA_DE_TEMA, YA_CERRADA, SUMINISTRO]) assert.equal(fila(db, fuera), undefined, `${fuera} no se guarda`);
    // El contador del pre-filtro queda en los avisos de la fuente (las entradas leídas, las que pasan cada filtro y por qué paró la paginación).
    assert.match(f.avisos.join(' '), /2 páginas .*8 entradas leídas, 7 en plazo \(PUB\), 7 con plazo de ofertas vigente, 5 pasan el pre-filtro de tema.*, 4 en el territorio del perfil; parada: fin del feed/);

    const c = fila(db, RELEVANTE)!;
    assert.equal(c.fuente, 'placsp');
    assert.equal(c.fuente_id, '20797834');
    assert.equal(c.tipo, 'licitacion');
    assert.equal(c.descarte_regla, null);
    assert.equal(c.abierto, 1);
    assert.equal(c.organo_nivel1, 'ESTADO');
    assert.match(String(c.organo_nivel2), /Helicópteros/);
    assert.equal(c.condicion, null, 'ES30 está dentro del ámbito: sin condición');
    assert.deepEqual(JSON.parse(String(c.regiones)), ['ES30']);
    assert.match(String(c.url), /^https:\/\/contrataciondelestado\.es\//);
    const l = (JSON.parse(String(c.datos)) as { licitacion: Licitacion }).licitacion;
    assert.equal(l.presupuestoSinIva, 24793.39);
    assert.equal(l.plazoOfertas?.fecha, '2026-11-16');
    assert.deepEqual(l.cpv, ['77310000']);
    assert.equal(l.estado, 'PUB');
    assert.equal(l.tipoContrato, 'Servicios');
    assert.ok(l.documentos.length >= 1 && l.documentos.every((d) => d.url.startsWith('https://contrataciondelestado.es/FileSystem/')));
    // La de Guadalajara está dentro por su NUTS ES424 (provincia admitida del perfil).
    assert.deepEqual(JSON.parse(String(fila(db, PODA)!.regiones)), ['ES424']);
  });

  test('plazo literal desde el anuncio y es idempotente: otra pasada no duplica', async () => {
    const db = bdSembrada();
    await pasada(db, [placsp()], fetchPlacsp());
    await pasada(db, [placsp()], fetchPlacsp()); // calcula los plazos de lo que está en juego
    assert.equal(leerPlazo(db, RELEVANTE, '2026-11-13')!.fechaCierre, '2026-11-16');
    assert.equal(leerPlazo(db, RELEVANTE, '2026-11-13')!.tipo, 'literal');
    assert.equal(leerPlazo(db, RELEVANTE, '2026-11-13')!.diasHastaCierre, 3);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM convocatorias').get() as { n: number }).n;
    await pasada(db, [placsp({ ignorarCursor: true })], fetchPlacsp());
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM convocatorias').get() as { n: number }).n, n);
  });

  test('pagina hacia atrás solo hasta lo ya leído: la segunda pasada no pide la página 2, y una entrada nueva sí entra', async () => {
    const db = bdSembrada();
    const p1: string[] = [];
    await pasada(db, [placsp()], fetchPlacsp(p1));
    assert.equal(p1.length, 2, 'primera vez: lee las dos páginas hasta el final del feed');
    assert.ok(leerEstadoFuente(db, 'placsp', 'cobertura'), 'la cobertura queda guardada');

    const p2: string[] = [];
    const r2 = await pasada(db, [placsp()], fetchPlacsp(p2));
    assert.deepEqual(p2, [URL_FEED_PLACSP], 'todo lo de la página 1 ya estaba leído: no sigue a la 2');
    assert.equal(r2.fuentes[0].recibidas, 0);
    assert.match(r2.fuentes[0].avisos.join(' '), /5 ya vistas.*parada: llegó a lo ya leído/);

    // La misma entrada real de la gran jardinería, con una actualización posterior (otro presupuesto): entra de nuevo y la página 2 sigue sin pedirse.
    const pagina1 = readFileSync(`${DIR_PLACSP}/pagina_1.atom`, 'utf8');
    const entrada = pagina1.match(/<entry>[\s\S]*?<\/entry>/g)!.find((e) => e.includes('licitacionesPerfilContratante/20906461'))!;
    const nueva = entrada.replace(/<updated>[^<]+<\/updated>/, '<updated>2026-11-13T21:00:00.000+01:00</updated>').replace(/<cbc:TaxExclusiveAmount currencyID="EUR">[\d.]+</, '<cbc:TaxExclusiveAmount currencyID="EUR">99000<');
    assert.notEqual(nueva, entrada);
    const modificada = pagina1.replace('<entry>', `${nueva}\n<entry>`);
    const p3: string[] = [];
    const r3 = await pasada(db, [placsp()], fetchPlacsp(p3, { 1: modificada }));
    assert.deepEqual(p3, [URL_FEED_PLACSP]);
    assert.equal(r3.fuentes[0].recibidas, 1);
    assert.equal(r3.fuentes[0].nuevas, 0, 'la misma licitación: se actualiza, no se duplica');
    assert.equal((JSON.parse(String(fila(db, GRANDE)!.datos)) as { licitacion: Licitacion }).licitacion.presupuestoSinIva, 99000);
  });

  test('sin cursor se para a los `diasAtras` días y con `ignorarCursor` (relleno) no se para en lo ya leído', async () => {
    const db = bdSembrada();
    const p: string[] = [];
    // Reloj muy posterior: la primera página ya es más antigua que el horizonte de 7 días: no pide la segunda.
    const r = await pasada(db, [placsp()], fetchPlacsp(p), {}, new Date('2026-12-30T09:00:00Z'));
    assert.equal(p.length, 1);
    assert.match(r.fuentes[0].avisos.join(' '), /parada: llegó a 7 días atrás/);
    guardarEstadoFuente(db, 'placsp', 'cobertura', JSON.stringify({ hasta: '2030-01-01T00:00:00.000Z', huecos: [] }), new Date());
    const q: string[] = [];
    await pasada(db, [placsp({ ignorarCursor: true })], fetchPlacsp(q));
    assert.equal(q.length, 2, 'el relleno lee las dos páginas aunque el cursor diga que ya está todo');
  });

  test('tope de páginas, pausa entre páginas y aviso de lo que queda sin leer', async () => {
    const db = bdSembrada();
    const pausas: number[] = [];
    const p: string[] = [];
    const r = await pasada(db, [placsp({ maxPaginas: 1, pausaMs: 1500 })], fetchPlacsp(p), { dormir: async (ms: number) => { pausas.push(ms); } });
    assert.equal(p.length, 1);
    assert.deepEqual(pausas, []);
    assert.match(r.fuentes[0].avisos.join(' '), /parada: tope de 1 páginas/);
    assert.match(r.fuentes[0].avisos.join(' '), /quedó sin leer en 1 tramo/);
    const db2 = bdSembrada();
    const pausas2: number[] = [];
    await pasada(db2, [placsp({ pausaMs: 1500 })], fetchPlacsp(), { dormir: async (ms: number) => { pausas2.push(ms); } });
    assert.deepEqual(pausas2, [1500], 'una pausa antes de la segunda página');
  });

  test('tope de bytes: una página que se pasa falla la fuente (aislada de las demás); un fallo en la segunda página deja lo ya leído', async () => {
    const db = bdSembrada();
    const r = await pasada(db, [placsp({ maxBytesPagina: 10_000 })], fetchPlacsp());
    assert.match(r.fuentes[0].errores.join(' '), /Fallo de la fuente: Feed de licitaciones: demasiado grande/);
    assert.equal(r.conErrores, true);
    assert.equal(ids(db).length, 0);

    const db2 = bdSembrada();
    const bueno = fetchPlacsp();
    const sinSegunda = (async (u: string, i?: RequestInit) => (u === URL_FEED_PLACSP ? bueno(u, i) : new Response('Service Unavailable', { status: 503 }))) as typeof fetch;
    const r2 = await pasada(db2, [placsp()], sinSegunda);
    assert.match(r2.fuentes[0].errores.join(' '), /Página 2 del feed de licitaciones: HTTP 503/);
    assert.ok(ids(db2).includes(GRANDE), 'lo de la página 1 se guarda');
    assert.ok(!ids(db2).includes(RELEVANTE));

    const db3 = bdSembrada();
    const caido = (async () => { throw new Error('red caída'); }) as unknown as typeof fetch;
    const r3 = await pasada(db3, [placsp()], caido);
    assert.match(r3.fuentes[0].errores.join(' '), /Fallo de la fuente: Feed de licitaciones: red caída/);
  });

  test('el enlace «next» sale de datos: solo se sigue si es de la Plataforma y de la sindicación', async () => {
    const db = bdSembrada();
    const malo = readFileSync(`${DIR_PLACSP}/pagina_1.atom`, 'utf8').replace(/<link href="[^"]*" rel="next"\/>/, '<link href="http://127.0.0.1:8080/sindicacion/x.atom" rel="next"/>');
    const p: string[] = [];
    const r = await pasada(db, [placsp()], fetchPlacsp(p, { 1: malo }));
    assert.deepEqual(p, [URL_FEED_PLACSP], 'no pide la URL interna');
    assert.match(r.fuentes[0].errores.join(' '), /enlace "next" no permitido/);
  });

  test('criba y análisis (LLM falso): la grande se da por fuera de escala; el análisis cita el anuncio y los pliegos rechazados no lo tumban', async () => {
    const db = bdSembrada();
    const peticiones: PeticionLlm[] = [];
    const llm: Llm = {
      async generar(p) {
        peticiones.push(p);
        let datos: unknown;
        if (p.tarea === 'criba') {
          const grande = p.mensaje.includes('4.101.333');
          const encaja = p.mensaje.includes('Base Coronel') || p.mensaje.includes('Bike Park');
          datos = { decision: encaja && !grande ? 'puede_encajar' : 'descartar', motivo: grande ? 'Probablemente fuera de escala: 4.101.333,88 € sin IVA' : encaja ? 'Línea: Restauración de ecosistemas; mantenimiento de jardinería' : 'Mantenimiento rutinario de arbolado urbano', exigeSedeEnOtraComunidad: 'no' };
        } else {
          const linea = (re: RegExp) => re.exec(p.mensaje)?.[0] ?? '';
          const cita = (valor: string, textoCita: string) => (textoCita ? { valor, cita: textoCita, documento: 'Anuncio de licitación (PLACSP)' } : { valor: '', cita: '', documento: '' });
          const vacio = { valor: '', cita: '', documento: '' };
          const presupuesto = linea(/Presupuesto base de licitación sin IVA: [\d.,]+ €/);
          const plazo = linea(/Plazo de presentación de ofertas: hasta el (\d\d\/\d\d\/\d{4})/);
          datos = {
            presupuestoBase: cita(/[\d.,]+ €/.exec(presupuesto)?.[0] ?? '', presupuesto),
            plazo: cita(/\d\d\/\d\d\/\d{4}/.exec(plazo)?.[0] ?? '', plazo),
            duracion: vacio, lotes: cita('Sin lotes', 'Sin lotes.'), solvenciaEconomica: vacio, solvenciaTecnica: vacio, clasificacion: vacio,
            ponderacionPrecio: cita('100', 'Esto no está en los textos 100'), ponderacionTecnica: vacio, reservaSocial: vacio,
            requisitos: [], lineas: [{ linea: 'Restauración de ecosistemas', motivo: 'Plantación y mejora de zonas verdes', cita: '', documento: '' }],
            ideaProyecto: 'Presentar oferta por 80.000 € para el mantenimiento con plantas autóctonas.', tituloCorto: 'Jardinería de la Base Coronel Maté',
          };
        }
        return { datos, modelo: p.modelo, uso: { entrada: 1000, salida: 100, cacheLectura: 0, cacheEscritura: 0 } };
      },
    };
    const r = await pasada(db, [placsp()], fetchPlacsp(), { llm });
    await pasada(db, [placsp()], fetchPlacsp(), { llm }); // segunda: plazos y puntuación con lo ya analizado
    assert.equal(r.conErrores, false, JSON.stringify(r.fases.map((f) => f.errores)));

    // Criba: el criterio de licitaciones con el umbral del perfil, y las que no pasan, descartadas con su motivo.
    const criba = peticiones.find((p) => p.tarea === 'criba' && p.mensaje.includes(RELEVANTE))!;
    assert.match(criba.sistema, /LICITACIONES PÚBLICAS/);
    assert.match(criba.sistema, /no pasa de 300\.000 €/);
    assert.match(criba.sistema, /Probablemente fuera de escala/);
    assert.match(criba.mensaje, /^Licitación licitacion:20797834:/m);
    assert.match(criba.mensaje, /Presupuesto base de licitación sin IVA: 24\.793,39 €/);
    assert.match(criba.mensaje, /Condición de ámbito: ninguna\./);
    assert.equal(leerFases(db, RELEVANTE).find((f) => f.fase === 'criba_llm')?.descarta, false);
    const grande = leerFases(db, GRANDE).find((f) => f.fase === 'criba_llm')!;
    assert.equal(grande.descarta, true);
    assert.match(grande.motivo!, /^Probablemente fuera de escala/);

    // Análisis (Sonnet) solo de las que pasaron la criba (Bike Park y la pequeña), con su propio esquema y prompt.
    const analisis = peticiones.filter((p) => p.tarea === 'analisis');
    assert.equal(analisis.length, 2);
    assert.match(analisis[0].sistema, /Analizas una licitación pública/);
    assert.doesNotMatch(analisis[0].sistema, /subvenciones para una organización/);
    assert.ok('ponderacionPrecio' in (analisis[0].esquema.properties as object));
    const a = (leerFases(db, RELEVANTE).find((f) => f.fase === 'analisis')!.datos as { analisis: Record<string, any> }).analisis;
    assert.equal(a.tipo, 'licitacion');
    assert.equal(a.presupuestoBase.valor, '24.793,39 €');
    assert.equal(a.plazo.valor, '16/11/2026');
    assert.equal(a.ponderacionPrecio.valor, null, 'una cita que no está en los textos deja el dato como desconocido');
    assert.ok(a.correcciones.some((x: string) => /ponderacionPrecio: la cita no aparece/.test(x)));
    assert.match(a.ideaProyecto, /\(importe por confirmar\)/, 'un importe inventado se quita de la idea');
    assert.deepEqual(a.lineas.map((l: { linea: string }) => l.linea), ['Restauración de ecosistemas']);
    // Los PDF de los pliegos: la Plataforma los rechaza («Request Rejected»): se anota, no se manda al LLM como si fueran el pliego.
    const datosFase = leerFases(db, RELEVANTE).find((f) => f.fase === 'analisis')!.datos as { documentos: { titulo: string }[]; documentosConError: string[] };
    assert.deepEqual(datosFase.documentos.map((d) => d.titulo), ['Anuncio de licitación (PLACSP)']);
    assert.ok(datosFase.documentosConError.some((e) => /Request Rejected/.test(e)));
    assert.ok(!analisis[0].mensaje.includes('Request Rejected'));

    // API: la página de licitaciones, el contador, la frase de "Esta semana" y la ficha; y nada de esto en las convocatorias.
    const api = crearApi({ db, reloj: { now: () => AHORA_PLACSP }, fuentes: [placsp()] });
    const lista = await (await api.request('/licitaciones')).json() as {
      presupuestoMaximo: number; paraPreparar: string[]; conMenosEncaje: string[];
      licitaciones: { id: string; plazo: { diasHastaCierre: number } | null; puntuacion: { total: number; analizada: boolean; factores: { id: string; subpuntuacion: number; explicacion: string }[] }; tarjeta: { presupuesto: number; fueraDeEscala: boolean; lotes: string; porQue: string; solvencia: { origen: string } | null; tituloCorto: string } }[];
    };
    assert.equal(lista.presupuestoMaximo, 300_000);
    assert.deepEqual(lista.licitaciones.map((l) => l.id).sort(), [RELEVANTE, OBRA_PARQUE].sort());
    const x = lista.licitaciones.find((l) => l.id === RELEVANTE)!;
    assert.deepEqual(x.puntuacion.factores.map((f) => f.id), ['encaje', 'escala', 'plazo', 'viabilidad', 'precio']);
    assert.equal(x.puntuacion.analizada, true);
    assert.equal(x.tarjeta.presupuesto, 24793.39);
    assert.equal(x.tarjeta.fueraDeEscala, false);
    assert.equal(x.tarjeta.lotes, 'Sin lotes');
    assert.equal(x.tarjeta.tituloCorto, 'Jardinería de la Base Coronel Maté');
    assert.equal(x.plazo!.diasHastaCierre, 3);
    assert.ok(x.puntuacion.factores.find((f) => f.id === 'escala')!.subpuntuacion === 1);
    assert.ok(x.tarjeta.solvencia === null || x.tarjeta.solvencia.origen === 'anuncio');
    assert.ok(!lista.licitaciones.some((l) => l.id === GRANDE), 'la de 4,1 M€ no pasó la criba');

    const sem = await (await api.request('/semana')).json() as { convocatorias: { id: string }[]; resumen: { licitaciones: number } };
    assert.equal(sem.resumen.licitaciones, 2);
    assert.ok(!sem.convocatorias.some((c) => c.id.startsWith('licitacion:')), 'las licitaciones no se mezclan con las convocatorias de «Esta semana»');
    assert.deepEqual(await (await api.request('/contadores')).json(), { estaSemana: 0, empresas: 0, licitaciones: 2 });

    const ficha = await (await api.request(`/convocatorias/${encodeURIComponent(RELEVANTE)}`)).json() as {
      fuente: string; tipo: string; enlaces: { tipo: string }[]; plazo: { fechaCierre: string }; puntuacion: { total: number } | null;
      licitacion: { anuncio: { expediente: string; presupuestoSinIva: number; cpv: string[] }; esAnalisisLicitacion: boolean } | null; analisis: { campos: { tipo: string } } | null;
    };
    assert.equal(ficha.fuente, 'placsp');
    assert.equal(ficha.licitacion!.anuncio.presupuestoSinIva, 24793.39);
    assert.equal(ficha.licitacion!.esAnalisisLicitacion, true);
    assert.equal(ficha.analisis!.campos.tipo, 'licitacion');
    assert.equal(ficha.enlaces[0].tipo, 'ficha');
    assert.ok(ficha.puntuacion!.total > 0);

    // Decisiones del equipo: igual que en las convocatorias. Descartar la saca de la página; "nos interesa" la deja y sale en esa lista.
    const des = await api.request(`/decisiones/${encodeURIComponent(RELEVANTE)}`, { method: 'PUT', body: JSON.stringify({ decision: 'descartada', motivo: 'Otro', detalle: 'prueba' }), headers: { 'content-type': 'application/json' } });
    assert.equal(des.status, 200);
    assert.deepEqual(((await (await api.request('/licitaciones')).json()) as { licitaciones: { id: string }[] }).licitaciones.map((l) => l.id), [OBRA_PARQUE]);
    const ni = await api.request(`/decisiones/${encodeURIComponent(OBRA_PARQUE)}`, { method: 'PUT', body: JSON.stringify({ decision: 'nos_interesa' }), headers: { 'content-type': 'application/json' } });
    assert.equal(ni.status, 200);
    assert.equal(((await (await api.request('/equipo/nos-interesa')).json()) as { convocatorias: { id: string }[] }).convocatorias[0].id, OBRA_PARQUE);
  });
});


describe('piezas de la fuente', () => {
  const pagina = trocearFeed(readFileSync(`${DIR_PLACSP}/pagina_2.atom`, 'utf8'));
  const entrada = (id: string) => pagina.entradas.find((e) => e.includes(`licitacionesPerfilContratante/${id}`))!;
  const perfil = JSON.parse(readFileSync(new URL('../seed/perfil.json', import.meta.url), 'utf8')).perfil;

  test('trocea el feed (entradas, enlace next y fechas) y parsea una entrada CODICE', () => {
    assert.equal(pagina.entradas.length, 3);
    assert.equal(pagina.siguiente, null);
    assert.equal(trocearFeed(readFileSync(`${DIR_PLACSP}/pagina_1.atom`, 'utf8')).siguiente, 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3_20261113_202142.atom');
    const l = aLicitacion(parsearXml(entrada('20797834')).h[0])!;
    assert.equal(l.id, '20797834');
    assert.equal(l.estado, 'PUB');
    assert.match(l.titulo, /jardinería/i);
    assert.equal(l.nivelOrgano, 'ESTADO');
    assert.equal(l.presupuestoSinIva, 24793.39);
    assert.ok(l.presupuestoConIva! > l.presupuestoSinIva!);
    assert.equal(l.plazoOfertas?.fecha, '2026-11-16');
    assert.match(l.plazoOfertas?.hora ?? '', /^\d\d:\d\d$/);
    assert.match(fichaLicitacion({ url: 'https://x' } as Convocatoria, l), /Presupuesto base de licitación sin IVA: 24\.793,39 €/);
  });

  test('lotes, solvencia y criterios de adjudicación del anuncio', () => {
    const grande = aLicitacion(parsearXml(trocearFeed(readFileSync(`${DIR_PLACSP}/pagina_1.atom`, 'utf8')).entradas.find((e) => e.includes('20906429'))!).h[0])!;
    assert.ok(grande.lotes.length >= 2, 'el suministro de repuestos va por lotes');
    assert.ok(grande.lotes.every((x) => x.nombre));
    const conCriterios = pagina.entradas.map((e) => aLicitacion(parsearXml(e).h[0])!).find((l) => l.criterios.length > 0)!;
    assert.ok(conCriterios.criterios.some((c) => c.tipo === 'OBJ' || c.tipo === 'SUBJ'));
    assert.ok(conCriterios.criterios.some((c) => c.peso !== null));
  });

  test('pre-filtro: CPV por prefijo (sin ceros finales) o palabra del título sin tildes; los CPV de formación general no pasan solos', () => {
    const f = leerFiltroPlacsp();
    const l = (cpv: string[], titulo = 'Servicio X') => ({ cpv, titulo, lotes: [] });
    assert.equal(temaDeLicitacion(l(['77231600']), f), 'cpv'); // repoblación forestal, dentro de 772
    assert.equal(temaDeLicitacion(l(['77312000']), f), 'cpv');
    assert.equal(temaDeLicitacion(l(['90721700']), f), 'cpv'); // protección de especies en peligro
    assert.equal(temaDeLicitacion(l(['92534000']), f), 'cpv');
    assert.equal(temaDeLicitacion(l(['80540000']), f), 'cpv');
    assert.equal(temaDeLicitacion(l(['80533100']), f), null, 'formación en informática');
    assert.equal(temaDeLicitacion(l(['45233222']), f), null, 'asfaltado');
    assert.equal(temaDeLicitacion(l(['72000000'], 'Programa de EDUCACIÓN AMBIENTAL y voluntariado'), f), 'palabra');
    assert.equal(temaDeLicitacion(l(['72000000'], 'Control de ailanto en la ribera del Jarama'), f), 'palabra');
    assert.equal(temaDeLicitacion(l(['72000000'], 'Plantación de árboles autóctonos'), f), 'palabra');
    assert.equal(temaDeLicitacion(l(['72000000'], 'Servicio de montaje de stands'), f), null, '«monte» no casa con «montaje»');
    assert.equal(temaDeLicitacion(l([], 'Obras en el Monte de Valdelatas'), f), 'palabra');
    // Extras por entorno.
    const extra = leerFiltroPlacsp({ rutaFiltro: new URL('../seed/licitaciones.json', import.meta.url).pathname, cpvExtra: ['90911200'], palabrasExtra: ['zanahoria'] });
    assert.equal(temaDeLicitacion(l(['90911200']), extra), 'cpv');
    assert.equal(temaDeLicitacion(l([], 'Cosecha de zanahorias'), extra), 'palabra');
  });

  test('ubicación frente al ámbito del perfil: NUTS dentro, parcial o fuera', () => {
    assert.equal(ubicacionEnAmbito(['ES300'], perfil), 'dentro');
    assert.equal(ubicacionEnAmbito(['ES30'], perfil), 'dentro');
    assert.equal(ubicacionEnAmbito(['ES416'], perfil), 'dentro', 'Segovia');
    assert.equal(ubicacionEnAmbito(['ES424'], perfil), 'dentro', 'Guadalajara');
    assert.equal(ubicacionEnAmbito(['ES412'], perfil), 'fuera', 'Burgos');
    assert.equal(ubicacionEnAmbito(['ES41'], perfil), 'parcial', 'Castilla y León entera: la criba mira la provincia');
    assert.equal(ubicacionEnAmbito(['ES'], perfil), 'parcial');
    assert.equal(ubicacionEnAmbito([], perfil), 'parcial');
    assert.equal(ubicacionEnAmbito(['ES523'], perfil), 'fuera');
    assert.equal(ubicacionEnAmbito(['ES523', 'ES300'], perfil), 'dentro', 'varios lugares: basta uno dentro');
  });

  test('un pliego que la Plataforma rechaza con «Request Rejected» no se lee como documento', async () => {
    const db = bdSembrada();
    const f = (async () => new Response(RECHAZO_PLACSP, { status: 200, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
    const l = await leerDocumentos(db, f, [{ titulo: 'Pliego', url: 'https://contrataciondelestado.es/FileSystem/servlet/GetDocumentByIdServlet?x=1' }], new Date());
    assert.deepEqual(l.textos, []);
    assert.equal(l.erroresTransitorios.length, 0, 'es definitivo: el análisis sigue con el anuncio');
    assert.match(l.errores.join(' '), /Request Rejected/);
  });
});

describe('puntuación de licitaciones', () => {
  const cfg: ConfigPuntuacion = leerConfigPuntuacion(RUTA_PUNTUACION);
  const conv = (l: Partial<Licitacion>): Convocatoria => ({
    id: 'licitacion:1', fuente: 'placsp', fuenteId: '1', titulo: 'T', organo: { nivel1: 'LOCAL', nivel2: 'Ayuntamiento', nivel3: null }, fechaPublicacion: '2026-11-13', url: 'https://x',
    tipo: 'licitacion', finalidad: null, regiones: ['ES300'], abierto: true,
    datos: { licitacion: { presupuestoSinIva: 50_000, lotes: [], criterios: [], solvenciaEconomica: [], ...l } },
  });
  const puntuar_ = (l: Partial<Licitacion>, dias: number | null = 20, escala = { presupuestoMaximo: 300_000, ingresosAnuales: 105_000 }) =>
    puntuar({ convocatoria: conv(l), analisis: null, importeMinimo: 3000, escalaLicitaciones: escala, plazo: dias === null ? null : { fechaCierre: '2026-12-03', tipo: 'literal', diasHastaCierre: dias } }, cfg);
  const factor = (p: ReturnType<typeof puntuar_>, id: string) => p.factores.find((f) => f.id === id)!;

  test('factores propios, con los pesos de seed/puntuacion.json', () => {
    const p = puntuar_({});
    assert.deepEqual(p.factores.map((f) => [f.id, f.peso]), [['encaje', 30], ['escala', 25], ['plazo', 15], ['viabilidad', 20], ['precio', 10]]);
    assert.equal(p.analizada, false);
    assert.equal(factor(p, 'encaje').conocido, false, 'sin analizar, el encaje es desconocido y no cuenta como bueno');
  });

  test('escala: a la medida vale 1; por encima del máximo del perfil (300 k€), 0 y «probablemente fuera de escala»; con lotes cuenta el más pequeño', () => {
    assert.equal(factor(puntuar_({ presupuestoSinIva: 24_793 }), 'escala').subpuntuacion, 1);
    assert.equal(factor(puntuar_({ presupuestoSinIva: 2_000 }), 'escala').subpuntuacion, 0.2);
    const grande = factor(puntuar_({ presupuestoSinIva: 4_101_333.88 }), 'escala');
    assert.equal(grande.subpuntuacion, 0);
    assert.match(grande.explicacion, /probablemente fuera de escala/);
    const medio = factor(puntuar_({ presupuestoSinIva: 200_000 }), 'escala').subpuntuacion;
    assert.ok(medio > 0.3 && medio < 1, `200 k€: ${medio}`);
    const conLotes = factor(puntuar_({ presupuestoSinIva: 1_000_000, lotes: [{ id: '1', nombre: 'A', presupuestoSinIva: 60_000, cpv: [], nuts: [] }, { id: '2', nombre: 'B', presupuestoSinIva: 940_000, cpv: [], nuts: [] }] }), 'escala');
    assert.equal(conLotes.subpuntuacion, 1);
    assert.match(conLotes.explicacion, /lote más pequeño/);
    assert.equal(factor(puntuar_({ presupuestoSinIva: 0 }), 'escala').conocido, false, 'presupuesto 0 (acuerdo marco): desconocido');
    // El umbral sale del perfil.
    assert.equal(factor(puntuar_({ presupuestoSinIva: 150_000 }, 20, { presupuestoMaximo: 100_000, ingresosAnuales: 105_000 }), 'escala').subpuntuacion, 0);
  });

  test('plazo de ofertas: pocos días valen poco; y una licitación cerrada queda excluida', () => {
    assert.equal(factor(puntuar_({}, 1), 'plazo').subpuntuacion, 0.1);
    assert.equal(factor(puntuar_({}, 8), 'plazo').subpuntuacion, 0.8);
    assert.equal(factor(puntuar_({}, 25), 'plazo').subpuntuacion, 1);
    assert.equal(factor(puntuar_({}, null), 'plazo').conocido, false);
    assert.match(puntuar_({}, -1).excluida!, /cerrado/);
  });

  test('peso del precio: sale de los criterios del anuncio (más memoria técnica = mejor para una ONG)', () => {
    const criterios = (precio: number) => [
      { tipo: 'OBJ', descripcion: 'Oferta económica', peso: precio, lote: null }, { tipo: 'SUBJ', descripcion: 'Memoria técnica', peso: 100 - precio, lote: null },
    ];
    assert.equal(factor(puntuar_({ criterios: criterios(25) }), 'precio').subpuntuacion, 1);
    assert.equal(factor(puntuar_({ criterios: criterios(60) }), 'precio').subpuntuacion, 0.55);
    assert.equal(factor(puntuar_({ criterios: criterios(100) }), 'precio').subpuntuacion, 0.3);
    assert.match(factor(puntuar_({ criterios: criterios(47) }), 'precio').explicacion, /47 puntos de 100 \(según el anuncio\)/);
    assert.equal(factor(puntuar_({}), 'precio').conocido, false);
  });

  test('viabilidad: el volumen de negocio exigido frente a los ingresos anuales; importes solo con € o «euros»', () => {
    const sol = (t: string) => ({ solvenciaEconomica: [t] });
    assert.equal(factor(puntuar_(sol('Volumen anual de negocios de al menos 60.000 euros')), 'viabilidad').subpuntuacion, 1);
    assert.equal(factor(puntuar_(sol('Volumen anual de negocios de al menos 150.000 €')), 'viabilidad').subpuntuacion, 0.6);
    assert.equal(factor(puntuar_(sol('Volumen anual de negocios de al menos 500.000 €')), 'viabilidad').subpuntuacion, 0.2);
    assert.equal(factor(puntuar_(sol('según el art. 87.3 a) LCSP, 1,5 veces el valor anual medio')), 'viabilidad').conocido, false, 'sin cifra en euros no se inventa');
    assert.equal(parsearImporteEuros('art. 87.3 a) del 70 % de 94.948,53 €/15 = 44.309,31 €'), 94_948.53);
    assert.equal(parsearImporteEuros('un millón'), null);
  });
});

describe('cobertura del feed: continua, sin huecos perdidos', () => {
  const cobertura = (db: DatabaseSync) => leerCobertura(db) as Cobertura;
  const sinSegunda = (): typeof fetch => {
    const bueno = fetchPlacsp();
    return (async (u: string, i?: RequestInit) => (u === URL_FEED_PLACSP ? bueno(u, i) : new Response('Service Unavailable', { status: 503 }))) as typeof fetch;
  };

  test('un error en la página 2 deja un hueco con la URL por la que seguir y no avanza más allá de lo leído; la siguiente pasada lo cierra', async () => {
    const db = bdSembrada();
    const r = await pasada(db, [placsp()], sinSegunda());
    assert.match(r.fuentes[0].errores.join(' '), /HTTP 503/);
    const c1 = cobertura(db);
    assert.ok(c1.hasta);
    assert.deepEqual(c1.huecos.map((h) => h.url), [URL_PAGINA_2_PLACSP], 'el hueco empieza en la página que falló');
    assert.ok(!ids(db).includes(RELEVANTE));

    const p: string[] = [];
    const r2 = await pasada(db, [placsp()], fetchPlacsp(p));
    assert.deepEqual(p, [URL_FEED_PLACSP, URL_PAGINA_2_PLACSP], 'arriba para en lo leído y retoma el hueco desde donde se quedó');
    assert.ok(ids(db).includes(RELEVANTE), 'lo que había en el hueco se recupera');
    assert.deepEqual(cobertura(db).huecos, [], 'el hueco se cierra: una sola ventana');
    assert.equal(r2.conErrores, false);
    assert.deepEqual(ids(db), [PODA, OBRA_PARQUE, GRANDE, RELEVANTE].sort());
  });

  test('un tope de páginas deja el hueco y se retoma en pasadas sucesivas aunque cada una lea poco', async () => {
    const db = bdSembrada();
    await pasada(db, [placsp({ maxPaginas: 1 })], fetchPlacsp());
    assert.deepEqual(cobertura(db).huecos.map((h) => h.url), [URL_PAGINA_2_PLACSP]);
    // Otra pasada igual de corta: lee la página de arriba (ya cubierta, consume el tope) y el hueco sigue intacto.
    const p: string[] = [];
    await pasada(db, [placsp({ maxPaginas: 1 })], fetchPlacsp(p));
    assert.deepEqual(p, [URL_FEED_PLACSP]);
    assert.deepEqual(cobertura(db).huecos.map((h) => h.url), [URL_PAGINA_2_PLACSP], 'no se pierde ni se da por leído');
    const q: string[] = [];
    await pasada(db, [placsp()], fetchPlacsp(q));
    assert.deepEqual(q, [URL_FEED_PLACSP, URL_PAGINA_2_PLACSP]);
    assert.deepEqual(cobertura(db).huecos, []);
    assert.ok(ids(db).includes(RELEVANTE));
  });

  test('si el motor no guarda todo lo recogido, la cobertura no avanza', async () => {
    const db = bdSembrada();
    const real = placsp();
    const roto: Fuente = { ...real, recoger: async (ctx) => { const r = await real.recoger(ctx); return { ...r, cribadas: [...r.cribadas, { ...r.cribadas[0], convocatoria: { ...r.cribadas[0].convocatoria, id: 'licitacion:roto', datos: { x: 1n } } }] }; } };
    const r = await pasada(db, [roto], fetchPlacsp());
    assert.match(r.fuentes[0].errores.join(' '), /Registro licitacion:roto/);
    assert.match(r.fuentes[0].errores.join(' '), /no se avanza su estado/);
    assert.equal(leerEstadoFuente(db, 'placsp', 'cobertura'), null);
    // Y la cobertura solo la escribe el motor: la fuente sola (sin motor) no toca la BD.
    const db2 = bdSembrada();
    await real.recoger({ fetch: fetchPlacsp(), ahora: AHORA_PLACSP, perfil: JSON.parse(readFileSync(new URL('../seed/perfil.json', import.meta.url), 'utf8')).perfil, diasAtras: 7, cribar: () => null, db: db2 });
    assert.equal(leerEstadoFuente(db2, 'placsp', 'cobertura'), null);
  });

  test('una versión posterior anulada o adjudicada de una licitación guardada la retira; una versión vieja no la reabre', async () => {
    const db = bdSembrada();
    await pasada(db, [placsp()], fetchPlacsp());
    const pagina1 = readFileSync(`${DIR_PLACSP}/pagina_1.atom`, 'utf8');
    const pagina2 = readFileSync(`${DIR_PLACSP}/pagina_2.atom`, 'utf8');
    const entrada = pagina2.match(/<entry>[\s\S]*?<\/entry>/g)!.find((e) => e.includes('licitacionesPerfilContratante/20797834'))!;
    const anulada = entrada.replace(/<updated>[^<]+<\/updated>/, '<updated>2026-11-13T21:30:00.000+01:00</updated>').replace(/(ContractFolderStatusCode[^>]*>)PUB</, '$1ANUL<');
    assert.notEqual(anulada, entrada);
    const r = await pasada(db, [placsp()], fetchPlacsp([], { 1: pagina1.replace('<entry>', `${anulada}\n<entry>`) }));
    assert.match(r.fuentes[0].avisos.join(' '), /1 actualizaciones de estado/);
    const f = fila(db, RELEVANTE)!;
    assert.equal(f.descarte_regla, 'estado');
    assert.match(String(f.descarte_motivo), /anulada/);
    assert.equal(f.abierto, 0);
    const api = crearApi({ db, reloj: { now: () => AHORA_PLACSP }, fuentes: [placsp()] });
    db.prepare("INSERT OR IGNORE INTO convocatoria_fases (convocatoria_id, fase, descarta, motivo, datos, actualizado_en) VALUES (?, 'criba_llm', 0, 'test', '{}', ?)").run(RELEVANTE, new Date().toISOString());
    assert.ok(!((await (await api.request('/licitaciones')).json()) as { licitaciones: { id: string }[] }).licitaciones.some((l) => l.id === RELEVANTE));
    // Relleno que vuelve a leer la versión PUB antigua: no pisa la anulada (lo guardado es más reciente).
    await pasada(db, [placsp({ ignorarCursor: true })], fetchPlacsp());
    assert.equal(fila(db, RELEVANTE)!.descarte_regla, 'estado');
    // Reaplicar las reglas (cambio de perfil) tampoco la reabre.
    await pasada(db, [placsp()], fetchPlacsp());
    assert.equal(fila(db, RELEVANTE)!.descarte_regla, 'estado');
  });

  test('una licitación re-publicada con otro presupuesto marca sus veredictos como obsoletos (y siguen así) para volver a cribarla', async () => {
    const db = bdSembrada();
    await pasada(db, [placsp()], fetchPlacsp());
    const ahora = new Date();
    guardarFase(db, { convocatoriaId: GRANDE, fase: 'criba_llm', descarta: false, motivo: 'ok', datos: { versionPerfil: versionCriba(leerPerfil(db)!) } }, ahora);
    guardarFase(db, { convocatoriaId: GRANDE, fase: 'analisis', descarta: false, motivo: null, datos: { versionLineas: versionLineas(leerPerfil(db)!), analisis: {} } }, ahora);
    const pagina1 = readFileSync(`${DIR_PLACSP}/pagina_1.atom`, 'utf8');
    const entrada = pagina1.match(/<entry>[\s\S]*?<\/entry>/g)!.find((e) => e.includes('licitacionesPerfilContratante/20906461'))!;
    const mismo = entrada.replace(/<updated>[^<]+<\/updated>/, '<updated>2026-11-13T21:00:00.000+01:00</updated>'); // misma licitación, sin cambios materiales
    await pasada(db, [placsp()], fetchPlacsp([], { 1: pagina1.replace('<entry>', `${mismo}\n<entry>`) }));
    const obsoleta = () => leerFases(db, GRANDE).map((f) => (f.datos as { obsoleta?: boolean }).obsoleta === true);
    assert.deepEqual(obsoleta(), [false, false], 'sin cambios materiales los veredictos valen');
    const cambiada = entrada.replace(/<updated>[^<]+<\/updated>/, '<updated>2026-11-13T22:00:00.000+01:00</updated>').replace(/(<cbc:TaxExclusiveAmount currencyID="EUR">)[\d.]+</, '$1250000<');
    await pasada(db, [placsp()], fetchPlacsp([], { 1: pagina1.replace('<entry>', `${cambiada}\n<entry>`) }));
    assert.deepEqual(obsoleta(), [true, true]);
    await pasada(db, [placsp()], fetchPlacsp()); // otra pasada: reconsiderarVeredictos no quita la marca
    assert.deepEqual(obsoleta(), [true, true]);
  });

  test('entidades XML inválidas no tumban nada: se convierten en U+FFFD', async () => {
    assert.equal(parsearXml('<a>x&#99999999;y&#xD800;z&#abc;</a>').h[0].t, 'x\uFFFDy\uFFFDz&#abc;');
    const pagina = trocearFeed('<feed><link href="https://contrataciondelestado.es/sindicacion/x&#99999999;.atom" rel="next"/><entry><id>1</id></entry></feed>');
    assert.match(pagina.siguiente!, /x\uFFFD\.atom/);
    // Una entrada real con una entidad rota en el título: se lee y la fuente sigue.
    const db = bdSembrada();
    const pagina1 = readFileSync(`${DIR_PLACSP}/pagina_1.atom`, 'utf8').replace(/(<cbc:Name>)(Servicios de limpieza integral)/, '$1$2 &#99999999; ').replace(/rel="next"/, 'rel="next"');
    const r = await pasada(db, [placsp()], fetchPlacsp([], { 1: pagina1 }));
    assert.equal(r.conErrores, false);
    assert.match(String(fila(db, GRANDE)!.titulo), /\uFFFD/);
  });
});

describe('criba de licitaciones: el texto sale del perfil', () => {
  const base = JSON.parse(readFileSync(new URL('../seed/perfil.json', import.meta.url), 'utf8')).perfil;
  const c: Convocatoria = { id: 'licitacion:1', fuente: 'placsp', fuenteId: '1', titulo: 'T', organo: { nivel1: 'LOCAL', nivel2: 'X', nivel3: null }, fechaPublicacion: '2026-11-13', url: 'https://x', tipo: 'licitacion', finalidad: null, regiones: [], abierto: true, datos: {} };

  test('la entidad, el equipo y el umbral vienen del perfil; sin umbral no hay cláusula de escala', async () => {
    const { promptCriba } = await import('../src/llm/prompts.ts');
    const con = promptCriba({ ...base, entidad: { equipo: '3 personas', formaJuridica: 'fundación cultural' }, licitaciones: { presupuestoMaximo: 80_000, ingresosAnuales: 40_000 } }, c, null, []).sistema;
    assert.match(con, /una entidad fundación cultural de 3 personas, con unos 40\.000 € anuales/);
    assert.match(con, /no pasa de 80\.000 €/);
    assert.doesNotMatch(con, /6-7 personas|ecologista|300\.000|105\.000/);
    const sin = promptCriba({ ...base, entidad: undefined, licitaciones: undefined }, c, null, []).sistema;
    assert.match(sin, /las dos cosas/);
    assert.doesNotMatch(sin, /Probablemente fuera de escala:» con el importe|no pasa de/);
  });

  test('un perfil guardado sin esos campos los recibe de la semilla sin pisar lo que ya tenga', async () => {
    const { migrarLicitaciones } = await import('../src/perfil.ts');
    const db = bdSembrada();
    const sinCampos = { ...leerPerfil(db)!, licitaciones: undefined, entidad: undefined };
    db.prepare('UPDATE perfil SET datos = ? WHERE id = 1').run(JSON.stringify(sinCampos));
    assert.equal(migrarLicitaciones(db, base, new Date()), true);
    assert.deepEqual(leerPerfil(db)!.licitaciones, { presupuestoMaximo: 300_000, ingresosAnuales: 105_000 });
    assert.equal(leerPerfil(db)!.entidad!.equipo, '6-7 personas');
    db.prepare('UPDATE perfil SET datos = ? WHERE id = 1').run(JSON.stringify({ ...leerPerfil(db)!, licitaciones: { presupuestoMaximo: 1, ingresosAnuales: 2 } }));
    assert.equal(migrarLicitaciones(db, base, new Date()), false);
    assert.equal(leerPerfil(db)!.licitaciones!.presupuestoMaximo, 1);
  });
});
