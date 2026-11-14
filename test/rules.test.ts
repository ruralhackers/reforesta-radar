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

const auto = (nivel2: string, regiones: string[] = []) => conv({ organo: { nivel1: 'AUTONOMICA', nivel2, nivel3: null }, regiones });
const local = (nivel2: string, regiones: string[] = []) => conv({ organo: { nivel1: 'LOCAL', nivel2, nivel3: null }, regiones });

test('autonómica de otra comunidad (Cataluña): descartada por regla; el proyecto debe ejecutarse en el ámbito del perfil', () => {
  assert.equal(cribar(auto('CATALUÑA', ['ES51']), perfil)?.regla, 'ambito');
  assert.equal(cribar(auto('GALICIA'), perfil)?.regla, 'ambito');
  assert.equal(condicionAmbito(auto('CATALUÑA'), perfil), null);
});

test('comunidad entera en el ámbito (Madrid): pasa sin condición', () => {
  assert.equal(cribar(auto('COMUNIDAD DE MADRID'), perfil), null);
  assert.equal(condicionAmbito(auto('COMUNIDAD DE MADRID'), perfil), null);
});

test('Castilla y León solo en parte: pasa condicionada a la criba; si declara solo otras provincias (Burgos), se descarta por regla; si declara Segovia, pasa', () => {
  const cyl = auto('CASTILLA Y LEÓN');
  assert.equal(cribar(cyl, perfil), null);
  assert.match(condicionAmbito(cyl, perfil) ?? '', /CASTILLA Y LEÓN.*Segovia, Ávila/);
  assert.equal(cribar(auto('CASTILLA Y LEÓN', ['ES412']), perfil)?.regla, 'ambito', 'Burgos (ES412)');
  assert.equal(cribar(auto('CASTILLA Y LEÓN', ['ES412', 'ES413']), perfil)?.regla, 'ambito');
  assert.equal(cribar(auto('CASTILLA Y LEÓN', ['ES416']), perfil), null, 'Segovia (ES416)');
  assert.equal(condicionAmbito(auto('CASTILLA Y LEÓN', ['ES416']), perfil), null);
  assert.match(condicionAmbito(auto('CASTILLA - LA MANCHA'), perfil) ?? '', /Guadalajara, Toledo, Cuenca/, 'el nombre se compara sin guiones ni espacios');
});

test('local: diputaciones de las provincias del ámbito pasan; Ayuntamiento de Madrid pasa por región; el resto, fuera', () => {
  for (const d of ['SEGOVIA', 'ÁVILA', 'GUADALAJARA', 'TOLEDO', 'CUENCA']) assert.equal(cribar(local(`DIPUTACIÓN PROV. DE ${d}`), perfil), null, d);
  assert.equal(cribar(local('MADRID', ['ES300']), perfil), null);
  assert.equal(cribar(local('DIPUTACIÓN PROV. DE BURGOS'), perfil)?.regla, 'ambito');
  assert.equal(cribar(local('DIPUTACIÓN PROV. DE CÓRDOBA'), perfil)?.regla, 'ambito');
  assert.equal(cribar(local('CABILDO INSULAR DE GRAN CANARIA'), perfil)?.regla, 'ambito');
});
