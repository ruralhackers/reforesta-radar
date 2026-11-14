// Serie y predicción de apertura: función pura (tablas), motor con las grabaciones reales de la serie «proyectos ambientales» de la CAM
// (626301 2022, 703977 2023, 782630 2024, 825309 2025, 904719 2026) y API (sección "próximas" de /semana y serie de la ficha).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { guardarDetalleEdicion, registrarEdicion } from '../src/db/ganadores.ts';
import { recogerGanadores } from '../src/fases/ganadores.ts';
import { recogerHistorialSeries } from '../src/fases/series.ts';
import { leerFestivos } from '../src/festivos.ts';
import { guardarConvocatoria } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { describirVentana, diaDelAnio, estadoApertura, fechaDeDia, predecirApertura, ventanaEnAnio, type AperturaPasada } from '../src/prediccion.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdns } from '../src/sources/bdns.ts';
import type { Fuente } from '../src/sources/source.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, darPorCribadas, RUTA_FESTIVOS, RUTA_PUNTUACION, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
import { fetchGrabado } from './support/grabaciones.ts';

const p = (anio: number, apertura: string, cierre: string | null = null): AperturaPasada => ({ numero: String(anio), anio, apertura, cierre });

describe('predecirApertura (pura)', () => {
  test('con menos de 2 ediciones no predice nada', () => {
    assert.equal(predecirApertura([]), null);
    assert.equal(predecirApertura([p(2025, '2025-05-12')]), null);
    // dos convocatorias del mismo año cuentan como una edición
    assert.equal(predecirApertura([p(2025, '2025-05-12'), { ...p(2025, '2025-09-01'), numero: '2025b' }]), null);
  });

  test('2 ediciones: ventana entre las dos fechas y base visible', () => {
    const r = predecirApertura([p(2024, '2024-05-15'), p(2025, '2025-06-03')])!;
    assert.deepEqual([r.desdeDia, r.hastaDia], [diaDelAnio('2025-05-15'), diaDelAnio('2025-06-03')]);
    assert.equal(r.texto, 'suele abrir entre mediados de mayo y principios de junio');
    assert.deepEqual(r.basadaEn.map((e) => e.anio), [2024, 2025]);
    assert.equal(r.duracionDias, null);
  });

  test('3 ediciones con dispersión y duración típica (mediana de las que tienen cierre)', () => {
    const r = predecirApertura([p(2023, '2023-06-19', '2023-07-03'), p(2024, '2024-08-28', '2024-09-20'), p(2025, '2025-04-07')])!;
    assert.equal(r.texto, 'ha abierto en fechas muy distintas (de abril a agosto)'); // más de 90 días: no hay patrón que anunciar
    assert.equal(r.dispersa, true);
    assert.equal(r.duracionDias, 19); // mediana de 14 y 23 = 18,5 → 19
    assert.deepEqual(r.basadaEn.map((e) => e.numero), ['2023', '2024', '2025']);
  });

  test('misma quincena: una sola frase', () => {
    assert.equal(predecirApertura([p(2024, '2024-05-12'), p(2025, '2025-05-14')])!.texto, 'suele abrir a mediados de mayo');
    assert.equal(describirVentana(diaDelAnio('2025-01-03'), diaDelAnio('2025-01-03')), 'suele abrir a principios de enero');
  });

  test('cruza el fin de año: de diciembre a enero, no todo el año', () => {
    const r = predecirApertura([p(2023, '2023-12-20'), p(2024, '2025-01-08'), p(2025, '2025-12-28')])!;
    assert.equal(r.texto, 'suele abrir entre mediados de diciembre y principios de enero');
    assert.ok(r.desdeDia > r.hastaDia);
    assert.deepEqual(ventanaEnAnio(r, 2026), { desde: '2026-12-20', hasta: '2027-01-08' });
  });

  test('el 29 de febrero cuenta como el 28 y las fechas de la ventana son válidas', () => {
    assert.equal(diaDelAnio('2024-02-29'), diaDelAnio('2025-02-28'));
    assert.equal(fechaDeDia(2027, diaDelAnio('2024-12-31')), '2027-12-31');
  });

  test('retrasada: hoy pasada la ventana sin edición nueva; pronto: dentro de los días; lejos: más tarde', () => {
    const r = predecirApertura([p(2024, '2024-05-15'), p(2025, '2025-06-03')])!; // ventana 15-may..3-jun
    const U = '2025-06-03';
    assert.deepEqual(estadoApertura(r, '2026-06-04', 60, U), { estado: 'retrasada', desde: '2026-05-15', hasta: '2026-06-03' });
    assert.equal(estadoApertura(r, '2026-06-03', 60, U).estado, 'pronto'); // último día de la ventana
    assert.equal(estadoApertura(r, '2026-05-20', 60, U).estado, 'pronto'); // dentro
    assert.equal(estadoApertura(r, '2026-03-16', 60, U).estado, 'pronto'); // empieza en 60 días justos
    assert.equal(estadoApertura(r, '2026-03-15', 60, U).estado, 'lejos');
  });
});

