// Correo del lunes en el seam del motor: emisor falso, BD en memoria con convocatorias y plazos a mano, reloj fijo (viernes 13/11/2026).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { semanaIso } from '../src/dates.ts';
import { decidir } from '../src/db/decisiones.ts';
import { guardarConvocatoria, guardarFase, guardarPlazo } from '../src/db/repo.ts';
import { enviarResumen, prepararResumen } from '../src/engine.ts';
import { crearEmisorResend, type CorreoSaliente, type Emisor } from '../src/mailer.ts';
import { leerConfigPuntuacion } from '../src/puntuacion.ts';
import { acortar, componerCorreo, textoImporte } from '../src/correo.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, RUTA_PUNTUACION, relojFijo, darPorCribadas } from './support/bd.ts';

const AHORA = new Date('2026-11-16T08:00:00Z'); // lunes 16/11/2026, semana ISO 2026-W47
const puntuacion = leerConfigPuntuacion(RUTA_PUNTUACION);
const CFG = { destinatarios: ['ana@ejemplo.org', 'luis@ejemplo.org'], remitente: 'Radar Reforesta <no-reply@out.ruralhackers.com>', urlPublica: 'https://radar.example.org/' };

function conv(n: string, titulo: string): Convocatoria {
  return {
    id: `bdns:${n}`, fuente: 'bdns', fuenteId: n, titulo, organo: { nivel1: 'ESTADO', nivel2: 'MINISTERIO X', nivel3: null },
    fechaPublicacion: '2026-11-14', url: `https://example.org/${n}`, tipo: null, finalidad: null, regiones: [], abierto: null, datos: {}, ...{},
  };
}

/** Guarda la convocatoria con su plazo y un análisis con `lineas` líneas de encaje (más líneas = más puntuación). */
function alta(db: DatabaseSync, n: string, titulo: string, cierre: string | null, lineas: number, importe = '50.000 euros') {
  guardarConvocatoria(db, { convocatoria: conv(n, titulo), descarte: null }, AHORA);
  guardarPlazo(db, `bdns:${n}`, { fechaCierre: cierre, tipo: cierre ? 'literal' : 'desconocida', textoOriginal: null, fechaBase: null, baseOrigen: null, aproximada: false, detalle: 't' }, AHORA);
  const campo = (valor: string) => ({ valor, cita: valor, documento: 'Bases' });
  guardarFase(db, {
    convocatoriaId: `bdns:${n}`, fase: 'analisis', descarta: false, motivo: null,
    datos: {
      analisis: {
        elegibilidadEsfl: campo('si'), importeMaximoProyecto: campo(importe), importeTotal: campo(''), plazo: campo(''), cofinanciacion: campo('sin cofinanciación'),
        requisitos: [], lineas: Array.from({ length: lineas }, (_, i) => ({ linea: `Línea ${i}`, motivo: 'encaja', cita: '', documento: '' })), ideaProyecto: null, correcciones: [],
      },
    },
  }, AHORA);
}

function escenario() {
  const db = bdSembrada();
  alta(db, '1', 'Ayudas a la restauración forestal', '2027-02-15', 3); // la mejor
  alta(db, '2', 'Subvención de educación ambiental', '2027-03-01', 2);
  alta(db, '3', 'Premio de agroecología', '2027-04-10', 2);
  alta(db, '4', 'Ayudas a la custodia del territorio', '2026-11-30', 0); // cierra pronto, poca puntuación
  alta(db, '5', 'Bonificación de proyectos rurales', '2027-05-01', 1);
  alta(db, '6', 'Programa de huertos urbanos', '2027-06-01', 1);
  alta(db, '7', 'Convocatoria de voluntariado verde', '2026-11-25', 0); // cierra pronto, sin encaje
  darPorCribadas(db);
  return db;
}

function emisorFalso() {
  const enviados: CorreoSaliente[] = [];
  const emisor: Emisor = { async enviar(c) { enviados.push(c); return { id: `res_${enviados.length}` }; } };
  return { enviados, emisor };
}

const deps = (db: DatabaseSync, emisor: Emisor | null, extra: object = {}) => ({ db, reloj: { now: () => AHORA }, emisor, config: CFG, puntuacion, ...extra });

