// Capturas de la web para el README y el jurado: arranca el servidor en PORT=8119 contra una COPIA de data/radar.sqlite (la original no se toca),
// hace capturas de 1280×900 (escritorio) y 390×844 (móvil) y para el servidor. Uso: npm run build && npm run capturas
// Necesita chromium de Playwright (CHROMIUM_PATH o ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome).
import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PUERTO = 8119;
const BASE = `http://127.0.0.1:${PUERTO}`;
const SALIDA = join(import.meta.dirname, '..', 'docs', 'capturas');
const ORIGEN_BD = join(import.meta.dirname, '..', 'data', 'radar.sqlite');
const VISTAS = [{ nombre: 'escritorio', ancho: 1280, alto: 900 }, { nombre: 'movil', ancho: 390, alto: 844 }] as const;

function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const raiz = join(homedir(), '.cache', 'ms-playwright');
  const dirs = existsSync(raiz) ? readdirSync(raiz).filter((d) => d.startsWith('chromium-')).sort().reverse() : [];
  for (const d of dirs) {
    const ruta = join(raiz, d, 'chrome-linux64', 'chrome');
    if (existsSync(ruta)) return ruta;
  }
  throw new Error('No encuentro chromium: define CHROMIUM_PATH');
}

/** Copia consistente de la BD (VACUUM INTO desde una conexión de solo lectura): el servidor trabaja sobre la copia. */
function copiarBd(destino: string): void {
  const origen = new DatabaseSync(ORIGEN_BD, { readOnly: true });
  try { origen.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`); } catch { copyFileSync(ORIGEN_BD, destino); } finally { origen.close(); }
}

async function esperarServidor(servidor: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (servidor.exitCode !== null) throw new Error(`El servidor se cerró (código ${servidor.exitCode})`);
    try { if ((await fetch(`${BASE}/api/salud`)).ok) return; } catch { /* aún no escucha */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('El servidor no arrancó en 20 s');
}

const tmp = mkdtempSync(join(tmpdir(), 'radar-capturas-'));
let servidor: ChildProcess | null = null;
const parar = () => { if (servidor && servidor.exitCode === null) servidor.kill('SIGTERM'); };
process.on('SIGINT', () => { parar(); process.exit(130); });
process.on('SIGTERM', () => { parar(); process.exit(143); });

try {
  mkdirSync(SALIDA, { recursive: true });
  const bd = join(tmp, 'radar.sqlite');
  copiarBd(bd);
  servidor = spawn(process.execPath, ['src/server.ts'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PUERTO), HOST: '127.0.0.1', DB_PATH: bd, TEAM_PASSWORD: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await esperarServidor(servidor);

  // Una ficha abierta y analizada: la primera de "para preparar".
  const semana = await (await fetch(`${BASE}/api/semana`)).json() as { paraPreparar: string[] };
  const abierta = semana.paraPreparar[0];
  const fichas: [string, string][] = [['ficha-cerrada', 'bdns:904719'], ...(abierta ? [['ficha-abierta', abierta] as [string, string]] : [])];

  const navegador = await chromium.launch({ executablePath: chromiumPath() });
  try {
    for (const v of VISTAS) {
      const pagina = await (await navegador.newContext({ viewport: { width: v.ancho, height: v.alto }, locale: 'es-ES', timezoneId: 'Europe/Madrid' })).newPage();
      const foto = async (ruta: string, nombre: string, antes?: () => Promise<void>, completa = true) => {
        await pagina.goto(`${BASE}${ruta}`, { waitUntil: 'networkidle' });
        await pagina.waitForSelector('main h1');
        await pagina.waitForFunction(() => !document.querySelector('main')?.textContent?.includes('Cargando…'));
        await antes?.();
        const fichero = join(SALIDA, `${nombre}-${v.nombre}.png`);
        await pagina.screenshot({ path: fichero, fullPage: completa });
        console.log(fichero);
      };
      await foto('/', 'esta-semana');
      for (const [nombre, id] of fichas) await foto(`/convocatoria/${encodeURIComponent(id)}`, nombre);
      await foto('/empresas', 'empresas', async () => {
        await pagina.locator('tbody button[aria-expanded]').first().click();
        await pagina.waitForSelector('tbody blockquote');
      });
      await foto('/perfil', 'perfil');
      await foto('/como-sabemos', 'como-sabemos');
      await pagina.context().close();
    }
  } finally {
    await navegador.close();
  }
} finally {
  parar();
  rmSync(tmp, { recursive: true, force: true });
}
