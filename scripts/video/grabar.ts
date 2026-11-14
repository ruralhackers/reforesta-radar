// Vídeo de demo del radar: graba la web REAL ya en marcha (RADAR_URL, por defecto http://localhost:8116) con subtítulos incrustados, sin voz.
// Los subtítulos salen de docs/guion-video.md (mismo texto). Uso: npm run build && npm run video
// Salida: video/radar-reforesta-demo.mp4 (+ .srt) y video/frames/NN-escena.png. Necesita chromium de Playwright y ffmpeg.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';

const BASE = process.env.RADAR_URL ?? 'http://localhost:8116';
const RAIZ = join(import.meta.dirname, '..', '..');
const SALIDA = join(RAIZ, 'video');
const TMP = join(SALIDA, 'tmp');
const CPS = 17; // caracteres por segundo de lectura

function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const raiz = join(homedir(), '.cache', 'ms-playwright');
  for (const d of (existsSync(raiz) ? readdirSync(raiz) : []).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    const r = join(raiz, d, 'chrome-linux64', 'chrome');
    if (existsSync(r)) return r;
  }
  throw new Error('No encuentro chromium: define CHROMIUM_PATH');
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(SALIDA, 'frames'), { recursive: true });
mkdirSync(TMP, { recursive: true });

const navegador = await chromium.launch({ executablePath: chromiumPath() });
try {
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 720 }, locale: 'es-ES', timezoneId: 'Europe/Madrid', recordVideo: { dir: TMP, size: { width: 1280, height: 720 } } });
  const p: Page = await ctx.newPage();
  const t0 = Date.now();
  const ahora = () => (Date.now() - t0) / 1000;
  const cues: { ini: number; fin: number; texto: string }[] = [];
  const escenas: { nombre: string; ini: number; fin: number }[] = [];
  let escenaActual: { nombre: string; ini: number; fin: number } | null = null;
  const escena = (nombre: string) => { if (escenaActual) escenaActual.fin = ahora(); escenaActual = { nombre, ini: ahora(), fin: ahora() }; escenas.push(escenaActual); };

  const mostrar = (texto: string | null) => p.evaluate((t) => {
    let d = document.getElementById('__sub');
    if (!t) { d?.remove(); return; }
    if (!d) {
      d = document.createElement('div'); d.id = '__sub';
      d.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:1040px;width:max-content;box-sizing:border-box;padding:10px 22px;background:rgba(0,0,0,.74);color:#fff;font:600 29px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;border-radius:10px;z-index:2147483647;pointer-events:none';
      document.documentElement.appendChild(d);
    }
    d.textContent = t;
  }, texto);

  /** Subtítulo: lo enseña el tiempo de lectura (mín. 2,5 s) y mientras tanto ejecuta la acción. */
  const habla = async (texto: string, accion?: () => Promise<void>) => {
    if (texto.length > 120) throw new Error(`Subtítulo demasiado largo: ${texto}`);
    const dur = Math.max(2500, (texto.length / CPS) * 1000) + 200;
    const ini = ahora();
    const t = Date.now();
    await mostrar(texto);
    if (accion) await accion();
    const resto = dur - (Date.now() - t);
    if (resto > 0) await dormir(resto);
    cues.push({ ini, fin: ahora(), texto });
  };

  const resaltar = async (loc: Locator, ms = 2200) => {
    await loc.evaluate((e, d) => {
      const el = e as HTMLElement; const antes = [el.style.outline, el.style.outlineOffset, el.style.borderRadius];
      el.style.outline = '4px solid #f5a300'; el.style.outlineOffset = '4px'; if (!el.style.borderRadius) el.style.borderRadius = '8px';
      setTimeout(() => { el.style.outline = antes[0]; el.style.outlineOffset = antes[1]; el.style.borderRadius = antes[2]; }, d);
    }, ms);
  };
  const scrollA = async (y: number, ms = 1400) => p.evaluate(async ({ to, dur }) => {
    const el = document.scrollingElement!; const from = el.scrollTop; const ini = performance.now();
    await new Promise<void>((res) => { const f = (t: number) => { const k = Math.min(1, (t - ini) / dur); const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; el.scrollTop = from + (to - from) * e; if (k < 1) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  }, { to: y, dur: ms });
  const hasta = async (loc: Locator, ms = 1400, margen = 110) => scrollA(Math.max(0, (await loc.evaluate((e) => e.getBoundingClientRect().top + document.scrollingElement!.scrollTop)) - margen), ms);
  /** Resalta y lleva a la vista un elemento (si ya se ve, no se desplaza). */
  const enfocar = async (loc: Locator, margen = 110) => { await loc.first().waitFor(); await hasta(loc.first(), 1200, margen); await resaltar(loc.first()); };
  const ir = async (ruta: string) => {
    await mostrar(null);
    await p.goto(`${BASE}${ruta}`, { waitUntil: 'networkidle' });
    await p.waitForSelector('main h1, h1');
    await p.waitForFunction(() => !document.querySelector('main')?.textContent?.includes('Cargando…'));
    await dormir(500);
  };
  const tarjeta = (loc: Locator) => loc.locator('xpath=ancestor::*[.//button[contains(.,"Nos interesa")]][1]');
  const panel = (loc: Locator) => loc.locator('xpath=..');

  const VERDE = '#1f6b3a';
  const carta = async (html: string) => {
    await p.setContent(`<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f3d22,${VERDE});color:#fff;font-family:system-ui,-apple-system,sans-serif;text-align:center"><div style="max-width:1000px;padding:0 40px">${html}</div></body>`);
  };

  // 1. Título y problema
  escena('01-titulo');
  await carta(`<div style="font-size:84px;font-weight:800;letter-spacing:-1px">Radar para Reforesta</div>
    <div style="font-size:34px;margin:26px 0 44px;opacity:.9">Encuentra convocatorias y empresas que pueden financiar su trabajo</div>
    <div style="display:flex;gap:28px;justify-content:center;font-size:30px">
      <div style="background:rgba(255,255,255,.14);padding:18px 26px;border-radius:14px">6–7 personas<br>4–5 solicitudes al año</div>
      <div style="background:rgba(255,255,255,.14);padding:18px 26px;border-radius:14px">~90 % financiación privada<br>empresas (RSC) a cero</div></div>`);
  await dormir(2000);
  await habla('Reforesta son 6 o 7 personas y presentan 4 o 5 solicitudes al año.');
  await habla('Cerca del 90 % de su financiación es privada, y la de empresas (RSC) está a cero.');
  await habla('Radar para Reforesta busca por ellos: convocatorias y empresas, con su porqué.');

  // 2. Esta semana
  escena('02-esta-semana');
  await ir('/');
  await habla('Esta semana: 2 convocatorias para preparar. 1 cierra en menos de 3 semanas.', () => enfocar(p.getByText(/cierra en menos de 3 semanas/), 200));
  await habla('El Boalo: un ayuntamiento que financia sensibilización ambiental. 21.500 € en total; cierra el 30 de noviembre.', () => enfocar(tarjeta(p.getByRole('link', { name: /El Boalo/ }).first()), 160));
  await habla('Fundación Endesa: hasta 45.000 euros por proyecto para restauración de ecosistemas.', () => enfocar(tarjeta(p.getByRole('link', { name: /Endesa/ }).first()), 160));
  await habla('Aparte queda 1 con menos encaje: el radar no esconde lo que ha visto.', async () => {
    const s = p.locator('summary', { hasText: /con menos encaje/ }); await hasta(s, 1000, 300); await s.click(); await resaltar(s);
  });
  await habla('Y 8 convocatorias de la UE, solo para entrar como socio de un consorcio.', async () => {
    const s = p.locator('summary', { hasText: /UE · como socio/ }); await hasta(s, 1000, 300); await s.click(); await resaltar(s);
  });

  // 3. Ficha de El Boalo
  escena('03-ficha-el-boalo');
  await ir('/convocatoria/bdns%3A940783');
  await habla('La ficha de El Boalo. Cada dato lleva su cita literal del documento.', () => enfocar(p.getByText(/veinte y un mil quinientos euros/), 200));
  await habla('¿Podemos pedirla? Sí: admite entidades sin ánimo de lucro, con la cita que lo dice.', () => enfocar(panel(p.getByText(/podemos pedirla/i).first()), 90));
  await habla('Lo que no consta, como la cofinanciación, se marca como desconocido: nunca se inventa.', () => enfocar(panel(p.getByText(/^cofinanciaci/i).first()), 90));
  await habla('Y propone una idea de proyecto: sensibilización ambiental en El Boalo, Cerceda y Mataelpino.', () => enfocar(panel(p.getByText('Idea de proyecto').first()), 90));

  // 4. CAM 2026
  escena('04-cam-2026');
  await ir('/convocatoria/bdns%3A904719');
  await dormir(1200);
  await habla('Hasta 30.000 euros por proyecto, con la cita literal de las bases.', () => enfocar(p.getByText(/límites máximos de 60\.000/), 200));
  await habla('Está cerrada desde el 8 de junio de 2026, y la ficha lo dice.', () => enfocar(p.getByText(/Cerrada el 8 jun 2026/), 200));
  await habla('Reforesta la ganó en 2025 con 29.378,15 €, en 2024 con 29.076,85 € y en 2022 con 50.532,31 €.', () => enfocar(p.getByText(/Reforesta ganó las ediciones/), 200));
  await habla('Así la encontró el radar: otras 22 organizaciones parecidas ganaron una edición anterior.', () => enfocar(p.getByText(/La hemos encontrado porque/), 200));

  // 5. Descartada: Usera
  escena('05-descartada-usera');
  await ir('/convocatoria/bdns%3A941026');
  await habla('También enseña lo que descarta. Esta ayuda de Usera parece buena: hasta 5.000 euros.', () => enfocar(p.getByText(/podrá superar la cuantía de 5\.000/), 200));
  await habla('¿Podemos pedirla? No: exige sede social en Usera, y la entidad está en Tres Cantos.', () => enfocar(panel(p.getByText(/podemos pedirla/i).first()), 90));
  await habla('Descartada en el análisis, con la cita literal que lo demuestra.', () => enfocar(p.getByText(/Descartada en el análisis/), 200));

  // 6. Empresas
  escena('06-empresas');
  await ir('/empresas');
  await habla('Empresas: primero las que una declaración de impacto ambiental del BOE obliga a restaurar o compensar.', () => enfocar(p.getByRole('heading', { name: /Obligadas por una DIA/ }), 120));
  await habla('Seis, como Red Eléctrica, BRUC Las Quinientas o Sistemas Energéticos Barandón.', async () => {
    for (const n of ['Red Eléctrica', 'BRUC', 'Barandón']) { await resaltar(p.locator('tbody tr', { hasText: n }).first(), 1300); await dormir(1300); }
  });
  await habla('Al abrir una fila aparece la cita del BOE que lo dice.', async () => {
    const fila = p.locator('tbody tr', { hasText: 'Red Eléctrica' }).first();
    await fila.locator('button[aria-expanded]').click(); await p.waitForSelector('tbody blockquote');
    await hasta(fila, 1000, 100); await resaltar(p.locator('tbody blockquote').first(), 2500);
  });
  await habla('Después, 192 empresas que ya compensan su huella de carbono en el registro del MITECO.', () => enfocar(p.getByRole('heading', { name: /Compensan su huella/ }), 120));

  // 7. Cómo sabemos
  escena('07-como-sabemos');
  await ir('/como-sabemos');
  await habla('De 6 convocatorias conocidas, el radar habría detectado las 6.', () => enfocar(p.locator('p', { hasText: /habría detectado 6/ }), 160));
  await habla('Y de 25 que ganaron organizaciones parecidas, 23 pasan la criba (92 %).', () => enfocar(p.locator('p', { hasText: /23 \(92 %\)/ }), 160));
  await habla('Con una advertencia en la propia página: son pocas, y no es una precisión.', async () => { await scrollA(0, 600); await resaltar(p.locator('p', { hasText: /^Límites/ }).first(), 3000); });

  // 8. Correo del lunes
  escena('08-correo');
  await mostrar(null);
  await p.goto(`file://${join(RAIZ, 'data', 'digest-preview.html')}`, { waitUntil: 'load' });
  await dormir(500);
  await habla('Cada lunes, un correo corto: las destacadas de la semana, con su porqué y su cierre.', async () => { await scrollA(0, 300); await scrollA(220, 2200); });
  await habla('Y las empresas nuevas más claras, cada una con su enlace al BOE.', async () => { await p.evaluate(() => { const e = [...document.querySelectorAll('*')].find((x) => /empresas nuevas/i.test(x.childNodes[0]?.textContent ?? '') && x.children.length < 3); e?.scrollIntoView({ block: 'start' }); }); await scrollA((await p.evaluate(() => document.scrollingElement!.scrollTop)) + 80, 1800); });

  // 9. Cierre
  escena('09-cierre');
  await mostrar(null);
  await carta(`<div style="font-size:64px;font-weight:800">Radar para Reforesta</div>
    <div style="font-size:30px;margin:34px 0 10px">Código: <b>github.com/ruralhackers/reforesta-radar</b></div>
    <div style="font-size:30px;margin-bottom:44px">Demo: <b>radar-reforesta.ruralhackers.com</b></div>
    <div style="font-size:26px;opacity:.88">Hecho por Rural Hackers para Common Seeds · 1hack A Coruña</div>`);
  await dormir(6500);
  escenaActual!.fin = ahora();
  await p.close(); await ctx.close();

  // Vídeo: webm → MP4 (H.264, yuv420p, 30 fps, faststart)
  const webm = readdirSync(TMP).find((f) => f.endsWith('.webm'))!;
  const mp4 = join(SALIDA, 'radar-reforesta-demo.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(TMP, webm), '-r', '30', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  const ts = (s: number) => { const ms = Math.round(s * 1000); const f = (n: number, w = 2) => String(n).padStart(w, '0'); return `${f(Math.floor(ms / 3600000))}:${f(Math.floor(ms / 60000) % 60)}:${f(Math.floor(ms / 1000) % 60)},${f(ms % 1000, 3)}`; };
  writeFileSync(join(SALIDA, 'radar-reforesta-demo.srt'), cues.map((c, i) => `${i + 1}\n${ts(c.ini)} --> ${ts(c.fin)}\n${c.texto}\n`).join('\n'));
  for (const e of escenas) {
    const t = e.ini + Math.min(7, (e.fin - e.ini) * 0.6);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', mp4, '-frames:v', '1', join(SALIDA, 'frames', `${e.nombre}.png`)]);
  }
  rmSync(TMP, { recursive: true, force: true });
  console.log(`${mp4} (${ahora().toFixed(1)} s)`);
} finally {
  await navegador.close();
}
