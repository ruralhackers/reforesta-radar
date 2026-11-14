// Backtest "Cómo sabemos": detalles de BDNS grabados + veredictos reales de Haiku repetidos por un LLM falso + reloj fijo.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { construirConjuntoB, evaluarCandidataB, type DetalleBdns, ORDEN_DEL_RETO } from '../src/backtest/conjuntos.ts';
import { guardarConjunto, leerConjunto, leerResultados } from '../src/backtest/db.ts';
import { abrirBdTrabajo, comprobarRutasBd, ejecutarBacktest, type OpcionesBacktest } from '../src/backtest/ejecutar.ts';
import { construirInforme, metricaB } from '../src/backtest/informe.ts';
import { abrirBd } from '../src/db/schema.ts';
import { leerPerfil } from '../src/db/repo.ts';
import { crearApi } from '../src/api/app.ts';
import { leerFestivos } from '../src/festivos.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { bdSembrada, RUTA_FESTIVOS, RUTA_PUNTUACION } from './support/bd.ts';

const AHORA = new Date('2026-11-14T10:00:00Z');
const fix = (...r: string[]) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', ...r), 'utf8'));
const detalle825309 = fix('bdns', 'convocatorias__numConv=825309.json') as DetalleBdns;
const detallesB = fix('backtest', 'detalles-b.json') as Record<string, DetalleBdns>;
const concesionesB = fix('backtest', 'concesiones-b.json') as Record<string, unknown[]>;
const detalles: Record<string, DetalleBdns> = { '825309': detalle825309, ...detallesB };

// Veredicto real de Haiku para la 825309 (grabado de la ejecución en vivo).
const VEREDICTO = { decision: 'puede_encajar', motivo: 'La convocatoria financia actividades y proyectos ambientales de entidades sin ánimo de lucro en la Comunidad de Madrid.', exigeSedeEnOtraComunidad: 'no_aplica' };
function llmFalso(descarta: string[] = []) {
  const llm = {
    llamadas: 0,
    async generar(p: { mensaje: string; modelo: string }) {
      llm.llamadas++;
      const n = /Código BDNS: (\d+)/.exec(p.mensaje)?.[1] ?? '';
      const datos = descarta.includes(n) ? { ...VEREDICTO, decision: 'descartar', motivo: 'no encaja' } : VEREDICTO;
      return { datos, modelo: p.modelo, uso: { entrada: 100, salida: 20, cacheLectura: 0, cacheEscritura: 0 } };
    },
  };
  return llm;
}
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
function fetchGrabado(urls: string[] = []): typeof fetch {
  return (async (entrada: string) => {
    urls.push(entrada);
    const u = new URL(entrada);
    if (u.pathname.endsWith('/convocatorias') && u.searchParams.has('numConv')) {
      const d = detalles[u.searchParams.get('numConv')!];
      return d ? json(d) : new Response('no existe', { status: 404 });
    }
    throw new Error(`Petición no prevista: ${entrada}`);
  }) as unknown as typeof fetch;
}

function fila(conjunto: 'a' | 'b', numero: string, d: DetalleBdns) {
  return {
    conjunto, numero, titulo: d.descripcion, organo: 'X', finalidad: d.descripcionFinalidad, fechaPublicacion: d.fechaRecepcion, admitida: true,
    reglas: ['regla'], ganadoras: [{ nif: 'G1', nombre: 'GREFA' }], etiqueta: conjunto === 'a' ? 'CAM 2025' : null, orden: numero,
  };
}

