// Puntuación pura: tablas de casos. Sin BD, sin red, sin reloj.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Analisis, CampoCitado } from '../src/fases/analisis-esquema.ts';
import {
  type ConfigPuntuacion, type EntradaPuntuacion, leerConfigPuntuacion, parsearCofinanciacion, parsearImporte, puntuar,
} from '../src/puntuacion.ts';
import type { Convocatoria } from '../src/types.ts';
import { RUTA_PUNTUACION } from './support/bd.ts';

const config = leerConfigPuntuacion(RUTA_PUNTUACION);

const conv: Convocatoria = {
  id: 'bdns:1', fuente: 'bdns', fuenteId: '1', titulo: 'T', organo: { nivel1: 'ESTADO', nivel2: null, nivel3: null },
  fechaPublicacion: '2026-11-13', url: 'https://example.org', tipo: null, finalidad: null, regiones: [], abierto: null, datos: {},
};

const campo = (valor: string | null): CampoCitado => ({ valor, cita: valor, documento: valor ? 'D' : null });

function analisis(a: { esfl?: 'si' | 'no' | null; lineas?: number; max?: string | null; total?: string | null; cofi?: string | null; reqs?: number } = {}): Analisis {
  return {
    elegibilidadEsfl: campo(a.esfl === undefined ? 'si' : a.esfl) as Analisis['elegibilidadEsfl'],
    importeMaximoProyecto: campo(a.max ?? null),
    importeTotal: campo(a.total ?? null),
    plazo: campo(null),
    cofinanciacion: campo(a.cofi ?? null),
    requisitos: Array.from({ length: a.reqs ?? 0 }, (_, i) => campo(`req ${i}`)),
    lineas: Array.from({ length: a.lineas ?? 0 }, (_, i) => ({ linea: `Línea ${i}`, motivo: '', cita: null, documento: null })),
    ideaProyecto: null,
    correcciones: [],
  };
}

const entrada = (a: Analisis | null, dias: number | null = 30, importeMinimo: number | null = 3000): EntradaPuntuacion => ({
  convocatoria: conv, analisis: a, importeMinimo,
  plazo: dias === null ? null : { fechaCierre: '2026-12-13', tipo: 'literal', diasHastaCierre: dias },
});

const factor = (e: EntradaPuntuacion, id: string, c: ConfigPuntuacion = config) => puntuar(e, c).factores.find((f) => f.id === id)!;

describe('parseo de cifras', () => {
  test('importes en formato español', () => {
    assert.equal(parsearImporte('17.389.322,52 €'), 17389322.52);
    assert.equal(parsearImporte('hasta 60.000 euros por proyecto'), 60000);
    assert.equal(parsearImporte('1,5 millones de euros'), 1500000);
    assert.equal(parsearImporte('50 mil euros'), 50000);
    assert.equal(parsearImporte('entre 3.000 y 12.000 €'), 12000);
    assert.equal(parsearImporte('sin cifra'), null);
    assert.equal(parsearImporte(null), null);
  });
  test('cofinanciación', () => {
    assert.equal(parsearCofinanciacion('Cofinanciación del 20 %'), 20);
    assert.equal(parsearCofinanciacion('el 12,5 por ciento'), 12.5);
    assert.equal(parsearCofinanciacion('No se exige cofinanciación'), 0);
    assert.equal(parsearCofinanciacion('a determinar'), null);
    assert.equal(parsearCofinanciacion(null), null);
  });
});