describe('estadoApertura a través del cambio de año, edición existente y series abandonadas (pura)', () => {
  const dicEne = predecirApertura([p(2024, '2024-12-20'), p(2025, '2026-01-08')])!; // ventana 20-dic..8-ene
  const ene = predecirApertura([p(2024, '2025-01-10'), p(2025, '2026-01-25')])!; // ventana 10-ene..25-ene

  test('ventana de diciembre a enero: el 5 de enero está dentro (pronto), no lejos', () => {
    const r = estadoApertura(dicEne, '2027-01-05', 60, '2025-12-28');
    assert.deepEqual(r, { estado: 'pronto', desde: '2026-12-20', hasta: '2027-01-08' });
    assert.equal(estadoApertura(dicEne, '2026-12-25', 60, '2025-12-28').estado, 'pronto');
  });

  test('ventana de enero vista en noviembre o diciembre: pronto (la de enero que viene), no retrasada', () => {
    const r = estadoApertura(ene, '2026-11-20', 60, '2026-01-25');
    assert.deepEqual(r, { estado: 'pronto', desde: '2027-01-10', hasta: '2027-01-25' });
    assert.equal(estadoApertura(ene, '2026-12-31', 60, '2026-01-25').estado, 'pronto');
    assert.equal(estadoApertura(ene, '2026-10-01', 60, '2026-01-25').estado, 'lejos');
  });

  test('la edición del ciclo se decide por la fecha de apertura, no por el año del título', () => {
    const r = predecirApertura([p(2024, '2024-11-20'), p(2025, '2025-11-25')])!; // ventana 20-nov..25-nov
    // se llamó «2026» pero abrió en noviembre de 2025: en noviembre de 2026 aún se espera la siguiente
    assert.equal(estadoApertura(r, '2026-11-14', 60, '2025-11-25').estado, 'pronto');
    // ya abrió en este ciclo: la ventana que queda es la del año que viene
    assert.equal(estadoApertura(r, '2026-11-27', 60, '2026-11-24').estado, 'lejos');
  });

  test('serie abandonada: última apertura de hace más de ~18 meses → sin_recientes, no retrasada', () => {
    const r = predecirApertura([p(2021, '2021-05-15'), p(2022, '2022-06-03')])!;
    assert.equal(estadoApertura(r, '2026-06-04', 60, '2022-06-03').estado, 'sin_recientes');
    assert.equal(estadoApertura(r, '2023-06-04', 60, '2022-06-03').estado, 'retrasada'); // un año: aún viva
  });
});

const ORGANO = { nivel1: 'AUTONOMICA', nivel2: 'COMUNIDAD DE MADRID', nivel3: 'CONSEJERÍA DE MEDIO AMBIENTE, AGRICULTURA E INTERIOR' };
const CONV_2026: Convocatoria = {
  id: 'bdns:904719', fuente: 'bdns', fuenteId: '904719', titulo: 'SUBVENCIÓN ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES 2026', organo: ORGANO,
  fechaPublicacion: '2026-05-11', url: 'https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/904719', tipo: null, finalidad: null, regiones: ['ES30'], abierto: false, datos: {},
};
const AHORA = new Date('2026-11-13T09:00:00Z');
const perfil = leerSemilla(RUTA_SEMILLA).perfil;
const fuente: Fuente = { ...bdns, recoger: async () => ({ cribadas: [], errores: [] }), documentos: (c) => [{ titulo: 'Ficha', url: null, texto: c.titulo }] };

/** Motor con la 904719 ya cribada: trae la serie, sus ganadores y el detalle de las ediciones pasadas (todo grabado). */
async function bdConSerie(): Promise<{ db: DatabaseSync; resumen: Awaited<ReturnType<typeof ejecutarRadar>> }> {
  const db = bdSembrada();
  guardarConvocatoria(db, { convocatoria: CONV_2026, descarte: null }, AHORA);
  darPorCribadas(db);
  const resumen = await ejecutarRadar({ db, fetch: fetchGrabado({ concesiones: true }), reloj: relojFijo(AHORA), fuentes: [fuente], dormir: async () => {}, parecidas: false });
  return { db, resumen };
}
const api = (db: DatabaseSync, ahora: Date) => crearApi({ db, reloj: relojFijo(ahora), fuentes: [fuente], puntuacion: leerConfigPuntuacion(RUTA_PUNTUACION) });

