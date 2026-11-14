// Ámbito de actuación (dónde se ejecuta el proyecto) y programas de consorcio (Horizon Europe), a través del motor (fuente falsa, LLM falso,
// reloj fijo), la API en memoria y el resumen del lunes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { abrirBd } from '../src/db/schema.ts';
import { leerPerfil } from '../src/db/repo.ts';
import { prepararResumen } from '../src/engine.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { leerSemilla, sembrarSiVacia } from '../src/seed.ts';
import type { Convocatoria } from '../src/types.ts';
import type { Fuente } from '../src/sources/source.ts';
import { bdSembrada, RUTA_PUNTUACION, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
import { fetchGrabado } from './support/grabaciones.ts';

const AHORA = new Date('2026-11-14T09:00:00Z');
const config = leerConfigPuntuacion(RUTA_PUNTUACION);

const conv = (fuente: string, fuenteId: string, titulo: string, nivel1: string, nivel2: string | null, regiones: string[] = []): Convocatoria => ({
  id: `${fuente === 'eu_ft' ? 'ft' : fuente}:${fuenteId}`, fuente, fuenteId, titulo, organo: { nivel1, nivel2, nivel3: null },
  fechaPublicacion: '2026-11-13', url: `https://example.org/${fuenteId}`, tipo: null, finalidad: null, regiones, abierto: true, datos: {},
});

const CASOS: Convocatoria[] = [
  conv('bdns', '1001', 'Ayudas GFS 2026 para actuaciones silvícolas', 'AUTONOMICA', 'CATALUÑA', ['ES51']),
  conv('bdns', '1002', 'Subvenciones de la Diputación de Segovia para conservación del medio natural', 'LOCAL', 'DIPUTACIÓN PROV. DE SEGOVIA'),
  conv('bdns', '1003', 'Ayudas de Castilla y León a la conservación, solo en Burgos', 'AUTONOMICA', 'CASTILLA Y LEÓN', ['ES412']),
  conv('bdns', '1004', 'Ayudas de Castilla y León a la restauración, sin provincia declarada', 'AUTONOMICA', 'CASTILLA Y LEÓN'),
  conv('bdns', '1005', 'Ayudas de Castilla y León a la restauración, admite Segovia', 'AUTONOMICA', 'CASTILLA Y LEÓN', ['ES416']),
  conv('eu_ft', 'HORIZON-CL6-2027-01-BIODIV-01', 'Restoring ecosystems at scale (research and innovation action)', 'UE', 'Horizon Europe'),
  conv('eu_ft', 'LIFE-2026-SAP-NAT-01', 'LIFE nature and biodiversity action grants', 'UE', 'LIFE'),
];

const fuenteFalsa = (nombre: string): Fuente => ({
  nombre,
  recoger: async (ctx) => ({ cribadas: CASOS.filter((c) => c.fuente === nombre).map((c) => ({ convocatoria: c, descarte: ctx.cribar(c) })), errores: [] }),
  documentos: (c) => [{ titulo: 'Ficha', url: null, texto: c.titulo }],
});
const fuentes = [fuenteFalsa('bdns'), fuenteFalsa('eu_ft')];

const USO = { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 };
/** Criba falsa: la 1004 (CyL sin provincia declarada) limita el proyecto a otras provincias; el resto puede encajar. */
const llm: Llm = {
  async generar(p: PeticionLlm) {
    const sede = /Convocatoria bdns:1004:/.test(p.mensaje) ? 'si' : 'no_aplica';
    return { datos: { decision: 'puede_encajar', motivo: 'Encaja', exigeSedeEnOtraComunidad: sede }, modelo: p.modelo, uso: USO };
  },
};

async function bdConEjecucion(): Promise<DatabaseSync> {
  const db = bdSembrada();
  await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(AHORA), llm, fuentes, configLlm: { maxAnalisis: 0 }, parecidas: false }, { diasAtras: 3 });
  return db;
}
const regla = (db: DatabaseSync, id: string) => (db.prepare('SELECT descarte_regla AS r FROM convocatorias WHERE id = ?').get(id) as { r: string | null }).r;
const criba = (db: DatabaseSync, id: string) => db.prepare("SELECT descarta FROM convocatoria_fases WHERE convocatoria_id = ? AND fase = 'criba_llm'").get(id) as { descarta: number } | undefined;

