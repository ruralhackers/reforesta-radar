// Rediseño de la web (API y motor): el corte de "Esta semana", título corto, nombres de documentos, cerradas y el ruido sin criba.
// Reloj fijo: viernes 13/11/2026.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { crearApi } from '../src/api/app.ts';
import { textoCierre } from '../src/correo.ts';
import { guardarConvocatoria, guardarFase, guardarPlazo } from '../src/db/repo.ts';
import { aplicarCitas } from '../src/fases/analisis-esquema.ts';
import { cortarSemana } from '../src/ranking.ts';
import { leerConfigPuntuacion, puntuar } from '../src/puntuacion.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdns, nombreDocumento } from '../src/sources/bdns.ts';
import { tituloLegible, validarTituloCorto } from '../src/titulo.ts';
import type { Convocatoria } from '../src/types.ts';
import { bdSembrada, RUTA_PUNTUACION, RUTA_SEMILLA } from './support/bd.ts';

const AHORA = new Date('2026-11-13T09:00:00Z');
const cfg = leerConfigPuntuacion(RUTA_PUNTUACION);
const perfil = leerSemilla(RUTA_SEMILLA).perfil;
const J = { 'Content-Type': 'application/json' };

function conv(n: string, titulo: string, datos: unknown = {}): Convocatoria {
  return {
    id: `bdns:${n}`, fuente: 'bdns', fuenteId: n, titulo, organo: { nivel1: 'LOCAL', nivel2: 'MADRID', nivel3: null },
    fechaPublicacion: '2026-11-12', url: `https://example.org/${n}`, tipo: null, finalidad: null, regiones: [], abierto: null, datos,
  };
}

interface Opciones { criba?: boolean; lineas?: number | null; cierre?: string | null; titulo?: string; tituloCorto?: string; datos?: unknown }

/** Guarda una convocatoria con plazo; `lineas: null` = sin analizar; `criba: false` = la criba aún no llegó a ella. */
function alta(db: DatabaseSync, n: string, o: Opciones = {}) {
  const id = `bdns:${n}`;
  guardarConvocatoria(db, { convocatoria: conv(n, o.titulo ?? `Convocatoria ${n}`, o.datos), descarte: null }, AHORA);
  const cierre = o.cierre === undefined ? '2026-12-20' : o.cierre;
  guardarPlazo(db, id, { fechaCierre: cierre, tipo: cierre ? 'literal' : 'desconocida', textoOriginal: null, fechaBase: null, baseOrigen: null, aproximada: false, detalle: 't' }, AHORA);
  if (o.criba !== false) guardarFase(db, { convocatoriaId: id, fase: 'criba_llm', descarta: false, motivo: 'ok', datos: {} }, AHORA);
  if (o.lineas !== null && o.lineas !== undefined) {
    const campo = (valor: string) => ({ valor, cita: valor, documento: 'Bases' });
    guardarFase(db, {
      convocatoriaId: id, fase: 'analisis', descarta: false, motivo: null,
      datos: { analisis: {
        elegibilidadEsfl: campo('si'), importeMaximoProyecto: campo('50.000 euros'), importeTotal: campo(''), plazo: campo(''), cofinanciacion: campo('sin cofinanciación'),
        requisitos: [], lineas: Array.from({ length: o.lineas }, (_, i) => ({ linea: `Línea ${i}`, motivo: `encaja con la línea ${i}`, cita: '', documento: '' })),
        ideaProyecto: null, correcciones: [], ...(o.tituloCorto ? { tituloCorto: o.tituloCorto } : {}),
      }, documentos: [], documentosConError: [] },
    }, AHORA);
  }
}

const api = (db: DatabaseSync) => crearApi({ db, reloj: { now: () => AHORA }, puntuacion: cfg, equipo: { password: null } });
interface Semana { umbral: number; paraPreparar: string[]; conMenosEncaje: string[]; convocatorias: { id: string; tarjeta: { tituloCorto: string; importe: string | null; porQue: string | null } }[]; resumen: { paraPreparar: number; cierranPronto: number; empresasNuevas: number } }
const semana = async (db: DatabaseSync) => (await (await api(db).request('/semana')).json()) as Semana;

