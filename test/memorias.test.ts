// Memorias anuales de la entidad, a través del motor: un extracto real de la Memoria 2021 de Reforesta (test/fixtures/memorias, texto extraído del PDF),
// fetch falso que lo sirve, LLM falso que responde como lo haría el modelo (con una cita inventada que el código debe quitar), reloj fijo y BD temporal.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { financiadoresConocidos, proyectosPropios, resumenMemorias } from '../src/db/memorias.ts';
import { leerEmpresas, registrarSenal } from '../src/db/empresas.ts';
import { guardarConvocatoria, guardarFase, leerPerfil } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import { procesarMemorias } from '../src/fases/memorias.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { promptAnalisis, promptCriba } from '../src/llm/prompts.ts';
import { aniosMemorias, enlacesDeMemorias, experienciaDeLaEntidad, textoExperiencia } from '../src/memorias.ts';
import { anadirMemorias, ErrorPerfil, validarPerfilEditable } from '../src/perfil.ts';
import type { Fuente } from '../src/sources/source.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, relojFijo } from './support/bd.ts';

const AHORA = new Date('2026-11-14T09:00:00Z');
const URL_MEMORIA = 'https://reforesta.example/wp-content/uploads/2022/12/Memoria-2021.pdf';
const EXTRACTO = readFileSync(join(import.meta.dirname, 'fixtures', 'memorias', 'memoria-2021-extracto.txt'), 'utf8');
const html = (cuerpo: string) => `<html><body><pre>${cuerpo.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body></html>`;

