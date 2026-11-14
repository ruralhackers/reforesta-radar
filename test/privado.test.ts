// Modo privado (TEAM_PASSWORD): sin variable todo abierto; con ella, lo privado da 401 sin cookie y funciona con ella.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crearApi } from '../src/api/app.ts';
import { guardarConvocatoria } from '../src/db/repo.ts';
import { actualizarEmpresa, registrarSenal } from '../src/db/empresas.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada } from './support/bd.ts';

const AHORA = new Date('2026-11-13T10:00:00Z');
const reloj = { now: () => AHORA };
const conv: Convocatoria = {
  id: 'bdns:1', fuente: 'bdns', fuenteId: '1', titulo: 'Convocatoria uno', organo: { nivel1: 'ESTADO', nivel2: 'MINISTERIO X', nivel3: null },
  fechaPublicacion: '2026-11-12', url: 'https://example.org/1', tipo: null, finalidad: null, regiones: [], abierto: null, datos: {},
};
const J = { 'Content-Type': 'application/json' };

function nueva(password: string | null, secret?: string, extra: Record<string, unknown> = {}) {
  const db = bdSembrada();
  guardarConvocatoria(db, { convocatoria: conv, descarte: null }, AHORA);
  return { db, api: crearApi({ db, reloj, equipo: { password, secret, retrasoMs: 0, ...extra } }) };
}
type Api = ReturnType<typeof nueva>['api'];
const entrar = (api: Api, password: string, extra: Record<string, string> = {}) => api.request('/sesion', { method: 'POST', headers: { ...J, ...extra }, body: JSON.stringify({ password }) });
const galleta = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];
const con = (cookie: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as object), Cookie: cookie } });

/** Una petición por cada ruta privada (lecturas y escrituras). */
const PRIVADAS: [string, string, unknown?][] = [
  ['GET', '/equipo/motivos'], ['GET', '/equipo/decisiones'], ['GET', '/equipo/nos-interesa'], ['GET', '/equipo/convocatorias/bdns%3A1'],
  ['PUT', '/decisiones/bdns%3A1', { decision: 'nos_interesa' }], ['DELETE', '/decisiones/bdns%3A1'],
  ['POST', '/decisiones/bdns%3A1/notas', { texto: 'hola' }], ['DELETE', '/decisiones/bdns%3A1/notas/1'],
  ['PUT', '/perfil', { lineas: [], ambito: {}, importeMinimo: null }],
  ['GET', '/equipo/empresas'], ['PATCH', '/empresas/1', { estado: 'contactada' }],
  ['PATCH', '/parecidas/G78456118', { activa: false }], ['POST', '/parecidas', { nif: 'G78456118' }], ['DELETE', '/parecidas/G78456118'],
];
const pedir = (api: Api, [metodo, ruta, cuerpo]: [string, string, unknown?], cookie?: string) =>
  api.request(ruta, { method: metodo, headers: { ...(cuerpo ? J : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}) });

describe('modo demo (sin TEAM_PASSWORD)', () => {
  for (const password of [null, '']) {
    test(`password ${JSON.stringify(password)}: todo abierto y /sesion lo dice`, async () => {
      const { api } = nueva(password);
      assert.deepEqual(await (await api.request('/sesion')).json(), { modoPrivado: false, autenticado: true });
      for (const r of PRIVADAS) assert.notEqual((await pedir(api, r)).status, 401, `${r[0]} ${r[1]}`);
      assert.equal((await api.request('/decisiones/bdns%3A1', { method: 'PUT', headers: J, body: JSON.stringify({ decision: 'nos_interesa' }) })).status, 200);
    });
  }
});