describe('el corte de "Esta semana"', () => {
  test('solo las analizadas con puntuación >= umbral, como mucho 7; el resto, plegado y contado', async () => {
    const db = bdSembrada();
    for (let i = 1; i <= 9; i++) alta(db, `${i}`, { lineas: 3 }); // 9 buenas: solo 7 arriba
    alta(db, '20', { lineas: 0 }); // analizada pero sin encaje: puntúa por debajo del umbral
    alta(db, '21', { lineas: null, cierre: '2026-11-20' }); // sin analizar aunque cierre pronto
    const s = await semana(db);
    assert.equal(s.umbral, 50);
    assert.equal(s.paraPreparar.length, 7);
    assert.ok(s.paraPreparar.every((id) => /^bdns:[1-9]$/.test(id)));
    assert.equal(s.conMenosEncaje.length, 4); // 2 buenas fuera del máximo + la sin encaje + la sin analizar
    assert.ok(s.conMenosEncaje.includes('bdns:21') && s.conMenosEncaje.includes('bdns:20'));
    assert.equal(s.resumen.paraPreparar, 7);
    assert.equal(new Set([...s.paraPreparar, ...s.conMenosEncaje]).size, 11, 'nada se pierde ni se repite');
  });

  test('el umbral es del perfil y se edita (PUT /perfil); subirlo pliega las que ya no llegan', async () => {
    const db = bdSembrada();
    alta(db, '1', { lineas: 3 });
    alta(db, '2', { lineas: 1 });
    const a = api(db);
    assert.equal(((await (await a.request('/perfil')).json()) as { umbralEncaje: number }).umbralEncaje, 50);
    const antes = await semana(db);
    assert.deepEqual(antes.paraPreparar, ['bdns:1', 'bdns:2'].filter((id) => antes.paraPreparar.includes(id)));
    const total = (id: string) => (antes as unknown as { convocatorias: { id: string; puntuacion: { total: number } }[] }).convocatorias.find((c) => c.id === id)!.puntuacion.total;
    const umbral = total('bdns:1');
    const p = (await (await a.request('/perfil')).json()) as Record<string, unknown>;
    const res = await a.request('/perfil', { method: 'PUT', headers: J, body: JSON.stringify({ lineas: p.lineas, ambito: p.ambito, importeMinimo: p.importeMinimo, umbralEncaje: umbral }) });
    assert.equal(res.status, 200);
    const despues = await semana(db);
    assert.equal(despues.umbral, umbral);
    assert.deepEqual(despues.paraPreparar, ['bdns:1']);
    assert.deepEqual(despues.conMenosEncaje, ['bdns:2']);
    // Sin tocar el umbral, guardar el perfil sin ese campo lo conserva; fuera de 0-100 se rechaza.
    const sin = await a.request('/perfil', { method: 'PUT', headers: J, body: JSON.stringify({ lineas: p.lineas, ambito: p.ambito, importeMinimo: p.importeMinimo }) });
    assert.equal(((await sin.json()) as { umbralEncaje: number }).umbralEncaje, umbral);
    assert.equal((await a.request('/perfil', { method: 'PUT', headers: J, body: JSON.stringify({ lineas: p.lineas, ambito: p.ambito, importeMinimo: null, umbralEncaje: 120 }) })).status, 400);
  });

  test('cortarSemana: el consorcio no entra en el corte y una sin analizar no ocupa sitio aunque puntúe alto', () => {
    const fila = (id: string, total: number, analizada: boolean, seccion: 'nuevas' | 'consorcio') => ({
      id, fuente: 'bdns', titulo: id, organo: '', fechaPublicacion: '2026-11-12', url: '', primeraVez: '', plazo: null, seccion,
      puntuacion: { total, analizada, excluida: null, factores: [], calculadoEn: '' },
    });
    const r = cortarSemana([fila('a', 60, true, 'nuevas'), fila('b', 90, false, 'nuevas'), fila('c', 95, true, 'consorcio'), fila('d', 49, true, 'nuevas')], 50);
    assert.deepEqual(r.paraPreparar.map((f) => f.id), ['a']);
    assert.deepEqual(r.conMenosEncaje.map((f) => f.id), ['b', 'd']);
  });

  test('cada fila lleva su tarjeta: título corto (el del análisis o el oficial legible), importe y por qué', async () => {
    const db = bdSembrada();
    alta(db, '1', { lineas: 2, titulo: 'CONVOCATORIA DE SUBVENCIONES PARA LA RESTAURACIÓN DE RIBERAS 2027', tituloCorto: 'Restauración de riberas, Ayto. de Madrid' });
    alta(db, '2', { lineas: null, titulo: 'BASES REGULADORAS DEL CONCURSO DE DECORACIÓN E ILUMINACIÓN NAVIDEÑA DE VIVIENDAS DE GUADALAJARA' });
    const s = await semana(db);
    const t = (id: string) => s.convocatorias.find((c) => c.id === id)!.tarjeta;
    assert.equal(t('bdns:1').tituloCorto, 'Restauración de riberas, Ayto. de Madrid');
    assert.match(t('bdns:1').importe ?? '', /50\.000/);
    assert.equal(t('bdns:1').porQue, 'encaja con la línea 0.');
    assert.match(t('bdns:2').tituloCorto, /^Concurso de decoración e iluminación navideña de viviendas/);
    assert.equal(t('bdns:2').importe, null);
  });
});