/** Fetch falso: sirve el extracto (como página, con su texto ya extraído) en la URL de la memoria y la página de memorias; el resto, 404. */
function fetchFalso(opciones: { texto?: () => string; peticiones?: string[]; pagina?: string } = {}): typeof fetch {
  return (async (entrada: string | URL | Request) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    opciones.peticiones?.push(url);
    if (url === URL_MEMORIA) return new Response(html(opciones.texto?.() ?? EXTRACTO), { status: 200, headers: { 'content-type': 'text/html' } });
    if (url === 'https://reforesta.example/quienes-somos/' && opciones.pagina) return new Response(opciones.pagina, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
}

const CITA_CORDEL = 'Este proyecto ejecutado con el apoyo de fundación Montemadrid y CaixaBank finalizó en el último trimestre de 2021.';
const CITA_JARAMA = 'A finales de 2021 se confirmó el apoyo de la Comunidad de Madrid a este proyecto.';

/** La respuesta que daría el modelo leyendo el extracto, con tres trampas: un proyecto con cita inventada, un financiador inventado y una cifra que no está en su cita. */
function respuestaModelo() {
  return {
    anioMemoria: 2021,
    metricas: [
      { nombre: 'Árboles y arbustos plantados', valor: '8.839', cita: '8.839 árboles y arbustos plantados' },
      { nombre: 'Voluntarios', valor: '9.999', cita: '1.338 voluntarios participaron en nuestras jornadas' }, // cifra que no está en su cita
    ],
    proyectos: [
      {
        nombre: 'Restauración de la funcionalidad ecológica de la vía pecuaria Cordel de la Asperilla', anio: 2021, lugar: 'Vereda de las Asperillas', municipio: '', provincia: 'Madrid',
        linea: 'Restauración de ecosistemas', descripcion: 'Riego y mantenimiento de una plantación de especies autóctonas en una vía pecuaria.', socios: [], financiadores: ['fundación Montemadrid', 'CaixaBank'],
        cita: CITA_CORDEL, datos: [{ concepto: 'arboles', etiqueta: 'Ejemplares plantados en 2020', valor: '1.000', cita: 'Labores de riego y mantenimiento de la plantación de 1.000 ejemplares de especies' }],
      },
      {
        nombre: 'Mejora de la conectividad ecológica en la ZEC Cuenca de los Ríos Jarama y Henares', anio: 2021, lugar: 'ZEC Cuenca de los Ríos Jarama y Henares', municipio: '', provincia: 'Madrid',
        linea: 'Conservación y mejora de hábitats', descripcion: 'Plantación y siembra de especies autóctonas en una cañada real.', socios: [], financiadores: ['Comunidad de Madrid'], cita: CITA_JARAMA, datos: [],
      },
      { nombre: 'Proyecto fantasma de la Antártida', anio: 2021, lugar: '', municipio: '', provincia: '', linea: '', descripcion: 'No existe.', socios: [], financiadores: [], cita: 'Plantamos pingüinos en la Antártida con apoyo de Atlantis', datos: [] },
    ],
    financiadores: [
      { nombre: 'fundación Montemadrid', tipo: 'fundacion', relacion: 'financiacion', cita: CITA_CORDEL },
      { nombre: 'CaixaBank', tipo: 'empresa', relacion: 'financiacion', cita: CITA_CORDEL },
      { nombre: 'Comunidad de Madrid', tipo: 'administracion', relacion: 'financiacion', cita: CITA_JARAMA },
      { nombre: 'Fundación Repsol', tipo: 'fundacion', relacion: 'financiacion', cita: 'el programa de Inclusión Social Descubriendo la Sierra de Guadarrama, financiado por la Fundación Repsol' },
      { nombre: 'Metrovacesa', tipo: 'empresa', relacion: 'voluntariado_corporativo', cita: 'Metrovacesa' },
      { nombre: 'Multinacional Inexistente SA', tipo: 'empresa', relacion: 'financiacion', cita: 'Multinacional Inexistente SA aportó un millón' },
    ],
  };
}

function llmFalso(llamadas: PeticionLlm[] = []) {
  const llm: Llm = {
    async generar(p) {
      llamadas.push(p);
      if (p.tarea === 'memorias') return { datos: respuestaModelo(), modelo: p.modelo, uso: { entrada: 12_000, salida: 3000, cacheLectura: 0, cacheEscritura: 0 } };
      const datos = p.tarea === 'criba' ? { decision: 'puede_encajar', motivo: 'Encaja', exigeSedeEnOtraComunidad: 'no_aplica' } : { elegibilidadEsfl: { valor: '', cita: '', documento: '' } };
      return { datos, modelo: p.modelo, uso: { entrada: 1000, salida: 100, cacheLectura: 0, cacheEscritura: 0 } };
    },
  };
  return { llm, llamadas };
}

/** BD sembrada con una sola memoria en la lista (la semilla trae las reales de reforesta.es, que aquí no se piden). */
function bdConMemoria(): DatabaseSync {
  const db = bdSembrada();
  const p = leerPerfil(db)!;
  db.prepare('UPDATE perfil SET datos = ? WHERE id = 1').run(JSON.stringify({ ...p, memorias: [URL_MEMORIA], paginaMemorias: null }));
  return db;
}

const sinFuentes: Fuente[] = [];
const ctx = (db: DatabaseSync, llm: Llm, f: typeof fetch = fetchFalso()) => ({ db, llm, reloj: relojFijo(AHORA), fetch: f, resolver: null });

describe('extracción de memorias', () => {
  test('el motor extrae la memoria pendiente y guarda proyectos y financiadores con cita comprobada; lo inventado se quita', async () => {
    const db = bdConMemoria();
    const { llm, llamadas } = llmFalso();
    const r = await ejecutarRadar({ db, fetch: fetchFalso(), resolver: null, reloj: relojFijo(AHORA), llm, fuentes: sinFuentes, ganadores: false, parecidas: false, memorias: { descubrir: false } });
    assert.equal(llamadas.filter((l) => l.tarea === 'memorias').length, 1);
    assert.equal(r.memorias?.extraidas, 1);
    assert.equal(r.memorias?.proyectos, 2);

    const proyectos = proyectosPropios(db);
    assert.deepEqual(proyectos.map((p) => p.nombre).sort(), [
      'Mejora de la conectividad ecológica en la ZEC Cuenca de los Ríos Jarama y Henares',
      'Restauración de la funcionalidad ecológica de la vía pecuaria Cordel de la Asperilla',
    ]);
    const cordel = proyectos.find((p) => p.nombre.includes('Asperilla'))!;
    assert.equal(cordel.cita, CITA_CORDEL);
    assert.equal(cordel.linea, 'Restauración de ecosistemas');
    assert.deepEqual(cordel.financiadores, ['fundación Montemadrid', 'CaixaBank']);
    assert.deepEqual(cordel.datos.map((d) => [d.concepto, d.valor]), [['arboles', '1.000']]);

    const memoria = resumenMemorias(db)[0];
    assert.equal(memoria.anio, 2021);
    assert.deepEqual(memoria.metricas.map((m) => m.valor), ['8.839']); // la métrica con cifra que no está en su cita se quitó
    assert.equal(memoria.proyectos, 2);
    assert.equal(memoria.financiadores, 5);
    const correcciones = JSON.parse((db.prepare('SELECT correcciones FROM memorias').get() as { correcciones: string }).correcciones) as string[];
    assert.ok(correcciones.some((c) => c.includes('Proyecto fantasma')), 'el proyecto de cita inventada consta como quitado');
    assert.ok(correcciones.some((c) => c.includes('Multinacional Inexistente')));
    assert.ok(correcciones.some((c) => c.includes('9.999') || c.includes('Voluntarios')));
    // Toda cita guardada aparece literal en el texto leído.
    const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
    for (const p of proyectos) assert.ok(norm(EXTRACTO).includes(norm(p.cita)), p.cita);
    assert.ok(r.fases.some((f) => f.fase === 'memorias' && f.costeUsd > 0), 'el coste consta en el registro');
  });

  test('un documento sin cambios no se vuelve a extraer (ni siquiera descargándolo de nuevo); si cambia, se extrae otra vez y sustituye lo anterior', async () => {
    const db = bdConMemoria();
    const { llm, llamadas } = llmFalso();
    const perfil = leerPerfil(db)!;
    let texto = EXTRACTO;
    const f = fetchFalso({ texto: () => texto });
    const memorias = () => llamadas.filter((l) => l.tarea === 'memorias').length;

    assert.equal((await procesarMemorias(ctx(db, llm, f), perfil, 'claude-sonnet-5-5', { descubrir: false })).extraidas, 1);
    assert.equal(memorias(), 1);
    const otra = await procesarMemorias(ctx(db, llm, f), perfil, 'claude-sonnet-5-5', { descubrir: false });
    assert.equal(otra.extraidas, 0);
    assert.equal(otra.sinCambios, 1);
    const refrescada = await procesarMemorias(ctx(db, llm, f), perfil, 'claude-sonnet-5-5', { descubrir: false, refrescar: true }); // descarga de nuevo, mismo hash
    assert.equal(refrescada.sinCambios, 1);
    assert.equal(memorias(), 1);

    texto = `${EXTRACTO}\nNota añadida a la memoria.`;
    const cambiada = await procesarMemorias(ctx(db, llm, f), perfil, 'claude-sonnet-5-5', { descubrir: false, refrescar: true });
    assert.equal(cambiada.extraidas, 1);
    assert.equal(proyectosPropios(db).length, 2, 'la extracción nueva sustituye a la anterior, no se acumula');
  });

  test('si la proyección de coste pasa del tope, no llama al LLM', async () => {
    const db = bdConMemoria();
    const { llm, llamadas } = llmFalso();
    const r = await procesarMemorias(ctx(db, llm), leerPerfil(db)!, 'claude-sonnet-5-5', { descubrir: false, maxProyeccionUsd: 0.0001 });
    assert.equal(llamadas.length, 0);
    assert.match(r.errores[0], /Proyección de coste/);
  });

  test('descubre en la página de la entidad los PDF de memorias que faltan en el perfil y los añade a la lista', async () => {
    const db = bdConMemoria();
    const pagina = `<a href="https://reforesta.example/wp-content/uploads/2024/12/Memoria-2023.pdf">2023</a> <a href="/wp-content/uploads/2022/12/Memoria-2021.pdf">2021</a>
      <a href="/wp-content/uploads/2020/04/Cuentas-2021.pdf">no es memoria</a> <a href="/memoria.html">web</a> <a href="https://otro.example/Memoria-2019.pdf">otra web</a>`;
    assert.deepEqual(enlacesDeMemorias(pagina, 'https://reforesta.example/quienes-somos/'), [
      'https://reforesta.example/wp-content/uploads/2024/12/Memoria-2023.pdf', URL_MEMORIA, 'https://otro.example/Memoria-2019.pdf',
    ]);
    const { llm } = llmFalso();
    const perfil = { ...leerPerfil(db)!, paginaMemorias: 'https://reforesta.example/quienes-somos/' };
    const r = await procesarMemorias(ctx(db, llm, fetchFalso({ pagina })), perfil, 'claude-sonnet-5-5', { maxExtracciones: 0 });
    assert.deepEqual(r.descubiertas, ['https://reforesta.example/wp-content/uploads/2024/12/Memoria-2023.pdf', 'https://otro.example/Memoria-2019.pdf']);
    assert.equal(leerPerfil(db)!.memorias!.length, 3);
  });
});

describe('perfil: lista de memorias editable', () => {
  const base = { lineas: [{ nombre: 'A', descripcion: 'a' }], ambito: { descripcion: 'x', nivelesSiempre: ['ESTADO'], territorios: [{ comunidad: 'Madrid', provincias: [] }], regiones: [] } };
  test('acepta direcciones públicas, quita repetidas y rechaza lo que no es una web pública', () => {
    const v = validarPerfilEditable({ ...base, memorias: [' https://ong.org/m-2024.pdf ', 'https://ong.org/m-2024.pdf', 'https://ong.org/m-2023.pdf'], paginaMemorias: 'https://ong.org/quienes/' });
    assert.deepEqual(v.memorias, ['https://ong.org/m-2024.pdf', 'https://ong.org/m-2023.pdf']);
    assert.equal(v.paginaMemorias, 'https://ong.org/quienes/');
    assert.equal(validarPerfilEditable({ ...base, paginaMemorias: '' }).paginaMemorias, null);
    assert.equal(validarPerfilEditable(base).memorias, undefined); // sin tocar
    for (const mal of [['ftp://x.org/a.pdf'], ['no es una url'], ['http://127.0.0.1/a.pdf'], ['']]) assert.throws(() => validarPerfilEditable({ ...base, memorias: mal }), ErrorPerfil);
  });

  test('PUT /perfil guarda la lista y GET /memorias la devuelve con lo pendiente y el resumen', async () => {
    const db = bdConMemoria();
    const api = crearApi({ db, reloj: relojFijo(AHORA) });
    const put = await api.request('/perfil', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...leerPerfilEditable(db), memorias: [URL_MEMORIA, 'https://ong.org/m.pdf'] }) });
    assert.equal(put.status, 200);
    assert.deepEqual(((await put.json()) as { memorias: string[] }).memorias, [URL_MEMORIA, 'https://ong.org/m.pdf']);
    await procesarMemorias(ctx(db, llmFalso().llm), leerPerfil(db)!, 'claude-sonnet-5-5', { descubrir: false, maxExtracciones: 1 });
    const r = await (await api.request('/memorias')).json() as { enLista: string[]; pendientes: string[]; memorias: { anio: number; proyectos: number; financiadores: number }[]; totales: { proyectos: number } };
    assert.deepEqual(r.pendientes, ['https://ong.org/m.pdf']);
    assert.deepEqual(r.memorias.map((m) => [m.anio, m.proyectos, m.financiadores]), [[2021, 2, 5]]);
    assert.equal(r.totales.proyectos, 2);
    assert.equal(anadirMemorias(db, ['https://ong.org/m.pdf', 'https://ong.org/n.pdf'], AHORA).memorias!.length, 3);
  });
});

