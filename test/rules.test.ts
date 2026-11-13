import assert from 'node:assert/strict';
import { test } from 'node:test';
import { condicionAmbito, cribar } from '../src/rules.ts';
import { leerSemilla } from '../src/seed.ts';
import type { Convocatoria } from '../src/types.ts';
import { RUTA_SEMILLA } from './support/bd.ts';

const perfil = leerSemilla(RUTA_SEMILLA).perfil;

function conv(parcial: Partial<Convocatoria>): Convocatoria {
  return {
    id: 'x:1', fuente: 'x', fuenteId: '1', titulo: 'Ayudas a proyectos ambientales',
    organo: { nivel1: 'ESTADO', nivel2: null, nivel3: null }, fechaPublicacion: '2026-01-01', url: 'https://example.org',
    tipo: null, finalidad: null, regiones: [], abierto: null, datos: null, ...parcial,
  };
}

test('los campos desconocidos no descartan', () => {
  assert.equal(cribar(conv({}), perfil), null);
});

test('comunidad del perfil se admite aunque cambien tildes y mayúsculas', () => {
  assert.equal(cribar(conv({ organo: { nivel1: 'AUTONOMICA', nivel2: 'Comunidad de Madrid', nivel3: null } }), perfil), null);
});

test('órgano local se admite solo si su región está en el perfil', () => {
  const local = { nivel1: 'LOCAL', nivel2: 'TRES CANTOS', nivel3: null };
  assert.equal(cribar(conv({ organo: local, regiones: ['ES300'] }), perfil), null);
  assert.equal(cribar(conv({ organo: local, regiones: [] }), perfil)?.regla, 'ambito');
});

test('la finalidad se compara sin tildes ni mayúsculas', () => {
  assert.equal(cribar(conv({ finalidad: 'Acceso a la vivienda y fomento de la edificacion' }), perfil)?.regla, 'finalidad');
});

test('otra comunidad no se descarta por regla: queda condicionada a la criba (sede); sin la opción del perfil, se descarta', () => {
  const galicia = conv({ organo: { nivel1: 'AUTONOMICA', nivel2: 'GALICIA', nivel3: null } });
  assert.equal(cribar(galicia, perfil), null);
  assert.match(condicionAmbito(galicia, perfil) ?? '', /GALICIA.*sede/);
  assert.equal(condicionAmbito(conv({}), perfil), null, 'el Estado no lleva condición');
  assert.equal(condicionAmbito(conv({ organo: { nivel1: 'AUTONOMICA', nivel2: 'COMUNIDAD DE MADRID', nivel3: null } }), perfil), null);

  const sinOpcion = { ...perfil, ambito: { ...perfil.ambito, otrasComunidadesSiNoExigenSede: false } };
  assert.equal(cribar(galicia, sinOpcion)?.regla, 'ambito');
  assert.equal(condicionAmbito(galicia, sinOpcion), null);
  // Los ayuntamientos de fuera siguen descartándose: la opción solo cubre órganos autonómicos.
  assert.equal(cribar(conv({ organo: { nivel1: 'LOCAL', nivel2: 'MIJAS', nivel3: null } }), perfil)?.regla, 'ambito');
});
