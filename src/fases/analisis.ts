// Fase `analisis` (Sonnet): las que pasaron la criba se leen a fondo (extracto + documentos + bases, PDF → texto)
// y se extraen los campos con cita literal (ver analisis-esquema.ts). Tope de llamadas reales por ejecución:
// al alcanzarlo, las que faltan se quedan sin análisis (se reintentan en la siguiente mientras estén dentro de
// `diasPendientes`) y se registra.
import { borrarFallosLlm, FUENTE_LICITACIONES, guardarFase, pendientesDeFase, type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { leerDocumentos } from '../documentos.ts';
import { textoGanadoresParaPrompt } from '../ganadores.ts';
import { promptAnalisis, promptAnalisisLicitacion, recortarTextos } from '../llm/prompts.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import { versionLineas } from '../perfil.ts';
import type { Convocatoria, Perfil } from '../types.ts';
import type { TextoParaLlm } from '../llm/prompts.ts';
import { CONFIG_LLM_POR_DEFECTO } from '../llm/llm.ts';
import { aplicarCitas, esquemaAnalisis } from './analisis-esquema.ts';
import { aplicarCitasLicitacion, esquemaAnalisisLicitacion } from './analisis-licitacion-esquema.ts';
import { aCache, type ContextoFase, claveCache, desdeCache, enParalelo, esPresupuestoAgotado, fallo, llamar, validarRespuesta } from './comun.ts';
import { FASE_CRIBA } from './criba.ts';

export const FASE_ANALISIS = 'analisis';
/** Nombre del registro de ejecución del análisis de licitaciones (el veredicto se guarda en la fase `analisis`, como el de las convocatorias). */
export const FASE_ANALISIS_LICITACIONES = 'analisis_licitaciones';
const EN_PARALELO = 2;

/** Lo que distingue el análisis de una licitación del de una convocatoria: qué se pide, cómo se valida y cuándo descarta. */
interface Modo {
  registro: string;
  fuente: { solo?: string; sin?: string };
  esquema: (p: Perfil) => Record<string, unknown>;
  prompt: (p: Perfil, c: Convocatoria, textos: TextoParaLlm[], ctx: ContextoFase) => { sistema: string; mensaje: string };
  aplicar: (datos: unknown, textos: TextoParaLlm[], p: Perfil) => unknown;
  veredicto: (analisis: any) => { descarta: boolean; motivo: string | null };
  /** Los avisos de «tope alcanzado» hablan de convocatorias o de licitaciones. */
  nombre: string;
}

const MODO_CONVOCATORIAS: Modo = {
  registro: FASE_ANALISIS, fuente: { sin: FUENTE_LICITACIONES }, esquema: esquemaAnalisis, nombre: 'convocatorias',
  prompt: (perfil, c, textos, ctx) => promptAnalisis(perfil, c, textos, textoGanadoresParaPrompt(ctx.db, c, perfil), ctx.ejemplos),
  aplicar: aplicarCitas,
  veredicto: (a) => {
    const e = a.elegibilidadEsfl;
    const s = a.elegibilidadSede;
    const sedeNo = s?.valor === 'no';
    const descarta = e.valor === 'no' || sedeNo;
    return { descarta, motivo: sedeNo ? `${s.razon ?? 'Exige sede o inscripción en otro territorio'}: «${s.cita}»` : descarta ? `No admite entidades sin ánimo de lucro: «${e.cita}»` : null };
  },
};

const MODO_LICITACIONES: Modo = {
  registro: FASE_ANALISIS_LICITACIONES, fuente: { solo: FUENTE_LICITACIONES }, esquema: esquemaAnalisisLicitacion, nombre: 'licitaciones',
  prompt: (perfil, c, textos, ctx) => promptAnalisisLicitacion(perfil, c, textos, ctx.ejemplosLicitaciones),
  aplicar: aplicarCitasLicitacion,
  veredicto: (a) => {
    const r = a.reservaSocial;
    const descarta = r.valor === 'si';
    return { descarta, motivo: descarta ? `Contrato reservado a otro tipo de entidad (centros especiales de empleo, empresas de inserción…): «${r.cita}»` : null };
  },
};

export const analizarConLlm = (
  ctx: ContextoFase, perfil: Perfil, modelo: string, maxLlamadas: number, publicadasDesde: string, fuentes?: Fuente[],
  maxCaracteres: number = CONFIG_LLM_POR_DEFECTO.maxCaracteresAnalisis,
): Promise<RegistroFase> => analizarPendientes(MODO_CONVOCATORIAS, ctx, perfil, modelo, maxLlamadas, publicadasDesde, fuentes, maxCaracteres);

/** Análisis (Sonnet) de las licitaciones que pasaron la criba: va antes que el de las convocatorias (cuentan atrás desde su plazo) y gasta del mismo tope. */
export const analizarLicitaciones = (
  ctx: ContextoFase, perfil: Perfil, modelo: string, maxLlamadas: number, publicadasDesde: string, fuentes?: Fuente[],
  maxCaracteres: number = CONFIG_LLM_POR_DEFECTO.maxCaracteresAnalisis,
): Promise<RegistroFase> => analizarPendientes(MODO_LICITACIONES, ctx, perfil, modelo, maxLlamadas, publicadasDesde, fuentes, maxCaracteres);

async function analizarPendientes(
  modo: Modo, ctx: ContextoFase, perfil: Perfil, modelo: string, maxLlamadas: number, publicadasDesde: string, fuentes: Fuente[] | undefined, maxCaracteres: number,
): Promise<RegistroFase> {
  const registro = registroFaseVacio(modo.registro, modelo);
  const pendientes = pendientesDeFase(ctx.db, FASE_ANALISIS, publicadasDesde, FASE_CRIBA, { incluirIds: ctx.incluirIds, soloIncluidas: ctx.soloIncluidas, maxIntentos: ctx.maxIntentos, fuente: modo.fuente });
  const esquema = modo.esquema(perfil);
  let reservadas = 0; // llamadas reales comprometidas (se cuenta antes de esperar, por el paralelismo)

  await enParalelo(pendientes, EN_PARALELO, async ({ convocatoria: c }) => {
    try {
      const docs = fuentePorNombre(c.fuente, fuentes)?.documentos?.(c) ?? [{ titulo: 'Ficha', url: c.url, texto: c.titulo }];
      const lectura = await leerDocumentos(ctx.db, ctx.fetch, docs, ctx.reloj.now(), ctx.resolver);
      if (lectura.erroresTransitorios.length) {
        // Sin todos los textos el análisis saldría con importes o plazos "desconocido" para siempre:
        // no se llama al LLM ni se guarda veredicto; queda pendiente para la próxima ejecución.
        registro.errores.push(`Análisis ${c.id} aplazado, documentos no disponibles ahora: ${lectura.erroresTransitorios.join(' · ')}`);
        return;
      }
      // Tope del tamaño total del prompt: lo que sobra se recorta con una nota (y las citas se comprueban contra lo que el modelo vio).
      const { textos, recortados } = recortarTextos(lectura.textos, maxCaracteres);
      if (recortados) registro.avisos.push(`Documentos de ${c.id} recortados a ${maxCaracteres} caracteres en total (${recortados} sin leer)`);
      const { sistema, mensaje } = modo.prompt(perfil, c, textos, ctx);
      const peticion = { tarea: 'analisis' as const, modelo, sistema, mensaje, esquema, maxTokens: 16000 };
      const clave = claveCache(peticion);
      let r = desdeCache(ctx.db, clave);
      if (r) {
        registro.desdeCache++;
      } else {
        if (reservadas >= maxLlamadas) {
          registro.omitidasPorTope++;
          return;
        }
        reservadas++;
        r = await llamar(ctx, registro, peticion);
      }
      const datos = r.datos;
      const analisis = validarRespuesta(() => modo.aplicar(datos, textos, perfil));
      aCache(ctx, clave, r);
      const { descarta, motivo } = modo.veredicto(analisis);
      guardarFase(ctx.db, {
        convocatoriaId: c.id, fase: FASE_ANALISIS, descarta, motivo,
        datos: {
          modelo: r.modelo, desdeCache: r.desdeCache, analisis, versionLineas: versionLineas(perfil),
          documentos: lectura.textos.map((t) => ({ titulo: t.titulo, caracteres: t.texto.length })),
          ...(recortados ? { caracteresSinLeer: recortados } : {}),
          documentosConError: lectura.errores,
        },
      }, ctx.reloj.now());
      borrarFallosLlm(ctx.db, c.id, FASE_ANALISIS);
      registro.procesadas++;
      if (descarta) registro.descartadas++;
      for (const err of lectura.errores) registro.avisos.push(`Documento ilegible en ${c.id}: ${err}`);
    } catch (err) {
      if (esPresupuestoAgotado(err)) { registro.omitidasPorTope++; return; }
      fallo(ctx, registro, FASE_ANALISIS, c.id, err, 'Análisis');
    }
  });

  if (registro.omitidasPorTope > 0) {
    registro.avisos.push(`Tope de ${maxLlamadas} análisis por ejecución alcanzado: ${registro.omitidasPorTope} ${modo.nombre} quedan sin analizar (quedan pendientes para la próxima ejecución)`);
  }
  return registro;
}
