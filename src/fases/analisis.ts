// Fase `analisis` (Sonnet): las que pasaron la criba se leen a fondo (extracto + documentos + bases, PDF → texto)
// y se extraen los campos con cita literal (ver analisis-esquema.ts). Tope de llamadas reales por ejecución:
// al alcanzarlo, las que faltan se quedan sin análisis (se reintentan en la siguiente mientras estén dentro de
// `diasPendientes`) y se registra.
import { borrarFallosLlm, guardarFase, pendientesDeFase, type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { leerDocumentos } from '../documentos.ts';
import { textoGanadoresParaPrompt } from '../ganadores.ts';
import { promptAnalisis, recortarTextos } from '../llm/prompts.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import { versionLineas } from '../perfil.ts';
import type { Perfil } from '../types.ts';
import { CONFIG_LLM_POR_DEFECTO } from '../llm/llm.ts';
import { aplicarCitas, esquemaAnalisis } from './analisis-esquema.ts';
import { aCache, type ContextoFase, claveCache, desdeCache, enParalelo, esPresupuestoAgotado, fallo, llamar, validarRespuesta } from './comun.ts';
import { FASE_CRIBA } from './criba.ts';

export const FASE_ANALISIS = 'analisis';
const EN_PARALELO = 2;

export async function analizarConLlm(
  ctx: ContextoFase, perfil: Perfil, modelo: string, maxLlamadas: number, publicadasDesde: string, fuentes?: Fuente[],
  maxCaracteres: number = CONFIG_LLM_POR_DEFECTO.maxCaracteresAnalisis,
): Promise<RegistroFase> {
  const registro = registroFaseVacio(FASE_ANALISIS, modelo);
  const pendientes = pendientesDeFase(ctx.db, FASE_ANALISIS, publicadasDesde, FASE_CRIBA, { incluirIds: ctx.incluirIds, soloIncluidas: ctx.soloIncluidas, maxIntentos: ctx.maxIntentos });
  const esquema = esquemaAnalisis(perfil);
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
      const { sistema, mensaje } = promptAnalisis(perfil, c, textos, textoGanadoresParaPrompt(ctx.db, c, perfil), ctx.ejemplos);
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
      const analisis = validarRespuesta(() => aplicarCitas(datos, textos, perfil));
      aCache(ctx, clave, r);
      const e = analisis.elegibilidadEsfl;
      const s = analisis.elegibilidadSede;
      const sedeNo = s?.valor === 'no';
      const descarta = e.valor === 'no' || sedeNo;
      guardarFase(ctx.db, {
        convocatoriaId: c.id, fase: FASE_ANALISIS, descarta,
        motivo: sedeNo ? `${s.razon ?? 'Exige sede o inscripción en otro territorio'}: «${s.cita}»` : descarta ? `No admite entidades sin ánimo de lucro: «${e.cita}»` : null,
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
    registro.avisos.push(`Tope de ${maxLlamadas} análisis por ejecución alcanzado: ${registro.omitidasPorTope} convocatorias quedan sin analizar (quedan pendientes para la próxima ejecución)`);
  }
  return registro;
}