describe('correo del lunes', () => {
  test('contenido: destacadas por puntuación, cierran pronto (sin repetir), enlaces con la URL pública, destinatarios y remitente', async () => {
    const db = escenario();
    const { enviados, emisor } = emisorFalso();
    const r = await enviarResumen(deps(db, emisor));
    assert.equal(r.estado, 'enviado');
    assert.equal(enviados.length, 1);
    const c = enviados[0];
    assert.deepEqual(c.para, CFG.destinatarios);
    assert.equal(c.de, CFG.remitente);
    assert.equal(c.asunto, 'Radar Reforesta · semana del 16 nov: 7 convocatorias, 2 cierran pronto');

    // Destacadas: las 5 mejores; las dos que cierran pronto (puntuan peor) van en su sección.
    const destacadas = c.texto.slice(c.texto.indexOf('DESTACADAS'), c.texto.indexOf('CIERRAN PRONTO'));
    for (const t of ['restauración forestal', 'educación ambiental', 'agroecología']) assert.match(destacadas, new RegExp(t));
    assert.ok(destacadas.indexOf('restauración forestal') < destacadas.indexOf('educación ambiental'), 'por puntuación');
    assert.ok(!destacadas.includes('voluntariado verde'));
    const cierran = c.texto.slice(c.texto.indexOf('CIERRAN PRONTO'));
    assert.ok(cierran.indexOf('voluntariado verde') < cierran.indexOf('custodia del territorio'), 'por fecha de cierre (25/11 antes que 30/11)');
    assert.match(cierran, /Cierra el 25 nov \(en 9 días\)/);
    assert.match(destacadas, /Hasta 50\.000 euros por proyecto · Cierra el 15 feb/);
    assert.match(destacadas, /Encaja con/, 'el porqué sale de la puntuación');

    // Enlaces a la ficha con la URL pública (sin doble barra) en HTML y texto
    assert.ok(c.texto.includes('https://radar.example.org/convocatoria/bdns%3A1'));
    assert.ok(c.html.includes('href="https://radar.example.org/convocatoria/bdns%3A7"'));
    assert.match(c.html, /No respondas a este correo/);
    assert.match(c.texto, /No respondas a este correo/);
    assert.ok(!/<img/i.test(c.html));
    // Registro del envío
    const fila = db.prepare('SELECT * FROM envios_resumen').get() as { semana: string; destinatarios: number; convocatorias: string; proveedor_id: string; error: string | null };
    assert.deepEqual([fila.semana, fila.destinatarios, fila.proveedor_id, fila.error], ['2026-W47', 2, 'res_1', null]);
    assert.equal(JSON.parse(fila.convocatorias).length, 7);
    db.close();
  });

  test('sin destinatarios no se llama al emisor ni se registra nada', async () => {
    const db = escenario();
    const { enviados, emisor } = emisorFalso();
    const r = await enviarResumen(deps(db, emisor, { config: { ...CFG, destinatarios: [] } }));
    assert.equal(r.estado, 'sin_destinatarios');
    assert.equal(enviados.length, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM envios_resumen').get() as { n: number }).n, 0);
    // Sin destinatarios tampoco hace falta emisor
    assert.equal((await enviarResumen(deps(db, null, { config: { ...CFG, destinatarios: [] } }))).estado, 'sin_destinatarios');
    db.close();
  });

  test('con destinatarios y sin emisor (falta la clave) es un error claro', async () => {
    const db = escenario();
    await assert.rejects(enviarResumen(deps(db, null)), /falta RESEND_API_KEY/);
    db.close();
  });

  test('sin RADAR_URL_PUBLICA: el envío se niega con un mensaje claro y la vista previa usa enlaces relativos', async () => {
    const db = escenario();
    const { enviados, emisor } = emisorFalso();
    await assert.rejects(enviarResumen(deps(db, emisor, { config: { ...CFG, urlPublica: null } })), /falta RADAR_URL_PUBLICA/);
    assert.equal(enviados.length, 0);
    const { correo } = prepararResumen({ db, reloj: { now: () => AHORA } }, { urlPublica: null });
    assert.match(correo.html, /href="\/convocatoria\/bdns%3A/);
    assert.ok(!correo.html.includes('ruralhackers.com/convocatoria'));
    db.close();
  });

  test('las descartadas por el equipo no aparecen', async () => {
    const db = escenario();
    decidir(db, 'bdns:1', { decision: 'descartada', motivo: 'Ya presentada' }, AHORA);
    const { enviados, emisor } = emisorFalso();
    await enviarResumen(deps(db, emisor));
    assert.ok(!enviados[0].texto.includes('restauración forestal'));
    assert.ok(!enviados[0].html.includes('bdns%3A1"'));
    assert.match(enviados[0].asunto, /6 convocatorias/);
    db.close();
  });

  test('"las ganan organizaciones como vosotros": solo las que no salen ya arriba', async () => {
    const db = escenario();
    alta(db, '8', 'Taller de sostenibilidad rural', '2027-07-01', 0); // puntúa menos que las 5 destacadas
    darPorCribadas(db);
    for (const n of ['1', '8']) {
      db.prepare("INSERT INTO origenes_convocatoria (convocatoria_id, origen, nif, nombre, numero_previo, anio_previo) VALUES (?, 'parecidas', 'G11111111', 'Otra ONG', '1', 2025)").run(`bdns:${n}`);
    }
    const { enviados, emisor } = emisorFalso();
    await enviarResumen(deps(db, emisor));
    const t = enviados[0].texto;
    const parecidas = t.slice(t.indexOf('LAS GANAN ORGANIZACIONES COMO VOSOTROS'));
    assert.match(parecidas, /Taller de sostenibilidad rural/);
    assert.ok(!parecidas.includes('restauración forestal'), 'la 1 ya salió en destacadas');
    db.close();
  });

  test('idempotente por semana ISO: repetir no envía salvo --forzar; otra semana sí; un envío fallido se puede reintentar', async () => {
    const db = escenario();
    const rj = relojFijo(AHORA);
    const { enviados, emisor } = emisorFalso();
    const d = { ...deps(db, emisor), reloj: rj };
    assert.equal((await enviarResumen(d)).estado, 'enviado');
    rj.adelantar(2 * 86_400_000); // miércoles de la misma semana
    assert.equal((await enviarResumen(d)).estado, 'ya_enviado');
    assert.equal(enviados.length, 1);
    assert.equal((await enviarResumen(d, { forzar: true })).estado, 'enviado');
    assert.equal(enviados.length, 2);
    rj.adelantar(7 * 86_400_000); // semana siguiente
    assert.equal((await enviarResumen(d)).estado, 'enviado');
    assert.equal(enviados.length, 3);

    const db2 = escenario();
    let falla = true;
    const roto: Emisor = { async enviar() { if (falla) throw new Error('Resend respondió 403: dominio sin verificar'); return { id: 'ok' }; } };
    await assert.rejects(enviarResumen(deps(db2, roto)), /403/);
    const fila = db2.prepare('SELECT error, proveedor_id FROM envios_resumen').get() as { error: string; proveedor_id: string | null };
    assert.match(fila.error, /dominio sin verificar/);
    falla = false;
    assert.equal((await enviarResumen(deps(db2, roto))).estado, 'enviado', 'el fallo no cuenta como enviado');
    db.close(); db2.close();
  });

  test('punto de extensión: las secciones extra se añaden al final', async () => {
    const db = escenario();
    const { enviados, emisor } = emisorFalso();
    await enviarResumen(deps(db, emisor, {
      seccionesExtra: ({ urlPublica }: { urlPublica: string }) => [{ titulo: 'Empresas nuevas de la semana', items: [{ titulo: 'Acme SL', url: `${urlPublica}/empresas/1`, detalles: ['Sector forestal'] }] }],
    }));
    assert.match(enviados[0].texto, /EMPRESAS NUEVAS DE LA SEMANA[\s\S]*Acme SL/);
    assert.ok(enviados[0].html.includes('Empresas nuevas de la semana'));
    db.close();
  });

  test('sin nada que contar no se envía', async () => {
    const db = bdSembrada();
    const { enviados, emisor } = emisorFalso();
    assert.equal((await enviarResumen(deps(db, emisor))).estado, 'sin_novedades');
    assert.equal(enviados.length, 0);
    db.close();
  });
});

describe('piezas', () => {
  test('el HTML escapa el texto de las convocatorias', () => {
    const c = componerCorreo({ hoy: '2026-11-16', lunes: '2026-11-16', total: 1, cierranPronto: 0, urlPublica: 'https://x.org', secciones: [{ titulo: 'T', items: [{ titulo: '<script>alert(1)</script> & "co"', url: 'https://x.org/a?b=1&c=2', detalles: [] }] }] });
    assert.ok(!c.html.includes('<script>'));
    assert.ok(c.html.includes('&lt;script&gt;'));
  });
  test('importe: solo la cifra inicial, sin Hasta duplicado; títulos largos cortados en palabra', () => {
    const a = (v: string) => ({ importeMaximoProyecto: { valor: v }, importeTotal: { valor: '' } }) as never;
    assert.equal(textoImporte(a('1.500 euros (límite de la línea de Medio Ambiente, Protección Animal y Gestión de Residuos)')), 'Hasta 1.500 euros por proyecto');
    assert.equal(textoImporte(a('60.000 euros; cofinanciación del 10 %')), 'Hasta 60.000 euros por proyecto');
    assert.equal(textoImporte(a('Hasta 5.000 euros')), 'Hasta 5.000 euros por proyecto');
    assert.equal(textoImporte(a('Máximo 3.000 euros')), 'Máximo 3.000 euros por proyecto');
    // M17: sin cifra en euros no se antepone "Hasta" y la cifra de la aclaración no se pierde; "Entre…" y "Sin límite" no llevan "Hasta".
    assert.equal(textoImporte(a('Hasta el 80 % (máx. 5.000 €)')), 'Hasta el 80 % (5.000 €) por proyecto');
    assert.equal(textoImporte(a('El 80 % del presupuesto')), 'El 80 % del presupuesto por proyecto');
    assert.equal(textoImporte(a('Entre 10.000 y 50.000 euros')), 'Entre 10.000 y 50.000 euros por proyecto');
    assert.equal(textoImporte(a('Sin límite')), 'Sin límite por proyecto');
    const t = acortar('palabra '.repeat(40), 140);
    assert.ok(t.length <= 140 && t.endsWith('palabra...'));
  });
  test('semana ISO', () => {
    assert.equal(semanaIso('2026-11-16'), '2026-W47');
    assert.equal(semanaIso('2026-11-22'), '2026-W47');
    assert.equal(semanaIso('2027-01-01'), '2026-W53');
    assert.equal(semanaIso('2024-12-30'), '2025-W01');
  });
  test('Resend: POST con Bearer y cuerpo correcto; error con el motivo', async () => {
    const llamadas: { url: string; init: RequestInit }[] = [];
    const ok = crearEmisorResend({ apiKey: 're_x', fetch: (async (url: string, init: RequestInit) => { llamadas.push({ url, init }); return new Response('{"id":"abc"}', { status: 200 }); }) as typeof fetch });
    const r = await ok.enviar({ de: 'a <a@b.c>', para: ['x@y.z'], asunto: 'S', html: '<p>h</p>', texto: 't' });
    assert.equal(r.id, 'abc');
    assert.equal(llamadas[0].url, 'https://api.resend.com/emails');
    assert.equal((llamadas[0].init.headers as Record<string, string>).Authorization, 'Bearer re_x');
    assert.deepEqual(JSON.parse(llamadas[0].init.body as string), { from: 'a <a@b.c>', to: ['x@y.z'], subject: 'S', html: '<p>h</p>', text: 't' });
    const mal = crearEmisorResend({ apiKey: 'k', fetch: (async () => new Response('{"message":"domain not verified"}', { status: 403 })) as typeof fetch });
    await assert.rejects(mal.enviar({ de: 'a', para: ['x'], asunto: 's', html: 'h', texto: 't' }), /403.*domain not verified/);
  });
});