describe('ámbito de actuación en el motor', () => {
  test('Cataluña: descartada por regla; Castilla y León solo Burgos: por regla; sin provincia declarada: la criba la descarta; Segovia y diputación de Segovia pasan', async () => {
    const db = await bdConEjecucion();
    assert.equal(regla(db, 'bdns:1001'), 'ambito');
    assert.equal(regla(db, 'bdns:1003'), 'ambito');
    assert.equal(regla(db, 'bdns:1002'), null);
    assert.equal(regla(db, 'bdns:1004'), null, 'parcial: no se descarta por regla');
    assert.match((db.prepare("SELECT condicion FROM convocatorias WHERE id = 'bdns:1004'").get() as { condicion: string }).condicion, /Segovia, Ávila/);
    assert.equal(criba(db, 'bdns:1004')?.descarta, 1, 'la criba (LLM falso) la descarta: el texto limita a otras provincias');
    assert.equal(regla(db, 'bdns:1005'), null);
    assert.equal(criba(db, 'bdns:1005')?.descarta, 0);
    assert.equal(criba(db, 'bdns:1001'), undefined, 'lo descartado por regla no llega a la criba');
  });

  test('el prompt de la criba dice dónde debe ejecutarse el proyecto, con los territorios del perfil', async () => {
    const db = bdSembrada();
    const sistemas: string[] = [];
    const espia: Llm = { async generar(p) { sistemas.push(p.sistema); return llm.generar(p); } };
    await ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(AHORA), llm: espia, fuentes, configLlm: { maxAnalisis: 0 }, parecidas: false }, { diasAtras: 3 });
    assert.ok(sistemas.length > 0);
    assert.match(sistemas[0], /El proyecto debe ejecutarse en: Comunidad de Madrid; Segovia y Ávila \(Castilla y León\); Guadalajara, Toledo y Cuenca \(Castilla-La Mancha\)\./);
  });

  test('un cambio de ámbito reaplica las reglas a lo ya guardado: las catalanas ya vistas desaparecen sin que la fuente las devuelva', async () => {
    const db = bdSembrada();
    db.prepare('UPDATE perfil SET datos = json_set(datos, \'$.ambito.territorios\', json(?))').run(JSON.stringify([{ comunidad: 'Cataluña', provincias: [] }, { comunidad: 'Comunidad de Madrid', provincias: [] }]));
    const deps = { db, fetch: fetchGrabado(), reloj: relojFijo(AHORA), llm, fuentes, configLlm: { maxAnalisis: 0 }, parecidas: false };
    await ejecutarRadar(deps, { diasAtras: 3 });
    assert.equal(regla(db, 'bdns:1001'), null, 'con Cataluña en el ámbito, entra');
    db.prepare('UPDATE perfil SET datos = json_set(datos, \'$.ambito.territorios\', json(?))').run(JSON.stringify([{ comunidad: 'Comunidad de Madrid', provincias: [] }]));
    await ejecutarRadar({ ...deps, fuentes: [{ ...fuentes[0], recoger: async () => ({ cribadas: [], errores: [] }) }, fuentes[1]] }, { diasAtras: 3 });
    assert.equal(regla(db, 'bdns:1001'), 'ambito', 'la fuente ya no la devuelve, pero la regla se reaplica');
  });
});

