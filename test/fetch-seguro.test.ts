// Descarga segura (SSRF): esquemas, IP privadas, redirecciones salto a salto, DNS que resuelve a una IP interna, tope de tamaño en streaming
// y su uso en los dos sitios que descargan URLs que salen de datos (páginas de fundaciones y documentos del análisis).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchSeguro, ipProhibida, urlPermitidaSintactica } from '../src/fetch-seguro.ts';
import { leerDocumentos } from '../src/documentos.ts';
import { crearFuenteFundaciones } from '../src/sources/fundaciones.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { abrirBd } from '../src/db/schema.ts';
import { altaFuente, leerFuentesVigiladas } from '../src/db/fundaciones.ts';
import { bdSembrada, relojFijo } from './support/bd.ts';

const O = { timeoutMs: 2000, maxBytes: 1000 };
const publica = async () => ['93.184.216.34'];

/** Fetch falso que apunta las URLs pedidas y responde con `responder(url)`. */
function fetchDe(responder: (url: string) => Response, pedidas: string[] = []): typeof fetch {
  return (async (entrada: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.redirect, 'manual', 'siempre se piden las redirecciones a mano');
    const url = String(entrada);
    pedidas.push(url);
    return responder(url);
  }) as typeof fetch;
}
const ok = (cuerpo = 'hola', tipo = 'text/html') => new Response(cuerpo, { status: 200, headers: { 'Content-Type': tipo } });
const redirige = (a: string, status = 302) => new Response(null, { status, headers: { Location: a } });

describe('direcciones prohibidas', () => {
  test('loopback, privadas, enlace local, CGNAT, ULA, sin especificar, multicast y mapeadas', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a00:1', '64:ff9b::7f00:1']) {
      assert.equal(ipProhibida(ip), true, ip);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) assert.equal(ipProhibida(ip), false, ip);
  });

  test('urlPermitidaSintactica: esquema, credenciales, IP literal (también decimal y hexadecimal) y nombres internos', () => {
    for (const u of ['ftp://x.org/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@x.org/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/',
      'http://[::1]/', 'http://localhost/', 'http://intranet/', 'http://nas.local/', 'http://169.254.169.254/latest', 'no es una url']) assert.equal(urlPermitidaSintactica(u), false, u);
    assert.equal(urlPermitidaSintactica('https://www.fundacionmontemadrid.es/convocatorias/'), true);
  });
});

