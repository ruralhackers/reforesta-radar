// Calculadora de plazos (pura) con el calendario real de seed/festivos.json.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diasEntre, sumarMeses } from '../src/dates.ts';
import { calendario, leerFestivos } from '../src/festivos.ts';
import { calcularPlazo, type DatosPlazo, fechaEnTexto, interpretarComputo } from '../src/plazos.ts';
import { RUTA_FESTIVOS } from './support/bd.ts';

const tabla = leerFestivos(RUTA_FESTIVOS);
const madrid = calendario(tabla, ['ES3', 'ES30', 'ES300']);
const soloNacional = calendario(tabla, []);

function datos(parcial: Partial<DatosPlazo>): DatosPlazo {
  return { fechaFin: null, textoFin: null, textoInicio: null, publicaciones: [], registro: '2026-08-03', ...parcial };
}
const EXTRACTO_BOE = [{ dia: '2026-08-07', diario: 'BOE. BOLETÍN OFICIAL DEL ESTADO' }];
const calc = (textoFin: string, base: string, cal = madrid, textoInicio: string | null = 'Día siguiente a la publicación del extracto') =>
  calcularPlazo(datos({ textoFin, textoInicio, publicaciones: [{ dia: base, diario: 'BOE. BOLETÍN OFICIAL DEL ESTADO' }] }), null, cal);

describe('días hábiles', () => {
  test('15 días hábiles tras la publicación del extracto en el BOE (caso 923290)', () => {
    const p = calcularPlazo(datos({ textoFin: '15 días hábiles tras publicación extracto BOE', textoInicio: 'día siguiente de publicación de extracto en el BOE', publicaciones: EXTRACTO_BOE }), null, madrid);
    assert.equal(p.tipo, 'calculada');
    assert.equal(p.fechaCierre, '2026-08-28'); // publicado vie 07/08: el día 1 es el lun 10; el 15º, el vie 28
    assert.equal(p.fechaBase, '2026-08-07');
    assert.equal(p.baseOrigen, 'extracto');
    assert.equal(p.aproximada, false);
    assert.equal(p.textoOriginal, '15 días hábiles tras publicación extracto BOE');
  });

  test('salta Jueves Santo y Viernes Santo (los de Madrid) pero no los cuenta de más sin el calendario madrileño', () => {
    // Publicado mié 01/04/2026; Jueves Santo 02/04 (solo en algunas comunidades) y Viernes Santo 03/04 (nacional).
    assert.equal(calc('3 días hábiles desde la publicación', '2026-04-01').fechaCierre, '2026-04-08');
    assert.equal(calc('3 días hábiles desde la publicación', '2026-04-01', soloNacional).fechaCierre, '2026-04-07');
  });

  test('salta el 1 de mayo (nacional) y el 2 de mayo (Comunidad de Madrid), que cae en sábado en 2026 y en viernes en 2025', () => {
    assert.equal(calc('2 días hábiles desde la publicación', '2026-04-30').fechaCierre, '2026-05-05');
    assert.equal(calc('2 días hábiles desde la publicación', '2025-04-30').fechaCierre, '2025-05-06'); // 1 y 2 festivos, 3 y 4 fin de semana
    assert.equal(calc('2 días hábiles desde la publicación', '2025-04-30', soloNacional).fechaCierre, '2025-05-05');
  });

  test('cifras en letra, con paréntesis, ordinales y días sin calificar (se entienden hábiles)', () => {
    assert.equal(calc('Veinte días (20) hábiles desde el día siguiente al de la publicación en el BOE', '2026-08-07').fechaCierre, '2026-09-04');
    assert.equal(calc('El décimo quinto día hábil siguiente a la publicación', '2026-08-07').fechaCierre, '2026-08-28');
    const sin = calc('10 días a contar desde el día siguiente al de la publicación', '2026-08-07');
    assert.equal(sin.fechaCierre, '2026-08-21');
    assert.match(sin.detalle, /no los califica/);
  });

  test('el texto de inicio aporta la referencia a la publicación cuando el de fin solo dice "10 días hábiles"', () => {
    const p = calc('10 días hábiles', '2025-04-09', madrid, 'Día siguiente a la publicación del extracto en el BOP');
    assert.equal(p.tipo, 'calculada');
    assert.equal(p.fechaCierre, '2025-04-25'); // salta 17 y 18 de abril
  });

  test('si el extracto está en varios diarios se usa el que cita el texto; si no, el primero', () => {
    const publicaciones = [{ dia: '2026-08-10', diario: 'BOCM. B.O. DE LA COMUNIDAD DE MADRID' }, { dia: '2026-08-07', diario: 'BOE. BOLETÍN OFICIAL DEL ESTADO' }];
    const bocm = calcularPlazo(datos({ textoFin: '5 días hábiles desde la publicación en el BOCM', publicaciones }), null, madrid);
    assert.equal(bocm.fechaBase, '2026-08-10');
    const sin = calcularPlazo(datos({ textoFin: '5 días hábiles desde la publicación del extracto', publicaciones }), null, madrid);
    assert.equal(sin.fechaBase, '2026-08-07');
  });

  test('sin fecha del extracto se cuenta desde el registro y se marca como aproximada', () => {
    const p = calcularPlazo(datos({ textoFin: '10 días hábiles desde la publicación en el tablón', registro: '2026-08-03' }), null, madrid);
    assert.equal(p.fechaCierre, '2026-08-17');
    assert.equal(p.baseOrigen, 'registro');
    assert.equal(p.aproximada, true);
  });
});

