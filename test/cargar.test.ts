// R16: `npm run cargar -- <número>` mete convocatorias concretas de BDNS (aunque sean antiguas) por el camino normal, y solo esas.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { crearApi } from '../src/api/app.ts';
import { guardarConvocatoria, leerConvocatoria, leerFases } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { crearFuenteBdnsNumeros } from '../src/sources/bdns.ts';
import { bdSembrada, relojFijo } from './support/bd.ts';
import { fetchGrabado } from './support/grabaciones.ts';

const AHORA = new Date('2026-11-13T09:00:00Z');

test('carga una convocatoria antigua por su número: reglas, criba, ganadores y ficha; lo pendiente de la ventana no se toca', async () => {
  const db = bdSembrada();
  // Otra convocatoria pendiente de criba dentro de la ventana: `cargar` no debe procesarla.
  guardarConvocatoria(db, { convocatoria: {
    id: 'eu_ft:X', fuente: 'eu_ft', fuenteId: 'X', titulo: 'Otra', organo: { nivel1: 'UE', nivel2: null, nivel3: null }, fechaPublicacion: '2026-11-10',
    url: 'https://example.org', tipo: null, finalidad: null, regiones: [], abierto: null, datos: {},
  }, descarte: null }, AHORA);
  const cribadas: string[] = [];
  const llm: Llm = {
    async generar(p: PeticionLlm) {
      cribadas.push(/Convocatoria (\S+):/.exec(p.mensaje)?.[1] ?? '');
      return { datos: { decision: 'puede_encajar', motivo: 'Proyectos ambientales de ESFL', exigeSedeEnOtraComunidad: 'no_aplica' }, modelo: p.modelo, uso: { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 } };
    },
  };
  const urls: string[] = [];
  const base = fetchGrabado({ concesiones: true });
  const fetch = (async (u: string | URL | Request, i?: RequestInit) => { urls.push(String(u)); return base(u, i); }) as typeof globalThis.fetch;

  const r = await ejecutarRadar(
    { db, fetch, reloj: relojFijo(AHORA), llm, configLlm: { maxAnalisis: 0 }, fuentes: [crearFuenteBdnsNumeros(['825309'])], parecidas: false, ganadores: { maxPeticiones: 50, pausaMs: 0 } },
    { incluirIds: ['bdns:825309'], soloIncluidas: true },
  );
  const g = leerConvocatoria(db, 'bdns:825309')!;
  assert.equal(g.convocatoria.fechaPublicacion, '2025-04-07', 'publicada hace más de un año, fuera de la ventana de 30 días');
  assert.deepEqual(cribadas, ['bdns:825309'], 'solo se criba la pedida');
  assert.equal(leerFases(db, 'eu_ft:X').length, 0);
  assert.equal(leerFases(db, 'bdns:825309').find((f) => f.fase === 'criba_llm')?.descarta, false);
  assert.ok(urls.some((u) => u.includes('/concesiones/busqueda') && u.includes('numeroConvocatoria=825309')), 'pide sus ganadores');
  assert.equal(r.fases.find((f) => f.fase === 'analisis')!.llamadas, 0, 'el análisis respeta el tope (0): ninguna llamada a Sonnet');

  const ficha = (await (await crearApi({ db, reloj: { now: () => AHORA }, equipo: { password: null } }).request('/convocatorias/bdns%3A825309')).json()) as { titulo: string; ganadoresPrevios: { ediciones: { numeroConvocatoria: string; ganadores: unknown[] }[] } };
  assert.ok(ficha.titulo);
  assert.ok(ficha.ganadoresPrevios.ediciones.some((e) => e.numeroConvocatoria === '825309' && e.ganadores.length > 0), 'la ficha enseña quién la ganó');
});

test('npm run cargar sin números válidos explica el uso y sale con 1', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli', 'cargar.ts');
  for (const [args, mensaje] of [[[], /Uso: npm run cargar -- <numeroConvocatoria>/], [['abc'], /no válidos: abc/]] as const) {
    const r = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, DB_PATH: ':memory:' }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, mensaje);
  }
});
