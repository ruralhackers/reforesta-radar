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
