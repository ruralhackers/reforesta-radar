import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { crearApi } from '../src/api/app.ts';
import { guardarConvocatoria } from '../src/db/repo.ts';
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