describe('ruido: lo que no ha pasado la criba no entra en el ranking', () => {
  test('un concurso sin veredicto de criba no sale (puntuaría con solo el cierre conocido); con la criba dada por buena, sí (aunque no por arriba)', async () => {
    const db = bdSembrada();
    alta(db, '930049', { titulo: 'ACUERDO Y RECONOCIMIENTO DEL CONCURSO DE ESCAPARATISMO NAVIDEÑO 2026/27', criba: false, lineas: null, cierre: '2026-11-30' });
    assert.deepEqual((await semana(db)).convocatorias, []);
    assert.equal((await (await api(db).request('/contadores')).json() as { estaSemana: number }).estaSemana, 0);
    guardarFase(db, { convocatoriaId: 'bdns:930049', fase: 'criba_llm', descarta: false, motivo: 'ok', datos: {} }, AHORA);
    const s = await semana(db);
    assert.deepEqual(s.convocatorias.map((c) => c.id), ['bdns:930049']);
    assert.deepEqual(s.paraPreparar, [], 'y sin analizar, nunca arriba');
    assert.deepEqual(s.conMenosEncaje, ['bdns:930049']);
  });

  test('una descartada por la criba tampoco sale', async () => {
    const db = bdSembrada();
    alta(db, '1', { criba: false, lineas: null });
    guardarFase(db, { convocatoriaId: 'bdns:1', fase: 'criba_llm', descarta: true, motivo: 'ajena', datos: {} }, AHORA);
    assert.deepEqual((await semana(db)).convocatorias, []);
  });
});

describe('cerradas: "Cerrada el …", nunca días negativos', () => {
  const entrada = (dias: number) => ({
    convocatoria: conv('1', 'T'), analisis: null, importeMinimo: null,
    plazo: { fechaCierre: '2026-06-05', tipo: 'literal' as const, diasHastaCierre: dias },
  });

  test('el factor de cierre y el motivo de exclusión dicen la fecha', () => {
    const p = puntuar(entrada(-161), cfg);
    const cierre = p.factores.find((f) => f.id === 'cierre')!;
    assert.equal(cierre.explicacion, 'cerrada el 5 de junio de 2026');
    assert.equal(cierre.subpuntuacion, 0);
    assert.equal(p.excluida, 'Cerrada el 5 de junio de 2026');
    assert.ok(!/-\d/.test(JSON.stringify(p)), 'ningún número negativo en la explicación');
  });

  test('la ficha de una cerrada (904719-like) lo cuenta con la fecha; el correo también', async () => {
    const db = bdSembrada();
    alta(db, '904719', { lineas: 2, cierre: '2026-06-05' });
    const ficha = (await (await api(db).request('/convocatorias/bdns%3A904719')).json()) as { puntuacion: { excluida: string; factores: { id: string; explicacion: string }[] }; plazo: { diasHastaCierre: number } };
    assert.ok(ficha.plazo.diasHastaCierre < 0);
    assert.equal(ficha.puntuacion.excluida, 'Cerrada el 5 de junio de 2026');
    assert.doesNotMatch(ficha.puntuacion.factores.find((f) => f.id === 'cierre')!.explicacion, /faltan|-\d/);
    assert.equal(textoCierre({ fechaCierre: '2026-06-05', tipo: 'literal', diasHastaCierre: -161 }), 'Cerrada el 5 jun');
  });
});

