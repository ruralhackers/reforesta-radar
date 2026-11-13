import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { crearApi } from '../src/api/app.ts';
import { guardarConvocatoria, guardarFase } from '../src/db/repo.ts';
import { abrirBd } from '../src/db/schema.ts';
import type { Convocatoria, Descarte } from '../src/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'radar-api-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function conv(id: string, fechaPublicacion: string): Convocatoria {
  return {
    id: `bdns:${id}`, fuente: 'bdns', fuenteId: id, titulo: `Convocatoria ${id}`,
    organo: { nivel1: 'ESTADO', nivel2: 'MINISTERIO X', nivel3: 'DG Y' }, fechaPublicacion,
    url: `https://example.org/${id}`, tipo: null, finalidad: null, regiones: [], abierto: null, datos: {},
  };
}

test('GET /semana lista las candidatas de los últimos 7 días, más recientes primero', async () => {
  const db = abrirBd(join(dir, 'radar.sqlite'));
  const ahora = new Date('2026-11-13T10:00:00Z');
  const guardar = (c: Convocatoria, descarte: Descarte | null = null) => guardarConvocatoria(db, { convocatoria: c, descarte }, ahora);
  guardar(conv('1', '2026-11-13'));
  guardar(conv('2', '2026-11-07'));
  guardar(conv('3', '2026-11-06')); // fuera de la semana
  guardar(conv('4', '2026-11-12'), { regla: 'nominativa', motivo: 'Subvención nominativa' });

  const api = crearApi({ db, reloj: { now: () => ahora } });
  const res = await api.request('/semana');
  assert.equal(res.status, 200);
  const cuerpo = await res.json() as { desde: string; hasta: string; convocatorias: { id: string; organo: string; url: string }[] };
  assert.equal(cuerpo.desde, '2026-11-07');
  assert.equal(cuerpo.hasta, '2026-11-13');
  assert.deepEqual(cuerpo.convocatorias.map((c) => c.id), ['bdns:1', 'bdns:2']);
  assert.equal(cuerpo.convocatorias[0].organo, 'MINISTERIO X · DG Y');
  assert.equal(cuerpo.convocatorias[0].url, 'https://example.org/1');
  db.close();
});

test('GET /convocatorias/:id da la ficha con campos citados, desconocidos y enlaces; /descartes muestra los de la criba', async () => {
  const db = abrirBd(join(dir, 'ficha.sqlite'));
  const ahora = new Date('2026-11-13T10:00:00Z');
  const c = {
    ...conv('9', '2026-11-12'),
    datos: { detalle: {
      urlBasesReguladoras: 'https://www.boe.es/bases.pdf', descripcionBasesReguladoras: 'Orden de bases',
      sedeElectronica: 'https://sede.example.org', documentos: [{ id: 77, descripcion: 'Convocatoria', nombreFic: 'c.pdf' }],
      anuncios: [{ titulo: 'Extracto', texto: '<p>x</p>', url: 'https://www.boe.es/extracto', cve: 'BOE-B-1', desDiarioOficial: 'BOE', datPublicacion: '2026-11-12' }],
    } },
  };
  guardarConvocatoria(db, { convocatoria: c, descarte: null }, ahora);
  guardarConvocatoria(db, { convocatoria: conv('10', '2026-11-12'), descarte: null }, ahora);
  guardarFase(db, { convocatoriaId: 'bdns:9', fase: 'criba_llm', descarta: false, motivo: 'Para ONG', datos: { decision: 'puede_encajar' } }, ahora);
  guardarFase(db, { convocatoriaId: 'bdns:10', fase: 'criba_llm', descarta: true, motivo: 'Becas individuales', datos: { decision: 'descartar' } }, ahora);
  const campos = {
    elegibilidadEsfl: { valor: 'si', cita: 'entidades sin ánimo de lucro', documento: 'Bases reguladoras' },
    importeMaximoProyecto: { valor: null, cita: null, documento: null, motivo: 'sin cita literal' },
  };
  guardarFase(db, { convocatoriaId: 'bdns:9', fase: 'analisis', descarta: false, motivo: null, datos: { modelo: 'm', analisis: campos, documentos: [], documentosConError: [] } }, ahora);

  const api = crearApi({ db, reloj: { now: () => ahora } });
  const res = await api.request(`/convocatorias/${encodeURIComponent('bdns:9')}`);
  assert.equal(res.status, 200);
  const ficha = await res.json() as {
    enJuego: boolean; criba: { motivo: string }; analisis: { campos: typeof campos }; enlaces: { tipo: string; url: string }[];
  };
  assert.equal(ficha.enJuego, true);
  assert.equal(ficha.criba.motivo, 'Para ONG');
  assert.equal(ficha.analisis.campos.elegibilidadEsfl.cita, 'entidades sin ánimo de lucro');
  assert.equal(ficha.analisis.campos.importeMaximoProyecto.valor, null);
  assert.deepEqual(ficha.enlaces.map((e) => e.tipo), ['ficha', 'bases', 'extracto', 'sede', 'documento']);
  assert.equal(ficha.enlaces[4].url, 'https://www.infosubvenciones.es/bdnstrans/api/convocatorias/documentos?idDocumento=77');

  assert.equal((await api.request('/convocatorias/bdns%3A404')).status, 404);

  const descartes = await (await api.request('/descartes?por=criba_llm')).json() as { convocatorias: { id: string; por: string; motivo: string }[] };
  assert.deepEqual(descartes.convocatorias.map((d) => [d.id, d.por, d.motivo]), [['bdns:10', 'criba_llm', 'Becas individuales']]);
  const semana = await (await api.request('/semana')).json() as { convocatorias: { id: string }[] };
  assert.deepEqual(semana.convocatorias.map((x) => x.id), ['bdns:9']);
  db.close();
});
