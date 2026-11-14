// Elegibilidad por sede: el análisis (con los documentos) descarta lo que exige sede o inscripción donde la entidad no está domiciliada.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { leerFases, leerPuntuacion } from '../src/db/repo.ts';
import { ejecutarRadar } from '../src/engine.ts';
import type { Analisis } from '../src/fases/analisis-esquema.ts';
import type { Llm, PeticionLlm } from '../src/llm/llm.ts';
import { reconsiderarVeredictos, versionLineas } from '../src/perfil.ts';
import { leerSemilla } from '../src/seed.ts';
import { bdSembradaConExtremaduraParcial as bdSembrada, RUTA_SEMILLA, relojFijo } from './support/bd.ts';
import { ESCENARIOS, fetchGrabado } from './support/grabaciones.ts';

const perfil = leerSemilla(RUTA_SEMILLA).perfil;
const USO = { entrada: 1000, salida: 100, cacheLectura: 0, cacheEscritura: 0 };
const e = ESCENARIOS.agosto2026;
const CITA = 'destinadas a entidades del Tercer Sector u organizaciones no gubernamentales de ámbito estatal';
const vacio = { valor: '', cita: '', documento: '' };

/** `sede`: lo que el LLM falso responde a la elegibilidad por sede de la 923290. */
function llmFalso(sede: Record<string, string>): Llm {
  return {
    async generar(p: PeticionLlm) {
      const id = /Convocatoria (bdns:\d+)/.exec(p.mensaje)?.[1] ?? '';
      const datos = p.tarea === 'criba'
        ? (id === 'bdns:923290' ? { decision: 'puede_encajar', motivo: 'ONG ambientales', exigeSedeEnOtraComunidad: 'no_aplica' } : { decision: 'descartar', motivo: 'No encaja', exigeSedeEnOtraComunidad: 'no_aplica' })
        : {
            elegibilidadEsfl: id === 'bdns:923290' ? { valor: 'si', cita: CITA, documento: 'Extracto BOE-B-2026-26402' } : vacio,
            elegibilidadSede: id === 'bdns:923290' ? sede : { ...vacio, razon: '' },
            importeMaximoProyecto: vacio, importeTotal: vacio, plazo: vacio, cofinanciacion: vacio, requisitos: [], lineas: [], ideaProyecto: '', tituloCorto: 'Título corto de prueba',
          };
      return { datos, modelo: p.modelo, uso: USO };
    },
  };
}

const ejecutar = (db: ReturnType<typeof bdSembrada>, sede: Record<string, string>) =>
  ejecutarRadar({ db, fetch: fetchGrabado(), reloj: relojFijo(e.ahora), llm: llmFalso(sede) }, { diasAtras: e.diasAtras });

describe('elegibilidad por sede en el análisis', () => {
  test('exige sede en otro distrito: se descarta con motivo y cita, y queda fuera del ranking', async () => {
    const db = bdSembrada();
    await ejecutar(db, { valor: 'no', cita: CITA, documento: 'Extracto BOE-B-2026-26402', razon: 'Exige sede social en el Distrito de Usera; la entidad está en Tres Cantos' });
    const f = leerFases(db, 'bdns:923290').find((x) => x.fase === 'analisis')!;
    assert.equal(f.descarta, true);
    assert.match(f.motivo!, /^Exige sede social en el Distrito de Usera; la entidad está en Tres Cantos: «destinadas/);
    const a = (f.datos as { analisis: Analisis }).analisis;
    assert.equal(a.elegibilidadSede?.valor, 'no');
    assert.equal(leerPuntuacion(db, 'bdns:923290'), null, 'descartada por el análisis: fuera de juego, sin puntuación ni ranking');
  });

  test('un "no" sin cita comprobable o sin razón no excluye nada', async () => {
    for (const sede of [{ valor: 'no', cita: 'texto inventado que no está', documento: 'x', razon: 'Exige sede' }, { valor: 'no', cita: CITA, documento: '', razon: '' }]) {
      const db = bdSembrada();
      await ejecutar(db, sede);
      const f = leerFases(db, 'bdns:923290').find((x) => x.fase === 'analisis')!;
      assert.equal(f.descarta, false);
      assert.equal(leerPuntuacion(db, 'bdns:923290')?.excluida ?? null, null);
    }
  });

  test('la misma convocatoria con sede "si" (domicilio coincide) se queda', async () => {
    const db = bdSembrada();
    await ejecutar(db, { valor: 'si', cita: CITA, documento: 'Extracto BOE-B-2026-26402', razon: '' });
    const f = leerFases(db, 'bdns:923290').find((x) => x.fase === 'analisis')!;
    assert.equal(f.descarta, false);
    assert.equal(leerPuntuacion(db, 'bdns:923290')?.excluida ?? null, null);
  });

  test('cambiar el domicilio deja obsoletos los análisis (y quitarlo vuelve a la versión anterior)', async () => {
    const db = bdSembrada();
    await ejecutar(db, { valor: 'si', cita: CITA, documento: 'Extracto BOE-B-2026-26402', razon: '' });
    const otro = { ...perfil, domicilio: { ...perfil.domicilio!, municipio: 'Madrid' } };
    assert.notEqual(versionLineas(perfil), versionLineas(otro));
    assert.equal(reconsiderarVeredictos(db, otro).analisis, 1);
    assert.equal((leerFases(db, 'bdns:923290').find((x) => x.fase === 'analisis')!.datos as { obsoleta?: boolean }).obsoleta, true);
    assert.equal(reconsiderarVeredictos(db, perfil).analisis, 0);
  });
});