function opciones(db: ReturnType<typeof bdSembrada>, llm: ReturnType<typeof llmFalso> | null, urls: string[], extra: Partial<OpcionesBacktest> = {}): OpcionesBacktest {
  return {
    db, dbTrabajo: abrirBdTrabajo(':memory:', leerPerfil(db)!, AHORA), fetch: fetchGrabado(urls), llm, ahora: AHORA, puntuacion: leerConfigPuntuacion(RUTA_PUNTUACION),
    festivos: leerFestivos(RUTA_FESTIVOS), conAnalisis: false, maxLlamadas: 5000, maxB: 150, maxAnalisis: 0, maxDetallesB: 0, solo: null, dryRun: false,
    reconstruirB: false, ampliarB: false, rehacer: false, dormir: async () => {}, pausaMs: 0, log: () => {}, ...extra,
  };
}

test('la 825309 pasa reglas y criba y queda detectada (la puntuación es solo un dato), sin concesiones ni parecidas y sin tocar lo vivo', async () => {
  const db = bdSembrada();
  guardarConjunto(db, [fila('a', '825309', detalle825309)], AHORA);
  const llm = llmFalso();
  const urls: string[] = [];
  const o = opciones(db, llm, urls, { solo: 'a' });
  const r = await ejecutarBacktest(o);
  const res = leerResultados(db, 'sin_analisis').find((x) => x.numero === '825309')!;
  assert.equal(res.pasoReglas, true);
  assert.equal(res.pasoCriba, true, `motivo: ${res.motivoCriba}`);
  assert.equal(res.etapa, 'puntuada');
  assert.ok(res.puntuacion !== null, 'la puntuación se guarda como dato');
  assert.equal(res.factores.length, 5, 'desglose guardado');
  const cierre = (res.factores as { id: string; explicacion: string }[]).find((f) => f.id === 'cierre')!;
  assert.doesNotMatch(cierre.explicacion, /cerrada|desconocid/i, 'el reloj está en su fecha de publicación, no en hoy');
  assert.equal(r.llamadas, llm.llamadas);
  assert.equal(urls.filter((u) => /concesiones|documentos|descripcion=/.test(u)).length, 0);
  for (const t of ['convocatorias', 'convocatoria_fases', 'decisiones', 'puntuaciones']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
  }
  assert.equal((o.dbTrabajo.prepare('SELECT COUNT(*) AS n FROM origenes_convocatoria').get() as { n: number }).n, 0);
  // Reanudar: ya está hecha, no se vuelve a llamar al LLM.
  const antes = llm.llamadas;
  await ejecutarBacktest({ ...o });
  assert.equal(llm.llamadas, antes);
  assert.equal(construirInforme(db, AHORA).modos.sin_analisis!.a.filas[0].resultado!.exito, true);
});

test('el tope de llamadas deja el resultado provisional (nunca éxito) y se continúa en otra ejecución', async () => {
  const db = bdSembrada();
  guardarConjunto(db, [fila('a', '825309', detalle825309)], AHORA);
  const llm = llmFalso();
  const o = opciones(db, llm, [], { solo: 'a', maxLlamadas: 0 });
  const r = await ejecutarBacktest(o);
  assert.equal(r.topeAlcanzado, true);
  const res = leerResultados(db)[0];
  assert.equal(res.completa, false);
  assert.equal(construirInforme(db, AHORA).modos.sin_analisis!.a.filas[0].resultado!.exito, false);
  await ejecutarBacktest({ ...o, maxLlamadas: 10 });
  assert.equal(leerResultados(db)[0].completa, true);
  assert.equal(llm.llamadas, 1);
});

test('--dry-run cuenta las llamadas a Haiku y estima el coste sin llamar al LLM', async () => {
  const db = bdSembrada();
  guardarConjunto(db, [fila('a', '825309', detalle825309)], AHORA);
  const r = await ejecutarBacktest(opciones(db, null, [], { solo: 'a', dryRun: true }));
  assert.equal(r.estimacion!.pendientesCriba, 1);
  assert.equal(r.estimacion!.enCache, 0);
  assert.equal(r.estimacion!.llamadasHaiku, 1);
  assert.ok(r.estimacion!.costeUsd > 0);
  assert.equal(leerResultados(db).length, 0, 'un dry-run no guarda resultados');
  await assert.rejects(ejecutarBacktest(opciones(db, null, [], { solo: 'a' })), /ANTHROPIC_API_KEY/);
});