function leerPerfilEditable(db: DatabaseSync) {
  const p = leerPerfil(db)!;
  return { lineas: p.lineas, ambito: p.ambito, importeMinimo: p.importeMinimo };
}

async function bdConMemoriasExtraidas(): Promise<DatabaseSync> {
  const db = bdConMemoria();
  await procesarMemorias(ctx(db, llmFalso().llm), leerPerfil(db)!, 'claude-sonnet-5-5', { descubrir: false });
  return db;
}

describe('financiadores de las memorias en empresas y fundaciones', () => {
  const senal = (db: DatabaseSync, nombre: string, boe: string, cif: string | null = null) => registrarSenal(db, {
    nombre, cif, origen: 'dia_boe', motivo: 'm', cita: 'c', provincia: null,
    senal: { boeId: boe, titulo: 't', proyecto: null, provincia: null, medidas: [], enlace: `https://www.boe.es/diario_boe/txt.php?id=${boe}`, fechaPublicacion: '2026-11-01' },
  }, new Date('2026-11-01T10:00:00Z'));

  test('una empresa que figura como financiadora se marca por nombre normalizado, y sube solo dentro de su prioridad', async () => {
    const db = await bdConMemoriasExtraidas();
    senal(db, 'Otra Empresa Cualquiera, S.L.', 'BOE-A-2026-1');
    senal(db, 'CAIXABANK, S.A.', 'BOE-A-2026-2'); // llegó después, pero ya os financió
    senal(db, 'Repsol Petróleo, S.A.', 'BOE-A-2026-3');
    const lista = leerEmpresas(db);
    const caixa = lista.find((e) => e.nombre.startsWith('CAIXABANK'))!;
    assert.deepEqual(caixa.yaFinanciador, { nombre: 'CaixaBank', anios: [2021], relacion: 'financiacion' });
    assert.equal(lista.find((e) => e.nombre.startsWith('Otra'))!.yaFinanciador, null);
    assert.equal(lista.find((e) => e.nombre.startsWith('Repsol'))!.yaFinanciador, null, 'Fundación Repsol es una fundación: no marca a la empresa Repsol');
    assert.equal(lista[0].nombre, 'CAIXABANK, S.A.', 'a igual prioridad, el que ya financió va primero');
    const api = crearApi({ db, reloj: relojFijo(AHORA) });
    const r = await (await api.request('/empresas')).json() as { empresas: { nombre: string; yaFinanciador: { anios: number[] } | null }[] };
    assert.deepEqual(r.empresas.find((e) => e.nombre.startsWith('CAIXABANK'))!.yaFinanciador?.anios, [2021]);
  });

  test('una fundación vigilada se marca si figura entre los financiadores; las administraciones y otros tipos no', async () => {
    const db = await bdConMemoriasExtraidas();
    db.prepare("INSERT INTO fundaciones (nombre, url, tipo, activa) VALUES ('Fundación Desconocida', 'https://desconocida.example/', 'fundacion', 1), ('Comunidad de Madrid', 'https://cm.example/', 'agregador', 1)").run();
    const api = crearApi({ db, reloj: relojFijo(AHORA) });
    const { fundaciones } = await (await api.request('/fundaciones')).json() as { fundaciones: { nombre: string; yaFinanciador: { anios: number[]; relacion: string } | null }[] };
    const por = (n: string) => fundaciones.find((f) => f.nombre === n)!.yaFinanciador;
    assert.deepEqual(por('Fundación Montemadrid'), { nombre: 'fundación Montemadrid', anios: [2021], relacion: 'financiacion' });
    assert.equal(por('Fundación Desconocida'), null);
    assert.equal(por('Comunidad de Madrid'), null);
    assert.ok(!financiadoresConocidos(db).empresas.has('comunidad madrid'), 'las administraciones no se casan con nada');
  });
});