describe('factores', () => {
  test('encaje: más líneas puntúan más; ESFL desconocido resta; sin análisis es desconocido', () => {
    const s = (a: Analisis | null) => factor(entrada(a), 'encaje');
    assert.equal(s(analisis({ lineas: 0 })).subpuntuacion, 0);
    assert.equal(s(analisis({ lineas: 1 })).subpuntuacion, 0.7);
    assert.equal(s(analisis({ lineas: 2 })).subpuntuacion, 0.9);
    assert.equal(s(analisis({ lineas: 5 })).subpuntuacion, 1);
    const esflDesconocido = s(analisis({ lineas: 2, esfl: null }));
    assert.equal(esflDesconocido.subpuntuacion, 0.63);
    assert.equal(esflDesconocido.conocido, false);
    assert.match(esflDesconocido.explicacion, /desconocido si admite entidades sin ánimo de lucro/);
    const sinAnalizar = s(null);
    assert.equal(sinAnalizar.subpuntuacion, 0.3);
    assert.match(sinAnalizar.explicacion, /^desconocido/);
  });

  test('importe: bajo el mínimo = 0, sube con el importe; solo total vale menos; desconocido penaliza', () => {
    const s = (a: Parameters<typeof analisis>[0], min: number | null = 3000) => factor(entrada(analisis(a), 30, min), 'importe');
    assert.equal(s({ max: '2.000 €' }).subpuntuacion, 0);
    assert.match(s({ max: '2.000 €' }).explicacion, /por debajo del mínimo/);
    const medio = s({ max: '20.000 €' }).subpuntuacion;
    const alto = s({ max: '100.000 €' }).subpuntuacion;
    assert.ok(medio > 0.3 && medio < alto);
    assert.equal(alto, 1);
    assert.equal(s({ max: '500.000 €' }).subpuntuacion, 1);
    const soloTotal = s({ total: '100.000 €' });
    assert.equal(soloTotal.subpuntuacion, 0.6);
    assert.match(soloTotal.explicacion, /solo consta el importe total/);
    const max = s({ max: '20.000 €', total: '1.000.000 €' });
    assert.match(max.explicacion, /máximo por proyecto 20\.000/);
    const desconocido = s({});
    assert.deepEqual([desconocido.subpuntuacion, desconocido.conocido], [0.3, false]);
    assert.match(desconocido.explicacion, /^desconocido/);
    assert.equal(s({ max: '2.000 €' }, null).subpuntuacion > 0, true);
  });

  test('cierre: poco tiempo penaliza, desconocido penaliza, hoy cuenta', () => {
    const s = (dias: number | null) => factor(entrada(analisis(), dias), 'cierre');
    assert.deepEqual([0, 3, 4, 7, 8, 14, 15, 90, 91, 400].map((d) => s(d).subpuntuacion), [0.15, 0.15, 0.5, 0.5, 0.8, 0.8, 1, 1, 0.7, 0.7]);
    assert.match(s(0).explicacion, /^cierra hoy/);
    assert.match(s(1).explicacion, /^cierra mañana/);
    assert.match(s(20).explicacion, /^faltan 20 días/);
    const d = s(null);
    assert.deepEqual([d.subpuntuacion, d.conocido], [0.4, false]);
    assert.match(d.explicacion, /^desconocido/);
  });

  test('esfuerzo: cofinanciación y requisitos; lo que falta tira hacia el valor desconocido', () => {
    const s = (a: Parameters<typeof analisis>[0]) => factor(entrada(analisis(a)), 'esfuerzo');
    assert.equal(s({ cofi: 'No se exige cofinanciación', reqs: 2 }).subpuntuacion, 1);
    assert.equal(s({ cofi: '25 %', reqs: 2 }).subpuntuacion, 0.75);
    assert.equal(s({ cofi: '60 %', reqs: 2 }).subpuntuacion, 0.5);
    assert.equal(s({ cofi: '0 %', reqs: 12 }).subpuntuacion, 0.6); // (1 + suelo 0,2) / 2
    const sinCofi = s({ reqs: 2 });
    assert.equal(sinCofi.subpuntuacion, 0.75); // (1 + 0,5) / 2
    assert.equal(sinCofi.conocido, false);
    assert.match(sinCofi.explicacion, /cofinanciación desconocida/);
    const nada = s({});
    assert.deepEqual([nada.subpuntuacion, nada.conocido], [0.5, false]);
    assert.match(nada.explicacion, /^desconocido/);
  });

  test('probabilidad: sin proveedor es desconocida; un proveedor enchufado aporta valor y explicación', () => {
    const e = entrada(analisis());
    const sin = puntuar(e, config).factores.find((f) => f.id === 'probabilidad')!;
    assert.deepEqual([sin.subpuntuacion, sin.conocido], [0.5, false]);
    assert.match(sin.explicacion, /^desconocida/);
    const con = puntuar(e, config, () => ({ valor: 0.9, explicacion: 'la ganó GREFA en 2025' })).factores.find((f) => f.id === 'probabilidad')!;
    assert.deepEqual([con.subpuntuacion, con.conocido, con.explicacion], [0.9, true, 'la ganó GREFA en 2025']);
  });
});

describe('total, exclusiones y pesos', () => {
  test('total = suma ponderada de las subpuntuaciones (0-100) y cada factor lleva su explicación', () => {
    const p = puntuar(entrada(analisis({ lineas: 2, max: '100.000 €', cofi: '0 %', reqs: 1 }), 30), config);
    // 35·0,9 + 20·1 + 15·1 + 15·1 + 15·0,5 = 89
    assert.equal(p.total, 89);
    assert.equal(p.excluida, null);
    assert.deepEqual(p.factores.map((f) => f.id), ['encaje', 'importe', 'cierre', 'esfuerzo', 'probabilidad']);
    for (const f of p.factores) {
      assert.ok(f.explicacion.length > 5 && !f.explicacion.includes('\n'));
      assert.ok(f.subpuntuacion >= 0 && f.subpuntuacion <= 1);
    }
  });

  test('todo desconocido no se acerca a lo bueno', () => {
    const p = puntuar(entrada(null, null), config);
    assert.ok(p.total < 40, `total ${p.total}`);
    assert.equal(p.analizada, false);
    assert.ok(p.factores.every((f) => !f.conocido));
  });

  test('excluidas: no admite ESFL y cerrada; la que cierra hoy no', () => {
    const no = puntuar(entrada(analisis({ esfl: 'no', lineas: 3, max: '100.000 €' })), config);
    assert.equal(no.total, 0);
    assert.match(no.excluida!, /No admite entidades sin ánimo de lucro/);
    const cerrada = puntuar(entrada(analisis({ lineas: 3 }), -2), config);
    assert.equal(cerrada.total, 0);
    assert.match(cerrada.excluida!, /Cerrada desde hace 2 días/);
    assert.equal(puntuar(entrada(analisis({ lineas: 3 }), 0), config).excluida, null);
  });

  test('los pesos vienen de la configuración: cambiarlos cambia el total sin tocar la lógica', () => {
    const e = entrada(analisis({ lineas: 3, max: '2.000 €' }), 30); // encaje 1, importe 0
    const soloEncaje: ConfigPuntuacion = { ...config, pesos: { encaje: 1, importe: 0, cierre: 0, esfuerzo: 0, probabilidad: 0 } };
    const soloImporte: ConfigPuntuacion = { ...config, pesos: { encaje: 0, importe: 1, cierre: 0, esfuerzo: 0, probabilidad: 0 } };
    assert.equal(puntuar(e, soloEncaje).total, 100);
    assert.equal(puntuar(e, soloImporte).total, 0);
    assert.equal(factor(e, 'encaje', soloEncaje).peso, 1);
  });

  test('el fichero de configuración se valida', () => {
    assert.throws(() => leerConfigPuntuacion(RUTA_PUNTUACION.replace('puntuacion.json', 'festivos.json')), /peso válido/);
  });
});
