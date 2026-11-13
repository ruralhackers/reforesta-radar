import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aplicarCitas, contarUniones, esquemaAnalisis } from '../src/fases/analisis-esquema.ts';
import { ESQUEMA_CRIBA } from '../src/llm/prompts.ts';
import { leerSemilla } from '../src/seed.ts';
import { RUTA_SEMILLA } from './support/bd.ts';

const perfil = leerSemilla(RUTA_SEMILLA).perfil;

test('los esquemas de salida estructurada caben en el límite de la API (≤ 16 parámetros con uniones)', () => {
  assert.equal(contarUniones({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] }, b: { type: ['string', 'null'] } } }), 2);
  assert.ok(contarUniones(esquemaAnalisis(perfil)) <= 16, `análisis: ${contarUniones(esquemaAnalisis(perfil))} uniones`);
  assert.ok(contarUniones(ESQUEMA_CRIBA) <= 16);
});

test('la cadena vacía es "desconocido" y un valor con cita vacía también', () => {
  const textos = [{ titulo: 'Extracto', texto: 'La cuantía total máxima será de 250.000 euros.' }];
  const a = aplicarCitas({
    elegibilidadEsfl: { valor: '', cita: '', documento: '' },
    importeMaximoProyecto: { valor: '30.000 €', cita: '', documento: '' },
    importeTotal: { valor: '250.000 €', cita: 'La cuantía total máxima será de 250.000 euros', documento: 'Extracto' },
    plazo: { valor: '', cita: '', documento: '' },
    cofinanciacion: { valor: '', cita: '', documento: '' },
    requisitos: [{ valor: '', cita: '', documento: '' }],
    lineas: [{ linea: perfil.lineas[0].nombre, motivo: 'x', cita: '', documento: '' }],
    ideaProyecto: '',
  }, textos, perfil);
  assert.equal(a.elegibilidadEsfl.valor, null);
  assert.equal(a.importeMaximoProyecto.valor, null);
  assert.equal(a.importeMaximoProyecto.motivo, 'sin cita literal');
  assert.equal(a.importeTotal.valor, '250.000 €');
  assert.equal(a.importeTotal.documento, 'Extracto');
  assert.deepEqual(a.requisitos, []);
  assert.equal(a.lineas[0].cita, null);
  assert.equal(a.ideaProyecto, null);
});
