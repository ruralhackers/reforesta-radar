// Fuentes nuevas: una fundación (Ibercaja) y unos premios (Biodiversidad Fundación BBVA) con sus páginas reales grabadas, el tipo "premio"
// de punta a punta (extracción → ficha y tarjeta → puntuación sin cofinanciación) y la siembra de fuentes nuevas en BD ya existentes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crearApi } from '../src/api/app.ts';
import { altaFuente, leerFuentesVigiladas } from '../src/db/fundaciones.ts';
import { abrirBd } from '../src/db/schema.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { type ConfigPuntuacion, type EntradaPuntuacion, leerConfigPuntuacion, puntuar } from '../src/puntuacion.ts';
import { sembrarSiVacia } from '../src/seed.ts';
import { crearFuenteFundaciones } from '../src/sources/fundaciones.ts';
import type { Convocatoria } from '../src/types.ts';
import type { Analisis, CampoCitado } from '../src/fases/analisis-esquema.ts';
import { bdSembrada, RUTA_PUNTUACION, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
import { fetchPaginas, paginaGrabada } from './support/fundaciones.ts';

const AHORA = new Date('2026-11-14T09:00:00Z');
const IBERCAJA = 'https://www.fundacionibercaja.es/convocatorias/';
const PREMIOS = 'https://www.biophilia-fbbva.es/premios/xxi-premios-biodiversidad/';
const FUENTE = crearFuenteFundaciones(() => ({ pausaMs: 0, timeoutMs: 5000, maxBytes: 3 * 1024 * 1024, maxFuentes: 60, maxCaracteres: 60_000 }));

const EXTRACCIONES: Record<string, unknown[]> = {
  [IBERCAJA]: [{
    titulo: 'Solicitud de colaboración económica 2026 para proyectos',
    url: 'https://www.fundacionibercaja.es/convocatorias/solicitud-de-colaboracion-economica-2026-para-proyectos/',
    plazo: 'Del 01 de enero al 31 de diciembre de 2026', importe: '', extracto: '', resumen: 'Colaboración económica anual para entidades sin ánimo de lucro',
  }],
  [PREMIOS]: [{
    titulo: 'Premio Biodiversidad España', url: 'https://www.biophilia-fbbva.es/premios/xxi-premio-biodiversidad-espana',
    plazo: '', importe: 'dotado con 250.000 euros', extracto: '', resumen: 'Premio a la conservación de la biodiversidad en España',
  }],
};

function llmFalso(): Llm {
  return {
    async generar(p: PeticionLlm) {
      let datos: unknown;
      if (p.tarea === 'extraccion') {
        const pagina = /^Página: (\S+)/m.exec(p.mensaje)![1];
        datos = { convocatorias: EXTRACCIONES[pagina] };
      } else if (p.tarea === 'criba') datos = { decision: 'puede_encajar', motivo: 'Encaja con educación ambiental', exigeSedeEnOtraComunidad: 'no_aplica' };
      else throw new Error('sin análisis en este test');
      return { datos, modelo: p.modelo, uso: { entrada: 2000, salida: 300, cacheLectura: 0, cacheEscritura: 0 } };
    },
  };
}

describe('fundación y premio nuevos con páginas grabadas', () => {
  test('la fundación entra como fundación; el premio con tipo "premio", chip en tarjeta y ficha', async () => {
    const db = bdSembrada();
    db.exec('DELETE FROM fundaciones');
    altaFuente(db, { nombre: 'Fundación Ibercaja', url: IBERCAJA, tipo: 'fundacion' });
    altaFuente(db, { nombre: 'Premios Biodiversidad Fundación BBVA', url: PREMIOS, tipo: 'premio' });
    const fetch = fetchPaginas(new Map([[IBERCAJA, paginaGrabada(IBERCAJA)], [PREMIOS, paginaGrabada(PREMIOS)]]));
    const r = await ejecutarRadar(
      { db, fetch, reloj: relojFijo(AHORA), fuentes: [FUENTE], llm: llmFalso(), configLlm: { maxAnalisis: 0 }, ganadores: false, parecidas: false }, { diasAtras: 7 },
    );
    assert.equal(r.conErrores, false, JSON.stringify(r.fuentes));

    const filas = db.prepare("SELECT id, titulo, tipo, datos FROM convocatorias WHERE fuente = 'fundacion' ORDER BY titulo").all() as { id: string; titulo: string; tipo: string | null; datos: string }[];
    assert.equal(filas.length, 2);
    const ibercaja = filas.find((f) => /colaboración económica/.test(f.titulo))!;
    const premio = filas.find((f) => f.titulo === 'Premio Biodiversidad España')!;
    assert.match(ibercaja.id, /^fund:fundacionibercaja\.es:/);
    assert.equal(ibercaja.tipo, null);
    assert.equal(JSON.parse(ibercaja.datos).fundacion.plazo, 'Del 01 de enero al 31 de diciembre de 2026');
    assert.match(premio.id, /^fund:biophilia-fbbva\.es:/);
    assert.equal(premio.tipo, 'premio');
    const dp = JSON.parse(premio.datos).fundacion;
    assert.equal(dp.tipo, 'premio');
    assert.equal(dp.importe, 'dotado con 250.000 euros');

    const api = crearApi({ db, reloj: relojFijo(AHORA), fuentes: [FUENTE] });
    const semana = await (await api.request('/semana')).json() as { convocatorias: { id: string; tarjeta: { tipo: string | null } }[] };
    assert.equal(semana.convocatorias.find((c) => c.id === premio.id)?.tarjeta.tipo, 'premio');
    assert.equal(semana.convocatorias.find((c) => c.id === ibercaja.id)?.tarjeta.tipo, null);
    const ficha = await (await api.request(`/convocatorias/${encodeURIComponent(premio.id)}`)).json() as { tipo: string | null; fuente: string };
    assert.equal(ficha.tipo, 'premio');
    assert.equal(ficha.fuente, 'fundacion');
  });
});

describe('API: tipo de la fuente vigilada', () => {
  test('se puede añadir un premio y la lista devuelve su tipo; un tipo desconocido da 400', async () => {
    const db = bdSembrada();
    const api = crearApi({ db, reloj: relojFijo(AHORA), equipo: { password: null } });
    const post = (cuerpo: unknown) => api.request('/fundaciones', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
    const alta = await post({ nombre: 'Premio de prueba', url: 'https://premios.example.org/convocatoria', tipo: 'premio' });
    assert.equal(alta.status, 201);
    assert.equal(((await alta.json()) as { tipo: string }).tipo, 'premio');
    assert.equal((await post({ nombre: 'Otro', url: 'https://premios.example.org/otro', tipo: 'concurso' })).status, 400);
    const lista = await (await api.request('/fundaciones')).json() as { fundaciones: { nombre: string; tipo: string }[] };
    assert.equal(lista.fundaciones.find((f) => f.nombre === 'Premio de prueba')?.tipo, 'premio');
    const porTipo = (t: string) => lista.fundaciones.filter((f) => f.tipo === t).length;
    assert.ok(porTipo('premio') >= 7 && porTipo('fundacion') >= 10 && porTipo('agregador') === 2);
  });
});

describe('puntuación de un premio', () => {
  const config: ConfigPuntuacion = leerConfigPuntuacion(RUTA_PUNTUACION);
  const campo = (valor: string | null): CampoCitado => ({ valor, cita: valor, documento: valor ? 'D' : null });
  const analisis = (): Analisis => ({
    elegibilidadEsfl: campo('si') as Analisis['elegibilidadEsfl'], importeMaximoProyecto: campo(null), importeTotal: campo('250.000 euros'), plazo: campo(null),
    cofinanciacion: campo('cofinanciación del 80 %'), requisitos: [campo('r1')], lineas: [], ideaProyecto: null, correcciones: [],
  });
  const conv = (tipo: string | null): Convocatoria => ({
    id: 'fund:x:1', fuente: 'fundacion', fuenteId: 'x:1', titulo: 'T', organo: { nivel1: 'FUNDACIÓN', nivel2: 'X', nivel3: null },
    fechaPublicacion: '2026-11-14', url: 'https://example.org', tipo, finalidad: null, regiones: [], abierto: null, datos: {},
  });
  const entrada = (tipo: string | null): EntradaPuntuacion => ({
    convocatoria: conv(tipo), analisis: analisis(), importeMinimo: 3000, plazo: { fechaCierre: '2026-12-14', tipo: 'literal', diasHastaCierre: 30 },
  });

  test('el importe es la dotación del premio y la cofinanciación no cuenta', () => {
    const p = puntuar(entrada('premio'), config);
    const q = puntuar(entrada(null), config);
    const f = (x: typeof p, id: string) => x.factores.find((y) => y.id === id)!;
    assert.match(f(p, 'importe').explicacion, /^premio de /);
    assert.match(f(p, 'esfuerzo').explicacion, /premio: sin cofinanciación/);
    assert.doesNotMatch(f(p, 'esfuerzo').explicacion, /80/);
    assert.match(f(q, 'esfuerzo').explicacion, /cofinanciación del 80 %/);
    assert.ok(f(p, 'esfuerzo').subpuntuacion > f(q, 'esfuerzo').subpuntuacion);
    assert.ok(f(p, 'importe').subpuntuacion > f(q, 'importe').subpuntuacion, 'sin el descuento por "solo consta el total"');
  });
});

describe('siembra de fuentes nuevas en una BD ya sembrada', () => {
  test('añade las que faltan sin tocar las del equipo ni resucitar las quitadas', () => {
    const db = abrirBd(':memory:');
    sembrarSiVacia(db, RUTA_SEMILLA, new Date());
    const n = () => leerFuentesVigiladas(db).length;
    const total = n();
    // BD "antigua": le faltan dos fuentes nuevas, el equipo editó una y quitó otra.
    for (const nombre of ['Fundación Ibercaja', 'Premios Fundación Moeve']) {
      db.prepare('DELETE FROM fundaciones WHERE nombre = ?').run(nombre);
      db.prepare('DELETE FROM fundaciones_sembradas WHERE nombre = ?').run(nombre);
    }
    db.prepare("UPDATE fundaciones SET url = 'https://editada.example.org/', activa = 0, notas = 'del equipo' WHERE nombre = 'Fundación Daniel y Nina Carasso'").run();
    db.prepare("DELETE FROM fundaciones WHERE nombre = 'Premio Europeo Natura 2000'").run(); // quitada por el equipo: sigue en fundaciones_sembradas
    assert.equal(sembrarSiVacia(db, RUTA_SEMILLA, new Date()), false);
    assert.equal(n(), total - 1);
    const f = (nombre: string) => leerFuentesVigiladas(db).find((x) => x.nombre === nombre);
    assert.equal(f('Fundación Ibercaja')?.tipo, 'fundacion');
    assert.equal(f('Premios Fundación Moeve')?.tipo, 'premio');
    assert.equal(f('Premio Europeo Natura 2000'), undefined);
    const editada = f('Fundación Daniel y Nina Carasso')!;
    assert.deepEqual([editada.url, editada.activa, editada.notas], ['https://editada.example.org/', false, 'del equipo']);
    sembrarSiVacia(db, RUTA_SEMILLA, new Date()); // idempotente
    assert.equal(n(), total - 1);
  });
});
