import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('npm run radar sale con código distinto de 0 si falla el propio proceso', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-cli-'));
  try {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli', 'radar.ts')], {
      env: { ...process.env, DB_PATH: join(dir, 'radar.sqlite'), SEED_FILE: join(dir, 'no-existe.json') },
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /El radar falló/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm run licitaciones rechaza un número de páginas fuera de rango sin tocar la red ni la BD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-cli-'));
  try {
    for (const args of [['--paginas', '0'], ['--paginas', '999'], ['--paginas', 'x'], ['--rapido']]) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli', 'licitaciones.ts'), ...args], { env: { ...process.env, DB_PATH: join(dir, 'radar.sqlite') }, encoding: 'utf8' });
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, /Uso: npm run licitaciones/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
