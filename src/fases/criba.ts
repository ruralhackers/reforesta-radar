// Fase `criba_llm` (Haiku): para cada candidata de las reglas sin veredicto, "puede encajar / descartar + motivo".
// Solo usa los textos que la fuente ya trae (extracto, ficha); no descarga documentos. Las de otra comunidad llevan
// la condición de las reglas: si exigen sede o actividad allí, se descartan.
import { borrarFallosLlm, guardarFase, pendientesDeFase, type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { versionCriba } from '../perfil.ts';
import { ESQUEMA_CRIBA, promptCriba } from '../llm/prompts.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import type { Convocatoria, Perfil } from '../types.ts';
import { aCache, type ContextoFase, claveCache, desdeCache, enParalelo, esPresupuestoAgotado, fallo, llamar, validarRespuesta } from './comun.ts';

export const FASE_CRIBA = 'criba_llm';
const EN_PARALELO = 4;

export interface VeredictoCriba {
  decision: 'puede_encajar' | 'descartar';
  motivo: string;
  exigeSedeEnOtraComunidad: 'si' | 'no' | 'no_consta' | 'no_aplica';
}

function validar(d: unknown): VeredictoCriba {
  const o = (d ?? {}) as Record<string, unknown>;
  if (o.decision !== 'puede_encajar' && o.decision !== 'descartar') throw new Error(`decisión no válida: ${JSON.stringify(o.decision)}`);
  if (typeof o.motivo !== 'string' || !o.motivo.trim()) throw new Error('criba sin motivo');
  const sede = ['si', 'no', 'no_consta', 'no_aplica'].includes(o.exigeSedeEnOtraComunidad as string)
    ? (o.exigeSedeEnOtraComunidad as VeredictoCriba['exigeSedeEnOtraComunidad']) : 'no_consta';
  return { decision: o.decision, motivo: o.motivo.trim(), exigeSedeEnOtraComunidad: sede };
}

export function textosSinDescarga(c: Convocatoria, fuentes?: Fuente[]) {
  const docs = fuentePorNombre(c.fuente, fuentes)?.documentos?.(c) ?? [];
  const textos = docs.flatMap((d) => (d.texto !== undefined ? [{ titulo: d.titulo, texto: d.texto }] : []));
  return textos.length ? textos : [{ titulo: 'Ficha', texto: c.titulo }];
}

/** La petición exacta que la criba hace para una convocatoria (la usa también el backtest para estimar coste y mirar la caché sin llamar). */
export function peticionCriba(
  perfil: Perfil, c: Convocatoria, condicion: string | null, modelo: string, ejemplos: ContextoFase['ejemplos'], fuentes?: Fuente[], experiencia?: string,
) {
  const { sistema, mensaje } = promptCriba(perfil, c, condicion, textosSinDescarga(c, fuentes), ejemplos, experiencia);
  return { tarea: 'criba' as const, modelo, sistema, mensaje, esquema: ESQUEMA_CRIBA, maxTokens: 4000 };
}

export async function cribarConLlm(
  ctx: ContextoFase, perfil: Perfil, modelo: string, publicadasDesde: string, fuentes?: Fuente[],
): Promise<RegistroFase> {
  const registro = registroFaseVacio(FASE_CRIBA, modelo);
  const pendientes = pendientesDeFase(ctx.db, FASE_CRIBA, publicadasDesde, null, { incluirIds: ctx.incluirIds, soloIncluidas: ctx.soloIncluidas, maxIntentos: ctx.maxIntentos });
  await enParalelo(pendientes, EN_PARALELO, async ({ convocatoria: c, condicion }) => {
    try {
      const peticion = peticionCriba(perfil, c, condicion, modelo, c.fuente === 'placsp' ? ctx.ejemplosLicitaciones : ctx.ejemplos, fuentes, ctx.experiencia);
      const clave = claveCache(peticion);
      const r = desdeCache(ctx.db, clave) ?? (await llamar(ctx, registro, peticion));
      if (r.desdeCache) registro.desdeCache++;
      const v = validarRespuesta(() => validar(r.datos));
      aCache(ctx, clave, r);
      const porSede = condicion !== null && v.exigeSedeEnOtraComunidad === 'si';
      const descarta = v.decision === 'descartar' || porSede;
      const motivo = porSede && v.decision !== 'descartar' ? `Limita el proyecto a territorios fuera del ámbito: ${v.motivo}` : v.motivo;
      guardarFase(ctx.db, {
        convocatoriaId: c.id, fase: FASE_CRIBA, descarta, motivo,
        datos: { modelo: r.modelo, ...v, condicion, desdeCache: r.desdeCache, versionPerfil: versionCriba(perfil) },
      }, ctx.reloj.now());
      borrarFallosLlm(ctx.db, c.id, FASE_CRIBA);
      registro.procesadas++;
      if (descarta) registro.descartadas++;
    } catch (e) {
      if (esPresupuestoAgotado(e)) { registro.omitidasPorTope++; return; }
      fallo(ctx, registro, FASE_CRIBA, c.id, e, 'Criba');
    }
  });
  return registro;
}
