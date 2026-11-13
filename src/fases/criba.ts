// Fase `criba_llm` (Haiku): para cada candidata de las reglas sin veredicto, "puede encajar / descartar + motivo".
// Solo usa los textos que la fuente ya trae (extracto, ficha); no descarga documentos. Las de otra comunidad llevan
// la condición de las reglas: si exigen sede o actividad allí, se descartan.
import { guardarFase, pendientesDeFase, type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { ESQUEMA_CRIBA, promptCriba } from '../llm/prompts.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import type { Convocatoria, Perfil } from '../types.ts';
import { aCache, type ContextoFase, claveCache, desdeCache, enParalelo, llamar } from './comun.ts';

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

export async function cribarConLlm(
  ctx: ContextoFase, perfil: Perfil, modelo: string, vistasDesde: Date, fuentes?: Fuente[],
): Promise<RegistroFase> {
  const registro = registroFaseVacio(FASE_CRIBA, modelo);
  const pendientes = pendientesDeFase(ctx.db, FASE_CRIBA, vistasDesde);
  await enParalelo(pendientes, EN_PARALELO, async ({ convocatoria: c, condicion }) => {
    try {
      const { sistema, mensaje } = promptCriba(perfil, c, condicion, textosSinDescarga(c, fuentes));
      const peticion = { tarea: 'criba' as const, modelo, sistema, mensaje, esquema: ESQUEMA_CRIBA, maxTokens: 4000 };
      const clave = claveCache(peticion);
      const r = desdeCache(ctx.db, clave) ?? (await llamar(ctx, registro, peticion));
      if (r.desdeCache) registro.desdeCache++;
      const v = validar(r.datos);
      aCache(ctx, clave, r);
      const porSede = condicion !== null && v.exigeSedeEnOtraComunidad === 'si';
      const descarta = v.decision === 'descartar' || porSede;
      const motivo = porSede && v.decision !== 'descartar' ? `Exige sede o actividad en otra comunidad: ${v.motivo}` : v.motivo;
      guardarFase(ctx.db, {
        convocatoriaId: c.id, fase: FASE_CRIBA, descarta, motivo,
        datos: { modelo: r.modelo, ...v, condicion, desdeCache: r.desdeCache },
      }, ctx.reloj.now());
      registro.procesadas++;
      if (descarta) registro.descartadas++;
    } catch (e) {
      registro.errores.push(`Criba ${c.id}: ${(e as Error).message}`);
    }
  });
  return registro;
}