describe('motor + API con la serie de la CAM', () => {
  test('el motor trae el detalle de las ediciones pasadas (una petición por edición) y no repite', async () => {
    const { db, resumen } = await bdConSerie();
    assert.equal(resumen.conErrores, false, JSON.stringify([resumen.series?.errores, resumen.ganadores?.errores]));
    assert.equal(resumen.series?.series, 1);
    assert.equal(resumen.series?.detalles, 4); // 2022-2025; la 2026 ya está guardada como convocatoria
    assert.equal(resumen.series?.peticiones, 4);
    const otra = await ejecutarRadar({ db, fetch: fetchGrabado({ concesiones: true }), reloj: relojFijo(AHORA), fuentes: [fuente], dormir: async () => {}, parecidas: false });
    assert.equal(otra.series?.peticiones, 0);
  });

  test('el tope de peticiones se respeta y el historial de series tiene una parte reservada', async () => {
    const db = bdSembrada();
    guardarConvocatoria(db, { convocatoria: CONV_2026, descarte: null }, AHORA);
    darPorCribadas(db);
    const r = await ejecutarRadar({ db, fetch: fetchGrabado({ concesiones: true }), reloj: relojFijo(AHORA), fuentes: [fuente], dormir: async () => {}, parecidas: false, ganadores: { maxPeticiones: 14 } });
    assert.ok((r.ganadores?.peticiones ?? 99) + (r.series?.peticiones ?? 99) <= 14);
    assert.ok((r.series?.peticiones ?? 0) >= 2, 'la reserva (14/5 = 2) llega a la fase de series aunque los ganadores gasten lo suyo');
  });

  test('el tope de la propia fase: lo que no cabe queda omitido', async () => {
    const db = bdSembrada();
    guardarConvocatoria(db, { convocatoria: CONV_2026, descarte: null }, AHORA);
    darPorCribadas(db);
    await recogerGanadores({ db, fetch: fetchGrabado({ concesiones: true }), reloj: relojFijo(AHORA), dormir: async () => {} }, perfil);
    const r = await recogerHistorialSeries({ db, fetch: fetchGrabado({ concesiones: true }), reloj: relojFijo(AHORA), dormir: async () => {} }, perfil, leerFestivos(RUTA_FESTIVOS), { maxPeticiones: 2, pausaMs: 0 });
    assert.deepEqual([r.peticiones, r.detalles, r.omitidasPorTope], [2, 2, 2]);
  });

  test('un detalle que falla siempre: se reintenta 3 veces, deja de contar como error y pasa a espera', async () => {
    const db = bdSembrada();
    guardarConvocatoria(db, { convocatoria: CONV_2026, descarte: null }, AHORA);
    darPorCribadas(db);
    const buenos = fetchGrabado({ concesiones: true });
    const pedidasA703977: string[] = [];
    const roto = (async (u: string | URL | Request, i?: RequestInit) => {
      if (String(u).includes('numConv=703977')) { pedidasA703977.push(String(u)); return new Response('no existe', { status: 404 }); }
      return buenos(u, i);
    }) as typeof fetch;
    const correr = () => ejecutarRadar({ db, fetch: roto, reloj: relojFijo(AHORA), fuentes: [fuente], dormir: async () => {}, parecidas: false });
    const r1 = await correr();
    assert.equal(r1.series?.detalles, 3);
    assert.equal(r1.series?.errores.length, 1);
    assert.equal(r1.conErrores, true);
    const r2 = await correr();
    assert.equal(r2.series?.errores.length, 1);
    const r3 = await correr();
    assert.deepEqual([r3.series?.errores.length, r3.series?.avisos.length, r3.conErrores], [0, 1, false]); // tercer fallo: aviso, no error de la ejecución
    assert.equal(pedidasA703977.length, 3);
    const r4 = await correr();
    assert.deepEqual([r4.series?.peticiones, r4.series?.enEspera, r4.conErrores], [0, 1, false]);
    assert.equal(pedidasA703977.length, 3);
    // pasados los días de espera vuelve a intentarse
    const r5 = await ejecutarRadar({ db, fetch: roto, reloj: relojFijo(new Date(AHORA.getTime() + 15 * 86_400_000)), fuentes: [fuente], dormir: async () => {}, parecidas: false });
    assert.equal(r5.series?.peticiones, 1);
  });

  test('línea de tiempo de la ficha 2026 y predicción para 2027 con las aperturas pasadas', async () => {
    const { db } = await bdConSerie();
    const ficha = await (await api(db, AHORA).request('/convocatorias/bdns:904719')).json() as any;
    const s = ficha.serie;
    assert.equal(s.esSerie, true);
    assert.deepEqual(s.ediciones.map((e: any) => [e.anio, e.numeroConvocatoria, e.apertura]), [
      [2022, '626301', '2022-05-12'], [2023, '703977', '2023-06-19'], [2024, '782630', '2024-08-28'], [2025, '825309', '2025-04-07'], [2026, '904719', '2026-05-11'],
    ]);
    const por = new Map<number, any>(s.ediciones.map((e: any) => [e.anio, e]));
    assert.equal(por.get(2025).presupuesto, 500000);
    assert.equal(por.get(2025).ganadores, 19);
    assert.equal(por.get(2025).reforesta, 'gano');
    assert.equal(por.get(2023).reforesta, 'no_figura');
    assert.equal(por.get(2026).reforesta, 'sin_concesiones'); // consultada y sin concesiones publicadas
    assert.equal(por.get(2026).ganadores, null);
    assert.equal(por.get(2026).convocatoriaId, 'bdns:904719');
    assert.equal(por.get(2024).convocatoriaId, null); // sin ficha propia: enlaza a BDNS
    assert.equal(s.anioSiguiente, 2027);
    // base: las cinco aperturas (doy 97, 131, 132, 170, 240)
    assert.deepEqual(s.prediccion.basadaEn.map((e: any) => e.anio), [2022, 2023, 2024, 2025, 2026]);
    assert.equal(s.prediccion.texto, 'ha abierto en fechas muy distintas (de abril a agosto)');
    assert.equal(s.prediccion.dispersa, true);
    assert.deepEqual([s.prediccion.desdeDia, s.prediccion.hastaDia], [diaDelAnio('2025-04-07'), diaDelAnio('2024-08-28')]);
    assert.equal(s.resumen.ultimoPresupuesto, por.get(2026).presupuesto);
    assert.deepEqual(s.resumen.reforestaGano, [2022, 2024, 2025]);
  });

  test('"próximas": con la edición de este año no sale; sin ella, sale (pronto) y pasada la ventana, retrasada', async () => {
    const { db } = await bdConSerie();
    const semana = async (hoy: string) => (await (await api(db, new Date(`${hoy}T09:00:00Z`)).request('/semana')).json() as any).proximas;
    assert.deepEqual((await semana('2026-11-14')).series, []); // la edición 2026 ya existe
    const antes = await semana('2027-03-20');
    assert.equal(antes.dias, 60);
    assert.equal(antes.series.length, 1);
    const s = antes.series[0];
    assert.equal(s.estado, 'pronto');
    assert.deepEqual(s.ventana, { desde: '2027-04-07', hasta: '2027-08-28' });
    assert.equal(s.ultimaEdicion.anio, 2026);
    assert.equal(s.ultimaEdicion.convocatoriaId, 'bdns:904719');
    const conteos = s.ultimaEdicion && (await (await api(db, AHORA).request('/convocatorias/bdns:904719')).json() as any).serie.ediciones.flatMap((e: any) => (e.ganadores ? [e.ganadores] : [])).sort((a: number, b: number) => a - b);
    assert.equal(s.resumen.ganadoresTipicos, Math.round((conteos[(conteos.length - 1) >> 1] + conteos[conteos.length >> 1]) / 2));
    assert.deepEqual(s.resumen.reforestaGano, [2022, 2024, 2025]);
    assert.equal(s.titulo.includes('2026'), false);
    assert.deepEqual((await semana('2027-01-05')).series, []); // la ventana empieza a más de 60 días
    assert.equal((await semana('2027-10-01')).series[0].estado, 'retrasada');
  });

  test('"próximas": una serie que descartó el equipo, o con una sola edición, no sale', async () => {
    const { db } = await bdConSerie();
    const app = api(db, new Date('2027-03-20T09:00:00Z'));
    db.prepare("INSERT INTO decisiones (convocatoria_id, decision, motivo, detalle, decidida_en) VALUES ('bdns:904719', 'descartada', 'Ya presentada', NULL, '2026-11-14T00:00:00Z')").run();
    assert.deepEqual(((await (await app.request('/semana')).json()) as any).proximas.series, []);
    const solo = bdSembrada();
    guardarConvocatoria(solo, { convocatoria: CONV_2026, descarte: null }, AHORA);
    darPorCribadas(solo);
    const unaSola = await (await api(solo, new Date('2027-03-20T09:00:00Z')).request('/convocatorias/bdns:904719')).json() as any;
    assert.equal(unaSola.serie.prediccion, null); // sin historial: nada que predecir
  });
});

