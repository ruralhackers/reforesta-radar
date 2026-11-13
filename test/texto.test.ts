import assert from 'node:assert/strict';
import { test } from 'node:test';
import { citaEnTexto, normalizarParaCita, valorEnCita } from '../src/texto.ts';

test('el valor de un campo numérico tiene que estar en su cita, sin depender del formato', () => {
  assert.ok(valorEnCita('17.389.322,52 €', 'en una cuantía total de 17.389.322,52 €'));
  assert.ok(valorEnCita('100.000 €', 'hasta un máximo de 100.000,00 euros por proyecto'));
  assert.ok(valorEnCita('15 días hábiles', 'será de quince días hábiles'));
  assert.ok(valorEnCita('20 %', 'una cofinanciación mínima del veinte por ciento'));
  assert.ok(valorEnCita('Hasta el 30 de septiembre de 2026', 'finaliza el 30/09/2026'));
  assert.ok(valorEnCita('45 días naturales', 'cuarenta y cinco días naturales'));
  assert.ok(valorEnCita('No se exige', 'no se exige cofinanciación'), 'sin cifras no hay nada que contrastar');
  // Caso real (941026): "un porcentaje" no es el número 1.
  assert.ok(valorEnCita('No exige un porcentaje de cofinanciación; la entidad asume la diferencia', 'la entidad asumirá la diferencia'));
  assert.ok(valorEnCita('Un mes desde la publicación', 'El plazo de presentación de solicitudes es de un mes'));

  assert.ok(!valorEnCita('100.000 €', 'El plazo para la presentación de las solicitudes será de quince días hábiles'));
  assert.ok(!valorEnCita('10.000 €', 'hasta 100.000 euros'));
  assert.ok(!valorEnCita('30 de octubre', 'hasta el 30 de septiembre'));
});

test('las citas se buscan sin depender de saltos de línea ni de la tipografía', () => {
  const texto = normalizarParaCita('la “Línea A” de subvenciones destinadas\na entidades del Tercer Sector, cofinan-\nciación');
  assert.ok(citaEnTexto('la "Línea A" de subvenciones destinadas a entidades', texto));
  assert.ok(citaEnTexto('Tercer Sector, cofinanciación', texto));
  assert.ok(!citaEnTexto('entidades del Cuarto Sector', texto));
});

test('cifras y fechas en formato inglés (convocatorias de la UE) se contrastan igual que las españolas', () => {
  // Importes: coma de millares, espacios de millares, "million", abreviaturas.
  assert.ok(valorEnCita('3.000.000 €', 'with a total budget of EUR 3,000,000'));
  assert.ok(valorEnCita('3.000.000 €', 'the budget is EUR 3 000 000 per topic'));
  assert.ok(valorEnCita('3.000.000 €', 'an indicative budget of EUR 3 million'));
  assert.ok(valorEnCita('3.500.000 €', 'EU contribution of €3.5M'));
  assert.ok(valorEnCita('3.500.000 €', 'EU contribution of 3.5 million'));
  assert.ok(valorEnCita('4.000.000 €', 'between EUR 2,500,000.00 and EUR 4,000,000.00'));
  assert.ok(valorEnCita('3 millones de euros', 'a total of EUR 3,000,000'));
  assert.ok(valorEnCita('3,000,000 €', 'una cuantía de 3.000.000 euros'), 'el valor en formato inglés contra una cita en castellano');
  // Fechas y plazos.
  assert.ok(valorEnCita('14 de enero de 2027', 'Deadline: 14 January 2027 at 17:00 CET'));
  assert.ok(valorEnCita('14 de enero de 2027', 'Deadline: January 14, 2027'));
  assert.ok(valorEnCita('14 de enero de 2027', 'deadline date: 14/01/2027'));
  assert.ok(valorEnCita('14 de enero de 2027', 'deadline date: 2027-01-14'));
  assert.ok(valorEnCita('15 días hábiles', 'within fifteen working days'));
  assert.ok(valorEnCita('25 días', 'in twenty-five days'));
  assert.ok(valorEnCita('70 %', 'a funding rate of 70%'));
  // Siguen rechazándose las cifras que no están.
  assert.ok(!valorEnCita('3.000.000 €', 'EUR 3,500,000'));
  assert.ok(!valorEnCita('3.000.000 €', 'EUR 3 million and 500 thousand'.replace('3 million', '4 million')));
  assert.ok(!valorEnCita('14 de febrero de 2027', 'Deadline: 14 January 2027'));
  assert.ok(!valorEnCita('30.000 €', 'EUR 3,000,000'));
});

test('el formato español sigue leyéndose igual: 1.500 = 1500, 60.000,00 = 60000', () => {
  assert.ok(valorEnCita('1.500 €', 'hasta 1.500 euros'));
  assert.ok(valorEnCita('1500 €', 'hasta 1.500 euros'));
  assert.ok(valorEnCita('60.000 €', 'un máximo de 60.000,00 euros'));
  assert.ok(!valorEnCita('15 €', 'hasta 1.500 euros'));
  assert.ok(!valorEnCita('6.000 €', 'un máximo de 60.000,00 euros'));
});

test('un importe del valor no se cuela por leerlo en el formato equivocado (50.000 no es 50)', () => {
  assert.ok(!valorEnCita('50.000 €', 'para 50 personas y 3.000 euros'));
  assert.ok(!valorEnCita('50.000 €', 'for 50 participants and EUR 3,000'));
  assert.ok(!valorEnCita('3.000 €', 'for 3 partners'));
  assert.ok(!valorEnCita('2.500.000 €', 'EUR 2.5 and 500 partners'));
  // El valor en inglés solo se lee así cuando el formato es imposible en castellano.
  assert.ok(valorEnCita('3,000,000 €', 'EUR 3,000,000'));
  assert.ok(valorEnCita('2,500,000.50', 'EUR 2,500,000.50'));
  assert.ok(valorEnCita('3.5 million', 'EUR 3,500,000'));
  assert.ok(valorEnCita('50.000 €', 'EUR 50,000 per project'), 'la cita sí admite las dos lecturas');
});