describe('título corto', () => {
  test('el oficial en MAYÚSCULAS pasa a frase normal, sin encabezado administrativo y recortado en límite de palabra', () => {
    assert.equal(tituloLegible('APROBACIÓN DE LAS BASES DEL CONCURSO DE ESCAPARATES HALLOWEEN 2026'), 'Concurso de escaparates halloween 2026');
    assert.equal(tituloLegible('SUBVENCIÓN ENTIDADES SIN ÁNIMO DE LUCRO PROYECTOS AMBIENTALES 2026'), 'Subvención entidades sin ánimo de lucro proyectos ambientales 2026');
    assert.equal(tituloLegible('Resolución nº 2026001033 de 13/11/2026 de la Consejería de Cultura, por la que se convoca el CONCURSO DE ESCAPARATES NAVIDEÑOS 2026.'), 'Concurso de escaparates navideños 2026');
    assert.equal(tituloLegible('BASES XI CONCURSO DE ILUMINACIÓN\nNAVIDEÑA DE VIVIENDAS'), 'Bases XI concurso de iluminación navideña de viviendas');
    const largo = tituloLegible('CONVOCATORIA DE PREMIOS MUNICIPALES DE ESCAPARATES DE AMBIENTACIÓN NAVIDEÑA PARA EL AÑO 2026 DEL AYUNTAMIENTO DE ALBERIC');
    assert.ok(largo.length <= 90 && largo.endsWith('…') && !largo.includes('  '));
    for (const t of [tituloLegible('CONVOCATORIA DE AYUDAS AL ASOCIACIONISMO'), largo]) assert.notEqual(t, t.toUpperCase());
  });

  test('un título oficial que ya es legible se respeta; un título del LLM en mayúsculas se corrige y uno vacío se ignora', () => {
    assert.equal(tituloLegible('Fomento del asociacionismo 2027 · Distrito de Usera'), 'Fomento del asociacionismo 2027 · Distrito de Usera');
    assert.equal(validarTituloCorto('AYUDAS PARA EL FOMENTO DEL ASOCIACIONISMO.'), 'Ayudas para el fomento del asociacionismo');
    assert.equal(validarTituloCorto('  '), null);
    assert.equal(validarTituloCorto(42), null);
  });

  test('el análisis lo valida (aplicarCitas) y la ficha lo devuelve; sin él, el fallback legible', async () => {
    const a = aplicarCitas({ tituloCorto: 'AYUDAS A LA CUSTODIA DEL TERRITORIO', lineas: [] }, [], perfil);
    assert.equal(a.tituloCorto, 'Ayudas a la custodia del territorio');
    assert.equal(aplicarCitas({}, [], perfil).tituloCorto, null);
    const db = bdSembrada();
    alta(db, '1', { lineas: 1, titulo: 'AYUDAS OFICIALES EN MAYÚSCULAS PARA ALGO', tituloCorto: 'Custodia del territorio' });
    alta(db, '2', { lineas: null, titulo: 'AYUDAS OFICIALES EN MAYÚSCULAS PARA ALGO' });
    const t = async (n: string) => ((await (await api(db).request(`/convocatorias/bdns%3A${n}`)).json()) as { tituloCorto: string }).tituloCorto;
    assert.equal(await t('1'), 'Custodia del territorio');
    assert.equal(await t('2'), 'Ayudas oficiales en mayúsculas para algo');
  });
});

describe('nombres reales de los documentos de BDNS', () => {
  test('descripción, o el fichero sin extensión, o "Documento <id>"', () => {
    assert.equal(nombreDocumento({ id: 1, descripcion: 'Modelo de Solicitud', nombreFic: 'Modelo de Solicitud.pdf' }), 'Modelo de Solicitud');
    assert.equal(nombreDocumento({ id: 2, descripcion: '  ', nombreFic: 'Anexo II.pdf' }), 'Anexo II');
    assert.equal(nombreDocumento({ id: 3, descripcion: null, nombreFic: null }), 'Documento 3');
  });

  test('la ficha enlaza cada documento con su nombre, no con "Documento"', async () => {
    const db = bdSembrada();
    alta(db, '904719', { lineas: 1, datos: { detalle: { documentos: [
      { id: 1460853, descripcion: 'Texto en castellano de la convocatoria', nombreFic: 'Texto Convocatoria BDNS.pdf' },
      { id: 1460854, descripcion: null, nombreFic: 'Modelo de Solicitud.pdf' },
    ] } } });
    const ficha = (await (await crearApi({ db, reloj: { now: () => AHORA }, puntuacion: cfg, fuentes: [bdns], equipo: { password: null } }).request('/convocatorias/bdns%3A904719')).json()) as { enlaces: { tipo: string; titulo: string; url: string }[] };
    assert.deepEqual(ficha.enlaces.filter((e) => e.tipo === 'documento').map((e) => e.titulo), ['Texto en castellano de la convocatoria', 'Modelo de Solicitud']);
  });
});