// Series sintéticas (una edición relevante guardada como convocatoria; el resto, solo historial con su fecha de publicación).
const TIT = (anio: number) => `AYUDAS PARA PROYECTOS DE RESTAURACION FORESTAL EN ZONAS RURALES ${anio}`;
function serieSintetica(db: DatabaseSync, ediciones: { numero: string; titulo: number; apertura: string }[], relevante: string): void {
  for (const e of ediciones) {
    registrarEdicion(db, e.numero, TIT(e.titulo), ORGANO, null);
    if (e.numero === relevante) {
      guardarConvocatoria(db, { convocatoria: { ...CONV_2026, id: `bdns:${e.numero}`, fuenteId: e.numero, titulo: TIT(e.titulo), fechaPublicacion: e.apertura }, descarte: null }, AHORA);
    } else guardarDetalleEdicion(db, e.numero, { fechaPublicacion: e.apertura, inicioSolicitud: null, finSolicitud: null, presupuesto: null }, AHORA);
  }
  darPorCribadas(db);
}
const proximas = async (db: DatabaseSync, hoy: string) => ((await (await api(db, new Date(`${hoy}T09:00:00Z`)).request('/semana')).json()) as any).proximas.series as any[];

describe('"esta edición ya existe" y series abandonadas, con datos guardados', () => {
  test('título 2026 abierta en noviembre de 2025: en noviembre de 2026 aún se espera la siguiente', async () => {
    const db = bdSembrada();
    serieSintetica(db, [{ numero: '111', titulo: 2025, apertura: '2024-11-20' }, { numero: '222', titulo: 2026, apertura: '2025-11-25' }], '222');
    const s = await proximas(db, '2026-11-14');
    assert.equal(s.length, 1);
    assert.equal(s[0].estado, 'pronto');
    assert.deepEqual(s[0].ventana, { desde: '2026-11-20', hasta: '2026-11-25' });
    const ficha = await (await api(db, AHORA).request('/convocatorias/bdns:222')).json() as any;
    assert.deepEqual(ficha.serie.ediciones.map((e: any) => e.aperturaTipo), ['registro', 'registro']); // BDNS no da el inicio: es la fecha de registro
  });

  test('título 2025 abierta en enero de 2026: cuenta como la edición de este ciclo', async () => {
    const db = bdSembrada();
    serieSintetica(db, [{ numero: '333', titulo: 2024, apertura: '2024-04-10' }, { numero: '444', titulo: 2025, apertura: '2026-01-20' }], '444');
    assert.deepEqual(await proximas(db, '2026-02-01'), []);
  });

  test('dos convocatorias del mismo año: la edición actual no desaparece y /semana y la ficha coinciden', async () => {
    const db = bdSembrada();
    serieSintetica(db, [
      { numero: '553', titulo: 2024, apertura: '2024-05-02' }, { numero: '554', titulo: 2025, apertura: '2025-05-05' },
      { numero: '555', titulo: 2026, apertura: '2026-05-10' }, { numero: '556', titulo: 2026, apertura: '2026-05-12' },
    ], '556');
    assert.deepEqual(await proximas(db, '2026-06-01'), []); // la de 2026 existe (aunque el año sea ambiguo): no es "retrasada"
    const hoy = new Date('2027-04-20T09:00:00Z');
    const ficha = await (await api(db, hoy).request('/convocatorias/bdns:556')).json() as any;
    const s = await proximas(db, '2027-04-20');
    assert.equal(s.length, 1);
    assert.deepEqual(s[0].prediccion, ficha.serie.prediccion);
    assert.deepEqual(ficha.serie.prediccion.basadaEn.map((b: any) => b.anio), [2024, 2025]);
  });

  test('serie abandonada: última edición de hace años no sale como retrasada', async () => {
    const db = bdSembrada();
    serieSintetica(db, [{ numero: '601', titulo: 2021, apertura: '2021-05-15' }, { numero: '602', titulo: 2022, apertura: '2022-06-03' }], '602');
    assert.deepEqual(await proximas(db, '2026-06-04'), []);
    assert.equal((await proximas(db, '2023-06-04'))[0].estado, 'retrasada');
  });
});