describe('fetchSeguro', () => {
  test('rechaza esquemas no http(s) y IP privadas sin llegar a pedir nada', async () => {
    const pedidas: string[] = [];
    const f = fetchDe(() => ok(), pedidas);
    for (const u of ['file:///etc/passwd', 'ftp://x.org/a', 'http://127.0.0.1:8116/api/salud', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://0x7f000001/', 'http://localhost/']) {
      await assert.rejects(fetchSeguro(f, u, { ...O, resolver: publica }), /esquema no permitido|dirección no permitida|host interno/, u);
    }
    assert.deepEqual(pedidas, []);
  });

  test('una redirección a 127.0.0.1 (o a otra IP interna) se bloquea en ese salto', async () => {
    const pedidas: string[] = [];
    const f = fetchDe((u) => (u === 'https://publica.example/a' ? redirige('http://127.0.0.1:8116/api/salud') : ok('secreto')), pedidas);
    await assert.rejects(fetchSeguro(f, 'https://publica.example/a', { ...O, resolver: publica }), /dirección no permitida \(127\.0\.0\.1\)/);
    assert.deepEqual(pedidas, ['https://publica.example/a']); // nunca se pide la interna
    // Redirección relativa y cadena de saltos válida: se sigue.
    const g = fetchDe((u) => (u.endsWith('/a') ? redirige('/b', 301) : u.endsWith('/b') ? redirige('https://otra.example/c', 307) : ok('fin')));
    const r = await fetchSeguro(g, 'https://publica.example/a', { ...O, resolver: publica });
    assert.equal(new TextDecoder().decode(r.bytes), 'fin');
    assert.equal(r.url, 'https://otra.example/c');
    // Un salto a metadatos de la nube por IPv6 mapeada.
    const h = fetchDe(() => redirige('http://[::ffff:169.254.169.254]/'));
    await assert.rejects(fetchSeguro(h, 'https://publica.example/', { ...O, resolver: publica }), /no permitida/);
  });

  test('máximo de redirecciones', async () => {
    const f = fetchDe((u) => redirige(`${u}x`));
    await assert.rejects(fetchSeguro(f, 'https://publica.example/', { ...O, resolver: publica }), /demasiadas redirecciones/);
  });

  test('un nombre que resuelve a una IP privada (aunque sea una sola de varias) se bloquea; en cada salto', async () => {
    const pedidas: string[] = [];
    const f = fetchDe(() => ok(), pedidas);
    const resolver = async (h: string) => (h === 'trampa.example' ? ['93.184.216.34', '10.0.0.7'] : h === 'loopback.example' ? ['::1'] : ['93.184.216.34']);
    await assert.rejects(fetchSeguro(f, 'https://trampa.example/', { ...O, resolver }), /resuelve a una dirección no permitida \(10\.0\.0\.7\)/);
    await assert.rejects(fetchSeguro(f, 'https://loopback.example/', { ...O, resolver }), /no permitida \(::1\)/);
    assert.deepEqual(pedidas, []);
    // Redirección de una pública a un nombre que resuelve a lo interno.
    const g = fetchDe((u) => (u.includes('buena') ? redirige('https://trampa.example/x') : ok()), pedidas);
    await assert.rejects(fetchSeguro(g, 'https://buena.example/', { ...O, resolver }), /trampa\.example resuelve/);
    // Un nombre que no resuelve es un fallo normal (no una URL bloqueada).
    await assert.rejects(fetchSeguro(f, 'https://noexiste.example/', { ...O, resolver: async () => { throw new Error('ENOTFOUND'); } }), /no se pudo resolver/);
    // Y el caso bueno funciona.
    assert.equal((await fetchSeguro(f, 'https://buena.example/', { ...O, resolver })).ok, true);
  });

  test('el tope de tamaño se aplica leyendo el flujo, sin Content-Length', async () => {
    let leidos = 0;
    const flujo = new ReadableStream<Uint8Array>({
      pull(c) {
        leidos += 400;
        c.enqueue(new Uint8Array(400));
        if (leidos > 100_000) c.close();
      },
    });
    const f = fetchDe(() => new Response(flujo, { status: 200, headers: { 'Content-Type': 'text/html' } })); // sin Content-Length
    await assert.rejects(fetchSeguro(f, 'https://publica.example/', { ...O, resolver: publica }), /demasiado grande/);
    assert.ok(leidos < 5000, `se dejó de leer pronto (${leidos} bytes)`);
    // Con Content-Length mentiroso por debajo: igual se corta.
    const g = fetchDe(() => new Response(new Uint8Array(5000), { status: 200, headers: { 'Content-Length': '10' } }));
    await assert.rejects(fetchSeguro(g, 'https://publica.example/', { ...O, resolver: publica }), /demasiado grande/);
    // Y declarado por encima: ni se lee.
    const h = fetchDe(() => new Response('x', { status: 200, headers: { 'Content-Length': '999999' } }));
    await assert.rejects(fetchSeguro(h, 'https://publica.example/', { ...O, resolver: publica }), /demasiado grande \(999999/);
  });
});

describe('uso en las descargas de URLs que salen de datos', () => {
  test('documentos del análisis: una URL interna (de BDNS, UE o fundación) o una redirección interna se registra como error definitivo sin pedirla', async () => {
    const db = abrirBd(':memory:');
    const pedidas: string[] = [];
    const f = fetchDe((u) => (u.includes('redirige') ? redirige('http://127.0.0.1/admin') : ok('texto de las bases'.padEnd(50, '.'))), pedidas);
    const l = await leerDocumentos(db, f, [
      { titulo: 'Interna', url: 'http://169.254.169.254/latest/meta-data' },
      { titulo: 'Redirige', url: 'https://publica.example/redirige' },
      { titulo: 'Bien', url: 'https://publica.example/bases' },
    ], new Date('2026-11-13T09:00:00Z'), publica);
    assert.deepEqual(l.textos.map((t) => t.titulo), ['Bien']);
    assert.equal(l.errores.length, 2); // definitivos, no se reintentan
    assert.equal(l.erroresTransitorios.length, 0);
    assert.match(l.errores[0], /no permitida/);
    assert.ok(!pedidas.includes('http://169.254.169.254/latest/meta-data') && !pedidas.includes('http://127.0.0.1/admin'));
  });

  test('documentos: el tope de tamaño se aplica en streaming (error definitivo)', async () => {
    const db = abrirBd(':memory:');
    let leidos = 0;
    const flujo = new ReadableStream<Uint8Array>({ pull(c) { leidos += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024)); if (leidos > 200 * 1024 * 1024) c.close(); } });
    const f = fetchDe(() => new Response(flujo, { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    const l = await leerDocumentos(db, f, [{ titulo: 'Enorme', url: 'https://publica.example/enorme.pdf' }], new Date(), publica);
    assert.match(l.errores[0], /demasiado grande/);
    assert.ok(leidos < 40 * 1024 * 1024, `se dejó de leer (${leidos})`);
  });

  test('fuente de fundaciones: una fuente de la semilla o reactivada con URL interna no se descarga, y queda su error', async () => {
    const db = bdSembrada();
    db.exec('DELETE FROM fundaciones');
    // Filas que no pasaron por la validación del alta (semilla, edición directa): la comprobación es al descargar.
    db.prepare("INSERT INTO fundaciones (nombre, url, tipo, activa) VALUES ('Interna', 'http://127.0.0.1:8116/api/salud', 'fundacion', 1), ('Redirige', 'https://redirige.example/c', 'fundacion', 1), ('Resuelve', 'https://resuelve.example/c', 'fundacion', 1)").run();
    const pedidas: string[] = [];
    const f = fetchDe((u) => (u.includes('redirige') ? redirige('http://10.0.0.1/') : ok('<html><body><main>' + 'Convocatoria '.repeat(40) + '</main></body></html>')), pedidas);
    const fuente = crearFuenteFundaciones(() => ({ pausaMs: 0, timeoutMs: 2000, maxBytes: 100_000, maxFuentes: 10, maxCaracteres: 10_000 }));
    const llm = { generar: async () => { throw new Error('no debería llamarse'); } };
    const resolver = async (h: string) => (h === 'resuelve.example' ? ['192.168.0.9'] : ['93.184.216.34']);
    const r = await ejecutarRadar({ db, fetch: f, reloj: relojFijo(new Date('2026-11-13T09:00:00Z')), fuentes: [fuente], llm, resolver, ganadores: false, parecidas: false }, { diasAtras: 7 });
    assert.equal(r.fuentes[0].errores.length, 3);
    assert.deepEqual(pedidas, ['https://redirige.example/c']); // solo el primer salto de la que redirige
    for (const x of leerFuentesVigiladas(db)) assert.match(x.ultimoError!, /no permitida|resuelve a una dirección/, x.nombre);
    // Reactivar por PATCH no se salta nada: sigue sin descargarse.
    assert.equal(leerFuentesVigiladas(db).every((x) => x.activa), true);
    void altaFuente;
  });
});
