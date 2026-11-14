// Fase `titulos_cortos` (Haiku): rellena el título corto de las convocatorias ya analizadas que no lo tienen (analizadas antes de que el análisis lo pidiera).
// Prompt mínimo con solo el título oficial; caché por hash y cuenta en el presupuesto de la ejecución. Sin título corto la web muestra el oficial legible.
import type { DatabaseSync } from 'node:sqlite';
import { borrarFallosLlm, type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import { ESQUEMA_TITULO, promptTituloCorto } from '../llm/prompts.ts';
import { validarTituloCorto } from '../titulo.ts';
import { aCache, type ContextoFase, claveCache, desdeCache, enParalelo, esPresupuestoAgotado, fallo, llamar, validarRespuesta } from './comun.ts';
import { FASE_ANALISIS } from './analisis.ts';

export const FASE_TITULOS = 'titulos_cortos';
const EN_PARALELO = 4;

/** Analizadas (con su análisis guardado) sin título corto, con su título oficial; las que ya agotaron sus intentos se saltan. */
export function sinTituloCorto(db: DatabaseSync, maxIntentos?: number): { id: string; titulo: string }[] {
  const filas = db.prepare(`
    SELECT c.id AS id, c.titulo AS titulo, f.datos AS datos
    FROM convocatoria_fases f JOIN convocatorias c ON c.id = f.convocatoria_id
    WHERE f.fase = ? AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM llm_fallos lf WHERE lf.convocatoria_id = c.id AND lf.fase = ? AND lf.intentos >= ?))
    ORDER BY c.fecha_publicacion DESC, c.id
  `).all(FASE_ANALISIS, maxIntentos ?? null, FASE_TITULOS, maxIntentos ?? null) as { id: string; titulo: string; datos: string }[];
  return filas.filter((f) => {
    const a = (JSON.parse(f.datos) as { analisis?: { tituloCorto?: string | null } }).analisis;
    return a !== undefined && !a.tituloCorto?.trim();
  }).map((f) => ({ id: f.id, titulo: f.titulo }));
}

export async function rellenarTitulosCortos(ctx: ContextoFase, modelo: string): Promise<RegistroFase> {
  const registro = registroFaseVacio(FASE_TITULOS, modelo);
  const leer = ctx.db.prepare('SELECT datos FROM convocatoria_fases WHERE convocatoria_id = ? AND fase = ?');
  const guardar = ctx.db.prepare('UPDATE convocatoria_fases SET datos = ? WHERE convocatoria_id = ? AND fase = ?');
  await enParalelo(sinTituloCorto(ctx.db, ctx.maxIntentos), EN_PARALELO, async ({ id, titulo }) => {
    try {
      const { sistema, mensaje } = promptTituloCorto(titulo);
      const peticion = { tarea: 'titulo' as const, modelo, sistema, mensaje, esquema: ESQUEMA_TITULO, maxTokens: 300 };
      const clave = claveCache(peticion);
      const r = desdeCache(ctx.db, clave) ?? (await llamar(ctx, registro, peticion));
      if (r.desdeCache) registro.desdeCache++;
      const corto = validarRespuesta(() => {
        const t = validarTituloCorto((r.datos as { tituloCorto?: unknown } | null)?.tituloCorto);
        if (!t) throw new Error('título corto no válido');
        return t;
      });
      aCache(ctx, clave, r);
      const fila = leer.get(id, FASE_ANALISIS) as { datos: string } | undefined;
      if (!fila) return;
      const datos = JSON.parse(fila.datos) as { analisis?: Record<string, unknown> };
      if (!datos.analisis) return;
      guardar.run(JSON.stringify({ ...datos, analisis: { ...datos.analisis, tituloCorto: corto } }), id, FASE_ANALISIS);
      borrarFallosLlm(ctx.db, id, FASE_TITULOS);
      registro.procesadas++;
    } catch (e) {
      if (esPresupuestoAgotado(e)) { registro.omitidasPorTope++; return; }
      fallo(ctx, registro, FASE_TITULOS, id, e, 'Título corto');
    }
  });
  return registro;
}