describe('programas de consorcio (Horizon Europe)', () => {
  test('Horizon va a la sección consorcio (no a nuevas/abiertas/cierran_pronto), con el esfuerzo penalizado; LIFE sigue en el ranking principal', async () => {
    const db = await bdConEjecucion();
    const api = crearApi({ db, reloj: relojFijo(AHORA), fuentes, puntuacion: config });
    const semana = await (await api.request('/semana')).json() as { convocatorias: { id: string; seccion: string; puntuacion: { total: number; factores: { id: string; subpuntuacion: number; explicacion: string }[] } }[]; lasGananParecidas: string[] };
    const por = (id: string) => semana.convocatorias.find((c) => c.id === id)!;
    assert.equal(por('ft:HORIZON-CL6-2027-01-BIODIV-01').seccion, 'consorcio');
    assert.ok(['nuevas', 'abiertas', 'cierran_pronto'].includes(por('ft:LIFE-2026-SAP-NAT-01').seccion));
    for (const c of semana.convocatorias.filter((c) => c.seccion !== 'consorcio')) assert.ok(!c.id.includes('HORIZON'));
    const esf = (id: string) => por(id).puntuacion.factores.find((f) => f.id === 'esfuerzo')!;
    assert.ok(esf('ft:HORIZON-CL6-2027-01-BIODIV-01').subpuntuacion < esf('ft:LIFE-2026-SAP-NAT-01').subpuntuacion);
    assert.match(esf('ft:HORIZON-CL6-2027-01-BIODIV-01').explicacion, /socia de un consorcio/);
    // Sin ámbito ajeno: Cataluña y Burgos no salen
    const ids = semana.convocatorias.map((c) => c.id);
    assert.ok(!ids.includes('bdns:1001') && !ids.includes('bdns:1003') && !ids.includes('bdns:1004'));
    assert.ok(ids.includes('bdns:1002') && ids.includes('bdns:1005'));
  });

  test('la regla sale de la configuración: sin el prefijo en la lista, Horizon vuelve al ranking principal', async () => {
    const db = await bdConEjecucion();
    const api = crearApi({ db, reloj: relojFijo(AHORA), fuentes, puntuacion: { ...config, consorcio: { prefijosPrograma: [], esfuerzoMultiplicador: 0.4 } } });
    const semana = await (await api.request('/semana')).json() as { convocatorias: { id: string; seccion: string }[] };
    assert.notEqual(semana.convocatorias.find((c) => c.id === 'ft:HORIZON-CL6-2027-01-BIODIV-01')!.seccion, 'consorcio');
  });

  test('el resumen del lunes no destaca las de consorcio: solo una línea con enlace a la sección', async () => {
    const db = await bdConEjecucion();
    const { correo } = prepararResumen({ db, reloj: relojFijo(AHORA), puntuacion: config }, { urlPublica: 'https://radar.example.org' });
    assert.ok(!correo.texto.includes('Restoring ecosystems at scale'), 'el topic de Horizon no sale en ninguna sección');
    assert.match(correo.texto, /1 convocatoria europea para ir como socio de un consorcio: https:\/\/radar\.example\.org\/#consorcio/);
    assert.match(correo.texto, /LIFE nature and biodiversity/);
    assert.match(correo.html, /href="https:\/\/radar\.example\.org\/#consorcio"/);
  });
});

describe('migración del perfil guardado', () => {
  test('un perfil sin territorios los recibe de la semilla (con sus regiones) y pierde la bandera antigua; con territorios no se toca', () => {
    const semilla = leerSemilla(RUTA_SEMILLA).perfil;
    const db = abrirBd(':memory:');
    const { territorios: _t, ...ambitoViejo } = semilla.ambito;
    const viejo = { ...semilla, ambito: { ...ambitoViejo, descripcion: 'Estatal + UE + Madrid; otras comunidades si no exigen sede', comunidades: ['COMUNIDAD DE MADRID'], regiones: ['ES3', 'ES30', 'ES300', 'ES999'], otrasComunidadesSiNoExigenSede: true } };
    db.prepare('INSERT INTO perfil (id, datos, actualizado_en) VALUES (1, ?, ?)').run(JSON.stringify(viejo), AHORA.toISOString());

    assert.equal(sembrarSiVacia(db, RUTA_SEMILLA, AHORA), false);
    const p = leerPerfil(db)!;
    assert.deepEqual(p.ambito.territorios, semilla.ambito.territorios);
    assert.equal('otrasComunidadesSiNoExigenSede' in p.ambito, false);
    assert.equal(p.ambito.descripcion, semilla.ambito.descripcion);
    for (const r of [...semilla.ambito.regiones, 'ES999']) assert.ok(p.ambito.regiones.includes(r), r);
    assert.deepEqual(p.ambito.nivelesSiempre, semilla.ambito.nivelesSiempre);

    const editado = { ...p, ambito: { ...p.ambito, territorios: [{ comunidad: 'Galicia', provincias: [] }] } };
    db.prepare('UPDATE perfil SET datos = ?').run(JSON.stringify(editado));
    sembrarSiVacia(db, RUTA_SEMILLA, AHORA);
    assert.deepEqual(leerPerfil(db)!.ambito.territorios, [{ comunidad: 'Galicia', provincias: [] }], 'lo que el equipo editó no se pisa');
  });
});
