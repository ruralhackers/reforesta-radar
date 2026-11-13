// Fase `analisis` (Sonnet): las que pasaron la criba se leen a fondo (extracto + documentos + bases, PDF → texto)
// y se extraen los campos con cita literal (ver analisis-esquema.ts). Tope de llamadas reales por ejecución:
// al alcanzarlo, las que faltan se quedan sin análisis (se reintentan en la siguiente mientras estén dentro de
// `diasPendientes`) y se registra.
import { guardarFase, pendientesDeFase, type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { leerDocumentos } from '../documentos.ts';
import { promptAnalisis } from '../llm/prompts.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import type { Perfil } from '../types.ts';
import { aplicarCitas, esquemaAnalisis } from './analisis-esquema.ts';
import { aCache, type ContextoFase, claveCache, desdeCache, enParalelo, llamar } from './comun.ts';
import { FASE_CRIBA } from './criba.ts';

export const FASE_ANALISIS = 'analisis';
const EN_PARALELO = 2;

export async function analizarConLlm(
  ctx: ContextoFase, perfil: Perfil, modelo: string, maxLlamadas: number, publicadasDesde: string, fuentes?: Fuente[],
): Promise<RegistroFase> {
  const registro = registroFaseVacio(FASE_ANALISIS, modelo);
  const pendientes = pendientesDeFase(ctx.db, FASE_ANALISIS, publicadasDesde, FASE_CRIBA);
  const esquema = esquemaAnalisis(perfil);
  let reservadas = 0; // llamadas reales comprometidas (se cuenta antes de esperar, por el paralelismo)

  await enParalelo(pendientes, EN_PARALELO, async ({ convocatoria: c }) => {
    try {
      const docs = fuentePorNombre(c.fuente, fuentes)?.documentos?.(c) ?? [{ titulo: 'Ficha', url: c.url, texto: c.titulo }];
      const lectura = await leerDocumentos(ctx.db, ctx.fetch, docs, ctx.reloj.now());
      if (lectura.erroresTransitorios.length) {
        // Sin todos los textos el análisis saldría con importes o plazos "desconocido" para siempre:
        // no se llama al LLM ni se guarda veredicto; queda pendiente para la próxima ejecución.
        registro.errores.push(`Análisis ${c.id} aplazado, documentos no disponibles ahora: ${lectura.erroresTransitorios.join(' · ')}`);
        return;
      }
      const { sistema, mensaje } = promptAnalisis(perfil, c, lectura.textos);
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
      const analisis = aplicarCitas(r.datos, lectura.textos, perfil);
      aCache(ctx, clave, r);
      const e = analisis.elegibilidadEsfl;
      const descarta = e.valor === 'no';
      guardarFase(ctx.db, {
        convocatoriaId: c.id, fase: FASE_ANALISIS, descarta,
        motivo: descarta ? `No admite entidades sin ánimo de lucro: «${e.cita}»` : null,
        datos: {
          modelo: r.modelo, desdeCache: r.desdeCache, analisis,
          documentos: lectura.textos.map((t) => ({ titulo: t.titulo, caracteres: t.texto.length })),
          documentosConError: lectura.errores,
        },
      }, ctx.reloj.now());
      registro.procesadas++;
      if (descarta) registro.descartadas++;
      for (const err of lectura.errores) registro.avisos.push(`Documento ilegible en ${c.id}: ${err}`);
    } catch (err) {
      registro.errores.push(`Análisis ${c.id}: ${(err as Error).message}`);
    }
  });

  if (registro.omitidasPorTope > 0) {
    registro.avisos.push(`Tope de ${maxLlamadas} análisis por ejecución alcanzado: ${registro.omitidasPorTope} convocatorias quedan sin analizar (quedan pendientes para la próxima ejecución)`);
  }
  return registro;
}