describe('modo privado (con TEAM_PASSWORD)', () => {
  test('sin cookie: lecturas y escrituras privadas dan 401; con cookie funcionan', async () => {
    const { api } = nueva('abrete-sesamo');
    for (const r of PRIVADAS) assert.equal((await pedir(api, r)).status, 401, `${r[0]} ${r[1]}`);
    const res = await entrar(api, 'abrete-sesamo');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { modoPrivado: true, autenticado: true });
    const cookie = galleta(res);
    assert.match(cookie, /^radar_equipo=/);
    const attrs = res.headers.get('set-cookie')!;
    assert.match(attrs, /HttpOnly/i);
    assert.match(attrs, /SameSite=Lax/i);
    assert.match(attrs, /Max-Age=15552000/);
    assert.doesNotMatch(attrs, /Secure/i);
    assert.equal((await pedir(api, ['PUT', '/decisiones/bdns%3A1', { decision: 'nos_interesa' }], cookie)).status, 200);
    assert.equal((await pedir(api, ['GET', '/equipo/decisiones'], cookie)).status, 200);
    assert.equal((await pedir(api, ['POST', '/decisiones/bdns%3A1/notas', { texto: 'secreto' }], cookie)).status, 201);
    assert.equal((await pedir(api, ['GET', '/equipo/motivos'], cookie)).status, 200);
    assert.notEqual((await pedir(api, ['PATCH', '/parecidas/G78456118', { activa: false }], cookie)).status, 401);
    assert.deepEqual(await (await api.request('/sesion', con(cookie))).json(), { modoPrivado: true, autenticado: true });
    assert.deepEqual(await (await api.request('/sesion')).json(), { modoPrivado: true, autenticado: false });
  });

  test('contraseña incorrecta: 401, sin cookie; cuerpo raro también', async () => {
    const { api } = nueva('abrete-sesamo');
    for (const cuerpo of ['{"password":"otra"}', '{}', 'no json', '{"password":5}']) {
      const res = await api.request('/sesion', { method: 'POST', headers: J, body: cuerpo });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('set-cookie'), null);
    }
  });

  test('Secure con https o X-Forwarded-Proto; una cookie manipulada o a medias no vale', async () => {
    const { api } = nueva('abrete-sesamo');
    const res = await entrar(api, 'abrete-sesamo', { 'X-Forwarded-Proto': 'https' });
    assert.match(res.headers.get('set-cookie')!, /Secure/i);
    const cookie = galleta(res);
    for (const falsa of ['radar_equipo=', 'radar_equipo=1.x', `${cookie}x`, `radar_equipo=${Date.now() + 1e9}.${cookie.split('.')[1]}`, `radar_equipo=1.${cookie.split('.')[1]}`]) {
      assert.equal((await pedir(api, ['GET', '/equipo/decisiones'], falsa)).status, 401, falsa);
    }
  });

  test('una cookie de otra contraseña (o de otro SESSION_SECRET) se rechaza', async () => {
    const vieja = galleta(await entrar(nueva('vieja', 's1').api, 'vieja'));
    const { api } = nueva('nueva', 's1');
    assert.equal((await pedir(api, ['GET', '/equipo/decisiones'], vieja)).status, 401);
    const otroSecreto = galleta(await entrar(nueva('misma', 'A').api, 'misma'));
    assert.equal((await pedir(nueva('misma', 'B').api, ['GET', '/equipo/decisiones'], otroSecreto)).status, 401);
    assert.equal((await pedir(nueva('misma', 'A').api, ['GET', '/equipo/decisiones'], otroSecreto)).status, 200);
  });

  test('DELETE /sesion borra la cookie', async () => {
    const { api } = nueva('x');
    const res = await api.request('/sesion', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie')!, /radar_equipo=;/);
  });

  test('las escrituras exigen application/json (defensa CSRF)', async () => {
    const { api } = nueva('x');
    const cookie = galleta(await entrar(api, 'x'));
    const res = await api.request('/decisiones/bdns%3A1', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{"decision":"nos_interesa"}' });
    assert.equal(res.status, 415);
    const login = await api.request('/sesion', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=x' });
    assert.equal(login.status, 415);
  });

  test('límite de intentos por IP (CF-Connecting-IP): tras 10 fallos, 429 incluso con la buena; otra IP no se ve afectada', async () => {
    const { api } = nueva('x');
    const ip = { 'CF-Connecting-IP': '1.2.3.4' };
    for (let i = 0; i < 10; i++) assert.equal((await entrar(api, 'mal', ip)).status, 401);
    assert.equal((await entrar(api, 'x', ip)).status, 429);
    assert.equal((await entrar(api, 'x', { 'CF-Connecting-IP': '5.6.7.8' })).status, 200);
  });

  test('ráfaga en paralelo: como mucho 10 se evalúan, el resto 429', async () => {
    const { api } = nueva('x');
    const ip = { 'CF-Connecting-IP': '9.9.9.9' };
    const res = await Promise.all(Array.from({ length: 40 }, () => entrar(api, 'mal', ip)));
    assert.equal(res.filter((r) => r.status === 401).length, 10);
    assert.equal(res.filter((r) => r.status === 429).length, 30);
  });

  test('una contraseña correcta libera su reserva (no gasta el cupo)', async () => {
    const { api } = nueva('x');
    const ip = { 'CF-Connecting-IP': '8.8.8.8' };
    for (let i = 0; i < 30; i++) assert.equal((await entrar(api, 'x', ip)).status, 200);
  });

  test('sin bloqueo global: la contraseña buena entra aunque muchas IP hayan fallado', async () => {
    const { api } = nueva('x');
    for (let i = 0; i < 30; i++) for (let j = 0; j < 10; j++) await entrar(api, 'mal', { 'CF-Connecting-IP': `10.0.${i}.1` });
    assert.equal((await entrar(api, 'x', { 'CF-Connecting-IP': '11.0.0.1' })).status, 200);
  });

  test('origen de la IP: CF-Connecting-IP manda; X-Forwarded-For se ignora salvo confiarXForwardedFor; sin cabecera, un cubo del socket', async () => {
    // Sin confianza: variar X-Forwarded-For no esquiva el límite.
    const a = nueva('x').api;
    for (let i = 0; i < 10; i++) await entrar(a, 'mal', { 'X-Forwarded-For': `1.1.1.${i}` });
    assert.equal((await entrar(a, 'mal', { 'X-Forwarded-For': '2.2.2.2' })).status, 429);
    // CF-Connecting-IP gana sobre X-Forwarded-For aunque se confíe en él.
    const b = nueva('x', undefined, { confiarXForwardedFor: true }).api;
    for (let i = 0; i < 10; i++) await entrar(b, 'mal', { 'CF-Connecting-IP': '3.3.3.3', 'X-Forwarded-For': `1.1.1.${i}` });
    assert.equal((await entrar(b, 'mal', { 'CF-Connecting-IP': '3.3.3.3', 'X-Forwarded-For': '4.4.4.4' })).status, 429);
    // Con confianza y sin CF: X-Forwarded-For (último salto) separa clientes.
    const c = nueva('x', undefined, { confiarXForwardedFor: true }).api;
    for (let i = 0; i < 10; i++) await entrar(c, 'mal', { 'X-Forwarded-For': '9.9.9.9, 5.5.5.5' });
    assert.equal((await entrar(c, 'x', { 'X-Forwarded-For': '8.8.8.8, 5.5.5.5' })).status, 429);
    assert.equal((await entrar(c, 'x', { 'X-Forwarded-For': '8.8.8.8, 6.6.6.6' })).status, 200);
  });

  test('lo público sigue abierto y no filtra decisiones ni notas', async () => {
    const { api } = nueva('x');
    const cookie = galleta(await entrar(api, 'x'));
    await pedir(api, ['PUT', '/decisiones/bdns%3A1', { decision: 'nos_interesa' }], cookie);
    await pedir(api, ['POST', '/decisiones/bdns%3A1/notas', { texto: 'NOTA-SECRETA' }], cookie);
    for (const ruta of ['/semana', '/convocatorias/bdns%3A1', '/perfil', '/parecidas', '/descartes', '/ejecuciones', '/salud']) {
      const res = await api.request(ruta);
      assert.equal(res.status, 200, ruta);
      const texto = await res.text();
      assert.doesNotMatch(texto, /NOTA-SECRETA|nos_interesa|decisi[oó]n/, ruta);
    }
    assert.equal((await (await api.request('/convocatorias/bdns%3A1')).json() as { id: string }).id, 'bdns:1');
    // Descartada por el equipo: oculta en /semana para todos, también sin sesión (ruling R9).
    await pedir(api, ['PUT', '/decisiones/bdns%3A1', { decision: 'descartada', motivo: 'Otro', detalle: 'no' }], cookie);
    const semana = await (await api.request('/semana')).json() as { convocatorias: { id: string }[] };
    assert.equal(semana.convocatorias.some((c) => c.id === 'bdns:1'), false);
  });
});

describe('estado de las empresas (trabajo del equipo)', () => {
  function conEmpresa(password: string | null) {
    const r = nueva(password);
    const { empresaId: id } = registrarSenal(r.db, {
      nombre: 'Eólica Ejemplo SL', cif: null, origen: 'dia_boe', motivo: 'Obligada a compensar', cita: 'cita literal de ejemplo', provincia: 'Soria',
      senal: { boeId: 'BOE-A-2026-1', titulo: 'Resolución', proyecto: 'Parque', provincia: 'Soria', medidas: [{ tipo: 'compensacion_habitat', cita: 'cita literal de ejemplo' }], enlace: 'https://www.boe.es/x', fechaPublicacion: '2026-11-01' },
    }, AHORA);
    actualizarEmpresa(r.db, id, { estado: 'contactada' }, AHORA);
    return r;
  }
  type Lista = { empresas: Record<string, unknown>[] };

  test('modo privado: la lectura pública no lleva el estado y ?estado= es del equipo (401); con sesión, /equipo/empresas sí', async () => {
    const { api } = conEmpresa('abrete-sesamo');
    const publica = (await (await api.request('/empresas')).json()) as Lista;
    assert.equal(publica.empresas.length, 1);
    assert.equal('estado' in publica.empresas[0], false);
    assert.equal((await api.request('/empresas?estado=contactada')).status, 401);
    assert.equal((await api.request('/empresas?estado=descartada')).status, 401);
    const cookie = galleta(await entrar(api, 'abrete-sesamo'));
    const equipo = (await (await api.request('/equipo/empresas?estado=contactada', con(cookie))).json()) as Lista;
    assert.equal(equipo.empresas[0].estado, 'contactada');
  });

  test('modo demo: todo abierto, el estado se ve y se filtra', async () => {
    const { api } = conEmpresa(null);
    const r = (await (await api.request('/empresas?estado=contactada')).json()) as Lista;
    assert.equal(r.empresas[0].estado, 'contactada');
    assert.equal(((await (await api.request('/empresas?estado=pendiente')).json()) as Lista).empresas.length, 0);
  });
});