test('(b) se puntúa sin la fuente "parecidas", respeta el tope por ejecución y es reanudable', async () => {
  const db = bdSembrada();
  const admitidas = ['712977', '837090'];
  guardarConjunto(db, admitidas.map((n) => fila('b', n, detallesB[n])), AHORA);
  const llm = llmFalso(['837090']);
  const o = opciones(db, llm, [], { solo: 'b', maxB: 1 });
  const r1 = await ejecutarBacktest(o);
  assert.equal(leerResultados(db).length, 1, 'tope por ejecución');
  assert.equal(r1.pendientesB, 1);
  const r2 = await ejecutarBacktest(o);
  assert.equal(r2.pendientesB, 0);
  const rs = leerResultados(db);
  assert.equal(rs.length, 2);
  const puntuada = rs.find((x) => x.numero === '712977')!;
  const prob = (puntuada.factores as { id: string; conocido: boolean }[]).find((f) => f.id === 'probabilidad')!;
  assert.equal(prob.conocido, false, 'la probabilidad no usa ganadoras previas ni parecidas');
  assert.equal((o.dbTrabajo.prepare('SELECT COUNT(*) AS n FROM origenes_convocatoria').get() as { n: number }).n, 0);
  assert.equal(rs.find((x) => x.numero === '837090')!.etapa, 'criba_llm');
  const m = metricaB(leerConjunto(db, 'b'), rs);
  assert.equal(m.conjunto, 2);
  assert.equal(m.procesadas, 2);
  assert.equal(m.pasanCriba, 1);
  assert.equal(m.porcentajePasaCriba, 50);
});

test('(b) reglas objetivas: nominativas, ámbito, finalidad y ESFL, cada una con su motivo', () => {
  const perfil = leerPerfil(bdSembrada())!;
  const ev = (n: string) => evaluarCandidataB(detallesB[n], perfil, ['GREFA']);
  const admitida = ev('712977'); // MITECO línea A 2023: concurrencia, ESTADO, "interés general… medio ambiente"
  assert.equal(admitida.admitida, true, admitida.motivo ?? '');
  assert.equal(admitida.reglas.length, 4);
  assert.match(admitida.reglas.join(' | '), /Concurrencia competitiva/);
  assert.match(admitida.reglas.join(' | '), /Ámbito: nivel ESTADO/);
  assert.match(admitida.reglas.join(' | '), /Finalidad ambiental/);
  assert.equal(ev('837090').admitida, true); // voluntariado ambiental MITECO
  assert.match(ev('644841').motivo!, /Concesión directa/); // nominativa PGE
  assert.match(ev('827459').motivo!, /Fuera del ámbito/); // Castilla y León, aunque sea ambiental
  assert.match(ev('897908').motivo!, /Sin finalidad ambiental/); // proyectos juveniles de la CAM
  assert.match(ev('585683').motivo!, /antes de 2022/);
  // Un título limitado a empresas no admite ESFL; si nombra a las ESFL, sí.
  const soloEmpresas = { ...detallesB['712977'], descripcion: 'AYUDAS A EMPRESAS Y PYMES PARA ACTUACIONES AMBIENTALES' };
  assert.match(evaluarCandidataB(soloEmpresas, perfil, ['GREFA']).motivo!, /limita a empresas/);
  const conEsfl = { ...detallesB['712977'], descripcion: 'AYUDAS A EMPRESAS Y ENTIDADES SIN ÁNIMO DE LUCRO PARA ACTUACIONES AMBIENTALES' };
  assert.equal(evaluarCandidataB(conEsfl, perfil, ['GREFA']).admitida, true);
  // Nominativa por el título aunque el tipo diga otra cosa.
  assert.match(evaluarCandidataB({ ...detallesB['712977'], descripcion: 'Subvención nominativa ambiental' }, perfil, ['GREFA']).motivo!, /Nominativa/);
});