function convocatoria(id: string, titulo: string, extra: Partial<Convocatoria> = {}): Convocatoria {
  return { id: `bdns:${id}`, fuente: 'bdns', fuenteId: id, titulo, organo: { nivel1: 'AUTONOMICA', nivel2: 'COMUNIDAD DE MADRID', nivel3: null }, fechaPublicacion: '2026-11-10', url: `https://example.org/${id}`, tipo: null, finalidad: null, regiones: [], abierto: null, datos: {}, ...extra };
}

describe('experiencia relacionada en la ficha y en los prompts', () => {
  test('la ficha lista hasta 3 proyectos propios parecidos, con enlace a su memoria; sin parecido no sale nada', async () => {
    const db = await bdConMemoriasExtraidas();
    guardarConvocatoria(db, { convocatoria: convocatoria('1', 'Subvenciones para la restauración de vías pecuarias y corredores ecológicos en la Comunidad de Madrid'), descarte: null }, AHORA);
    guardarConvocatoria(db, { convocatoria: convocatoria('2', 'Ayudas para la modernización de la flota pesquera artesanal'), descarte: null }, AHORA);
    guardarFase(db, { convocatoriaId: 'bdns:1', fase: 'criba_llm', descarta: false, motivo: 'ok', datos: {} }, AHORA);
    const api = crearApi({ db, reloj: relojFijo(AHORA) });
    const f1 = await (await api.request('/convocatorias/bdns:1')).json() as { experiencia: { nombre: string; memoriaUrl: string; memoriaAnio: number }[] };
    assert.ok(f1.experiencia.length >= 1 && f1.experiencia.length <= 3);
    assert.match(f1.experiencia[0].nombre, /Asperilla/);
    assert.equal(f1.experiencia[0].memoriaUrl, URL_MEMORIA);
    assert.equal(f1.experiencia[0].memoriaAnio, 2021);
    const f2 = await (await api.request('/convocatorias/bdns:2')).json() as { experiencia: unknown[] };
    assert.deepEqual(f2.experiencia, []);
  });

  test('el bloque «Experiencia de la entidad» está en los prompts, es estable (no depende del orden de guardado) y sin memorias el prompt no cambia', async () => {
    const db = await bdConMemoriasExtraidas();
    const perfil = leerPerfil(db)!;
    const texto = experienciaDeLaEntidad(db, 15);
    assert.match(texto, /^- \[Memoria 2021\] /m);
    assert.match(texto, /Asperilla \(2021\) — Vereda de las Asperillas, Madrid — línea: Restauración de ecosistemas — con fundación Montemadrid, CaixaBank/);
    assert.equal(experienciaDeLaEntidad(db, 15), texto);
    // Mismo resultado aunque los proyectos se lean en otro orden.
    const invertidos = [...proyectosPropios(db)].reverse();
    assert.equal(textoExperiencia(invertidos, aniosMemorias(db), 15), texto);
    assert.equal(experienciaDeLaEntidad(db, 1).split('\n').length, 1, 'respeta el máximo');
    assert.equal(experienciaDeLaEntidad(db, 0), '');

    const c = convocatoria('3', 'Ayudas de restauración');
    const textos = [{ titulo: 'Bases', texto: 'Texto de las bases' }];
    const criba = promptCriba(perfil, c, null, textos, [], texto);
    assert.ok(criba.sistema.includes('Experiencia de la entidad'));
    assert.ok(criba.sistema.includes(texto));
    assert.equal(promptCriba(perfil, c, null, textos, [], texto).sistema, criba.sistema, 'estable');
    assert.equal(promptCriba(perfil, c, null, textos, [], '').sistema, promptCriba(perfil, c, null, textos).sistema, 'sin experiencia el prompt es el de siempre');
    const analisis = promptAnalisis(perfil, c, textos, null, [], texto);
    assert.ok(analisis.sistema.includes(texto) && analisis.sistema.includes('Memoria 2021'));
    assert.ok(!promptAnalisis(perfil, c, textos).sistema.includes('Experiencia de la entidad'));
    assert.ok(analisis.sistema.indexOf(texto) < analisis.sistema.indexOf('Reglas (obligatorias)'), 'tras el perfil, antes de las reglas');
  });

  test('en una pasada del motor, las memorias se leen antes de la criba y los prompts de esa misma pasada ya llevan la experiencia', async () => {
    const db = bdConMemoria();
    const { llm, llamadas } = llmFalso();
    const c = convocatoria('7', 'Restauración de vías pecuarias');
    const fuente: Fuente = {
      nombre: 'prueba', async recoger(ctx2) { return { cribadas: [{ convocatoria: { ...c, id: 'prueba:7', fuente: 'prueba', fuenteId: '7', fechaPublicacion: '2026-11-13' }, descarte: ctx2.cribar(c) }], errores: [] }; },
      documentos: () => [{ titulo: 'Bases', url: null, texto: 'Bases de la convocatoria' }],
    };
    await ejecutarRadar({ db, fetch: fetchFalso(), resolver: null, reloj: relojFijo(AHORA), llm, fuentes: [fuente], ganadores: false, parecidas: false, memorias: { descubrir: false } });
    assert.deepEqual(llamadas.map((l) => l.tarea).slice(0, 2), ['memorias', 'criba']);
    assert.ok(llamadas.find((l) => l.tarea === 'criba')!.sistema.includes('Experiencia de la entidad'));
  });
});