describe('meses y días naturales', () => {
  test('un mes de fecha a fecha, y si el día no existe, el último del mes', () => {
    assert.equal(sumarMeses('2026-08-07', 1), '2026-09-07');
    assert.equal(sumarMeses('2026-01-31', 1), '2026-02-28');
    assert.equal(sumarMeses('2028-01-31', 1), '2028-02-29');
    assert.equal(sumarMeses('2026-11-30', 3), '2027-02-28');
    assert.equal(sumarMeses('2026-12-15', 2), '2027-02-15');
  });

  test('si el vencimiento es inhábil pasa al primer día hábil siguiente', () => {
    const p = calc('Un mes contado desde el día siguiente al de su publicación en el Boletín', '2026-01-31');
    assert.equal(p.fechaCierre, '2026-03-02'); // 28/02 es sábado
    assert.match(p.detalle, /inhábil/);
    assert.equal(calc('Un mes contado desde el día siguiente a la publicación', '2026-08-07').fechaCierre, '2026-09-07');
    assert.equal(calc('dos meses desde la publicación', '2026-09-30').fechaCierre, '2026-11-30');
  });

  test('días naturales: se suman y, si el último es festivo, pasa al siguiente hábil (según el calendario aplicable)', () => {
    // 04/12/2026 + 3 = lun 07/12: festivo en Madrid (traslado de la Constitución), no en el calendario nacional.
    assert.equal(calc('3 días naturales desde la publicación', '2026-12-04').fechaCierre, '2026-12-09'); // 08/12 también festivo
    assert.equal(calc('3 días naturales desde la publicación', '2026-12-04', soloNacional).fechaCierre, '2026-12-07');
  });
});

describe('fecha literal y desconocida', () => {
  test('la fecha explícita de la fuente manda sobre cualquier texto', () => {
    const p = calcularPlazo(datos({ fechaFin: '2025-09-15', textoFin: '15 de septiembre 2025' }), null, madrid);
    assert.deepEqual([p.tipo, p.fechaCierre], ['literal', '2025-09-15']);
  });

  test('una fecha escrita en el texto es literal', () => {
    assert.equal(fechaEnTexto('15 de septiembre 2025'), '2025-09-15');
    assert.equal(fechaEnTexto('Hasta el día 9 de mayo de 2025, inclusive.'), '2025-05-09');
    assert.equal(fechaEnTexto('09/05/2025'), '2025-05-09');
    assert.equal(fechaEnTexto('31/02/2025'), null);
    assert.equal(fechaEnTexto('15 días hábiles desde el 01/02/2026'), null);
    assert.equal(fechaEnTexto('del 1/3/2025 al 5/4/2025'), null);
    const p = calcularPlazo(datos({ textoFin: '9 de mayo de 2025, inclusive.' }), null, madrid);
    assert.deepEqual([p.tipo, p.fechaCierre], ['literal', '2025-05-09']);
  });

  test('si el texto de la fuente no sirve se usa el plazo literal del análisis', () => {
    const p = calcularPlazo(datos({ textoFin: 'No tiene', publicaciones: EXTRACTO_BOE }), 'quince días hábiles contados desde el siguiente a la publicación del extracto en el BOE', madrid);
    assert.equal(p.tipo, 'calculada');
    assert.equal(p.fechaCierre, '2026-08-28');
  });

  const desconocidas: [string, string | null, string | null][] = [
    ['sin texto ni fecha', null, null],
    ['"No tiene"', 'No tiene', null],
    ['desde la apertura', 'Desde apertura de convocatoria', null],
    ['desde el inicio del plazo (ambiguo: ¿incluye el primer día?)', '10 DÍAS HÁBILES DESDE EL INICIO DEL PLAZO DE SOLICITUD', 'DÍA SIGUIENTE A LA PUBLICACIÓN DE LA CONVOCATORIA EN FORMA DE EXTRACTO'],
    ['sin saber desde cuándo', '10 días hábiles', 'Desde su aprobación en JGL'],
    ['desde la notificación', '10 días hábiles desde la notificación de la publicación', null],
    ['semanas', '2 semanas desde la publicación', null],
    ['días laborables', '10 días laborables desde la publicación', null],
    ['dos plazos', '10 días hábiles o 1 mes desde la publicación', null],
    ['concesión directa', 'concesion directa', null],
  ];
  for (const [nombre, textoFin, textoInicio] of desconocidas) {
    test(`desconocida: ${nombre}, con el texto original a la vista`, () => {
      const p = calcularPlazo(datos({ textoFin, textoInicio, publicaciones: EXTRACTO_BOE }), null, madrid);
      assert.equal(p.tipo, 'desconocida');
      assert.equal(p.fechaCierre, null);
      assert.equal(p.textoOriginal, textoFin);
      assert.ok(p.detalle.length > 0);
    });
  }

  test('un cálculo que sale del calendario de festivos disponible es desconocido, no una fecha dudosa', () => {
    const p = calc('15 días hábiles desde la publicación', '2027-12-20');
    assert.equal(p.tipo, 'desconocida');
    assert.match(p.detalle, /2028/);
  });

  test('interpretarComputo', () => {
    assert.deepEqual(interpretarComputo('Un mes'), { computo: { n: 1, unidad: 'meses', sinCalificar: false } });
    assert.deepEqual(interpretarComputo('treinta días naturales'), { computo: { n: 30, unidad: 'naturales', sinCalificar: false } });
    assert.ok('motivo' in interpretarComputo('en el plazo que se indique'));
  });

  test('diasEntre', () => {
    assert.equal(diasEntre('2026-08-04', '2026-08-28'), 24);
    assert.equal(diasEntre('2026-08-04', '2026-08-01'), -3);
  });
});