test('(b) el conjunto sale de las concesiones de las parecidas, sin lo que ganó Reforesta ni lo del conjunto (a)', async () => {
  const perfil = leerPerfil(bdSembrada())!;
  const urls: string[] = [];
  const f = (async (entrada: string) => {
    urls.push(entrada);
    const u = new URL(entrada);
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (u.pathname.endsWith('/concesiones/busqueda')) return json({ content: concesionesB[u.searchParams.get('nifCif')!] ?? [], last: true });
    if (u.pathname.endsWith('/convocatorias')) {
      const d = detallesB[u.searchParams.get('numConv')!];
      return d ? json(d) : new Response('no', { status: 404 });
    }
    throw new Error(`no prevista: ${entrada}`);
  }) as unknown as typeof fetch;
  const r = await construirConjuntoB(f, perfil, [{ nif: 'G78456118', nombre: 'GREFA' }, { nif: 'G78616893', nombre: 'Grupo Brinzal' }],
    { excluir: new Set(), dormir: async () => {}, pausaMs: 0, maxDetalles: 500, log: () => {} });
  const numeros = r.filas.map((x) => x.numero);
  // 825309, 782630 y 626301 las ganó Reforesta: ni se examinan.
  for (const n of ['825309', '782630', '626301']) assert.ok(!numeros.includes(n), `${n} la ganó Reforesta`);
  assert.deepEqual(r.ganadasPorReforesta.sort(), ['626301', '782630', '825309']);
  const admitida = r.filas.find((x) => x.numero === '712977')!;
  assert.equal(admitida.admitida, true);
  assert.deepEqual(admitida.ganadoras.map((g) => g.nombre).sort(), ['GREFA', 'Grupo Brinzal']); // la ganaron las dos
  assert.ok(admitida.reglas.some((x) => /GREFA, Grupo Brinzal|Grupo Brinzal, GREFA/.test(x)));
  assert.equal(r.filas.find((x) => x.numero === '897908')!.admitida, false);
  assert.match(r.filas.find((x) => x.numero === '897908')!.reglas[0], /Sin finalidad ambiental/);
  // Lo del conjunto (a) tampoco entra en (b).
  const r2 = await construirConjuntoB(f, perfil, [{ nif: 'G78456118', nombre: 'GREFA' }], { excluir: new Set(['712977']), dormir: async () => {}, pausaMs: 0, maxDetalles: 500, log: () => {} });
  assert.ok(!r2.filas.some((x) => x.numero === '712977'));
  // Tope de detalles.
  const r3 = await construirConjuntoB(f, perfil, [{ nif: 'G78456118', nombre: 'GREFA' }], { excluir: new Set(), dormir: async () => {}, pausaMs: 0, maxDetalles: 2, log: () => {} });
  assert.equal(r3.filas.length + r3.sinDetalle.length, 2);
  assert.ok(r3.omitidasPorTope > 0);
  assert.ok(urls.length > 0);
  assert.equal(ORDEN_DEL_RETO.numero, '904719');
});

