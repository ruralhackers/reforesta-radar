// Serie y predicción de apertura: función pura (tablas), motor con las grabaciones reales de la serie «proyectos ambientales» de la CAM
// (626301 2022, 703977 2023, 782630 2024, 825309 2025, 904719 2026) y API (sección "próximas" de /semana y serie de la ficha).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { guardarConvocatoria } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { describirVentana, diaDelAnio, estadoApertura, fechaDeDia, predecirApertura, ventanaEnAnio, type AperturaPasada } from '../src/prediccion.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdns } from '../src/sources/bdns.ts';
import type { Fuente } from '../src/sources/source.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, darPorCribadas, RUTA_PUNTUACION, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
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
    assert.equal(r.texto, 'suele abrir entre principios de abril y finales de agosto');
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
    assert.deepEqual(estadoApertura(r, '2026-06-04', 60), { estado: 'retrasada', desde: '2026-05-15', hasta: '2026-06-03' });
    assert.equal(estadoApertura(r, '2026-06-03', 60).estado, 'pronto'); // último día de la ventana
    assert.equal(estadoApertura(r, '2026-05-20', 60).estado, 'pronto'); // dentro
    assert.equal(estadoApertura(r, '2026-03-16', 60).estado, 'pronto'); // empieza en 60 días justos
    assert.equal(estadoApertura(r, '2026-03-15', 60).estado, 'lejos');
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

  test('el tope de peticiones se respeta', async () => {
    const db = bdSembrada();
    guardarConvocatoria(db, { convocatoria: CONV_2026, descarte: null }, AHORA);
    darPorCribadas(db);
    const r = await ejecutarRadar({ db, fetch: fetchGrabado({ concesiones: true }), reloj: relojFijo(AHORA), fuentes: [fuente], dormir: async () => {}, parecidas: false, ganadores: { maxPeticiones: 10 } });
    assert.ok((r.series?.peticiones ?? 99) <= Math.max(0, 10 - (r.ganadores?.peticiones ?? 0)));
    assert.ok((r.series?.omitidasPorTope ?? 0) > 0);
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
    assert.equal(por.get(2026).reforesta, 'sin_datos');
    assert.equal(por.get(2026).ganadores, null);
    assert.equal(por.get(2026).convocatoriaId, 'bdns:904719');
    assert.equal(por.get(2024).convocatoriaId, null); // sin ficha propia: enlaza a BDNS
    assert.equal(s.anioSiguiente, 2027);
    // base: las cinco aperturas (doy 97, 131, 132, 170, 240)
    assert.deepEqual(s.prediccion.basadaEn.map((e: any) => e.anio), [2022, 2023, 2024, 2025, 2026]);
    assert.equal(s.prediccion.texto, 'suele abrir entre principios de abril y finales de agosto');
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