test('(b) la métrica usa solo lo calculado del todo y reparte las puntuaciones', () => {
  const f = (n: string, admitida = true) => ({ ...fila('b', n, detallesB['712977']), numero: n, admitida });
  const res = (n: string, o: Record<string, unknown>) => ({
    conjunto: 'b' as const, numero: n, modo: 'sin_analisis' as const, pasoReglas: true, motivoReglas: null, pasoCriba: true, motivoCriba: null, etapa: 'puntuada' as const,
    puntuacion: 47, factores: [], completa: true, ...o,
  });
  const m = metricaB(
    [f('1'), f('2'), f('3'), f('4'), f('5'), f('6'), f('7', false)],
    [res('1', {}), res('2', { puntuacion: 38 }), res('3', { pasoCriba: false, etapa: 'criba_llm', puntuacion: null }),
      res('4', { completa: false }), res('5', { etapa: 'sin_datos', completa: false, pasoReglas: false, pasoCriba: false })],
  );
  assert.equal(m.conjunto, 6);
  assert.equal(m.procesadas, 3);
  assert.equal(m.provisionales, 1);
  assert.equal(m.sinDatos, 1);
  assert.equal(m.sinProcesar, 1);
  assert.equal(m.pasanCriba, 2);
  assert.equal(m.porcentajePasaCriba, 66.7);
  assert.deepEqual(m.distribucion.map((d) => d.n), [0, 0, 1, 1, 0, 0]);
  assert.equal(m.medianaPuntuacion, 42.5);
});

test('GET /backtest: informe desde la BD, desde el fichero exportado y vacío', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'backtest-api-'));
  try {
    const db = bdSembrada();
    const reloj = { now: () => AHORA };
    const fichero = join(dir, 'backtest.json');
    let res = await crearApi({ db, reloj, rutaBacktest: fichero }).request('/backtest');
    assert.equal(res.status, 200);
    const vacio = await res.json() as { origen: string; modos: object };
    assert.equal(vacio.origen, 'vacio');
    assert.deepEqual(vacio.modos, {});
    writeFileSync(fichero, JSON.stringify({ generadoEn: AHORA.toISOString(), modos: { sin_analisis: { modo: 'sin_analisis', titular: 'del fichero' } }, reglasB: { palabrasAmbientales: [] } }));
    res = await crearApi({ db, reloj, rutaBacktest: fichero }).request('/backtest');
    const delFichero = await res.json() as { origen: string; modos: { sin_analisis: { titular: string } } };
    assert.equal(delFichero.origen, 'fichero');
    assert.equal(delFichero.modos.sin_analisis.titular, 'del fichero');
    guardarConjunto(db, [fila('a', '825309', detalle825309), fila('b', '712977', detallesB['712977'])], AHORA);
    await ejecutarBacktest(opciones(db, llmFalso(), [], { maxDetallesB: 0 }));
    res = await crearApi({ db, reloj, rutaBacktest: fichero }).request('/backtest');
    const informe = await res.json() as { origen: string; modos: { sin_analisis: InformeApi } };
    assert.equal(informe.origen, 'bd');
    const m = informe.modos.sin_analisis;
      assert.equal(m.a.total, 1);
    assert.equal(m.a.exitos, 1);
    assert.equal(m.a.filas[0].urlBdns, 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/825309');
    assert.ok(m.a.filas[0].resultado.puntuacion > 0);
    assert.equal(m.b.metrica.procesadas, 1);
    assert.equal(m.b.filas[0].reglas[0], 'regla', 'el conjunto (b) es revisable: cada fila lleva la regla que la admitió');
    assert.match(m.titular, /De las 1 convocatorias conocidas .*Orden 1689\/2026.*el radar habría detectado 1: pasan las reglas y la criba/);
    assert.match(m.titularB!, /de 1 convocatorias que encajaban por reglas objetivas.*donde Reforesta no figura entre los ganadores/);
    assert.doesNotMatch(JSON.stringify(informe), /decision|password|"nota"/i);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface InformeApi {
  titular: string; titularB: string | null;
  a: { total: number; exitos: number; filas: { urlBdns: string; resultado: { puntuacion: number } }[] };
  b: { metrica: { procesadas: number }; filas: { reglas: string[] }[] };
}

test('el backtest se niega a trabajar sobre la BD del radar', () => {
  assert.throws(() => comprobarRutasBd('data/radar.sqlite', './data/../data/radar.sqlite'), /coincide con DB_PATH/);
  assert.doesNotThrow(() => comprobarRutasBd('data/radar.sqlite', 'data/backtest/trabajo.sqlite'));
});
