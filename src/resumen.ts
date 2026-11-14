// Operación del motor "enviar resumen": compone el correo del lunes con lo que muestra "Esta semana" y lo envía con el emisor inyectado.
// Idempotente por semana ISO: una segunda ejecución la misma semana no envía salvo `forzar`. Cada envío (o fallo) queda en `envios_resumen`.
import type { DatabaseSync } from 'node:sqlite';
import { diaLocal, lunesDeLaSemana, semanaIso } from './dates.ts';
import { componerCorreo, itemCorreo, type EntradaItem, type ResumenCorreo, type SeccionCorreo } from './correo.ts';
import { config } from './config.ts';
import { leerFases } from './db/repo.ts';
import { FASE_ANALISIS } from './fases/analisis.ts';
import type { Analisis } from './fases/analisis-esquema.ts';
import { crearProbabilidad } from './ganadores.ts';
import type { Emisor } from './mailer.ts';
import { type ConfigPuntuacion, leerConfigPuntuacion, type ProveedorProbabilidad } from './puntuacion.ts';
import { seccionParecidas } from './ranking.ts';
import { calcularRanking } from './semana.ts';
import type { Reloj } from './types.ts';

export interface ConfigResumen {
  destinatarios: string[];
  remitente: string;
  /** URL pública de la web para los enlaces. null = sin configurar: la vista previa usa enlaces relativos y el envío se niega. */
  urlPublica: string | null;
}

export interface DependenciasResumen {
  db: DatabaseSync;
  reloj: Reloj;
  /** null/ausente con destinatarios = error (falta RESEND_API_KEY). */
  emisor?: Emisor | null;
  config?: ConfigResumen;
  puntuacion?: ConfigPuntuacion;
  probabilidad?: ProveedorProbabilidad;
  /**
   * Punto de extensión: secciones que se añaden al final del correo ("Empresas nuevas de la semana", src/correo-empresas.ts, lo enchufa el CLI).
   * Recibe la BD y el día de hoy; devuelve SeccionCorreo[] con enlaces ya completos. Si hay secciones con contenido, el correo se envía aunque no
   * haya convocatorias que contar.
   */
  seccionesExtra?: (ctx: { db: DatabaseSync; hoy: string; urlPublica: string }) => SeccionCorreo[];
  log?: (mensaje: string) => void;
}

export interface OpcionesResumen {
  /** Enviar aunque esta semana ISO ya se haya enviado. */
  forzar?: boolean;
}

export type ResultadoResumen =
  | { estado: 'enviado'; semana: string; destinatarios: number; convocatorias: string[]; proveedorId: string | null; correo: ResumenCorreo }
  | { estado: 'sin_destinatarios' | 'ya_enviado' | 'sin_novedades'; semana: string };

const MAX_DESTACADAS = 5;
const MAX_CIERRAN = 5;
const MAX_PARECIDAS = 5;

/** Compone el correo sin enviar ni registrar nada (la vista previa y `enviarResumen` usan lo mismo). */
export function prepararResumen(deps: Pick<DependenciasResumen, 'db' | 'reloj' | 'puntuacion' | 'probabilidad' | 'seccionesExtra'>, cfgResumen: Pick<ConfigResumen, 'urlPublica'>): { correo: ResumenCorreo; convocatorias: string[]; semana: string; extras: number } {
  const { db, reloj } = deps;
  const ahora = reloj.now();
  const hoy = diaLocal(ahora);
  const cfg = deps.puntuacion ?? leerConfigPuntuacion(config.rutaPuntuacion);
  const urlPublica = cfgResumen.urlPublica ?? '';
  const ranking = calcularRanking(db, ahora, cfg, deps.probabilidad ?? crearProbabilidad(db));
  const entrada = (f: (typeof ranking)[number]): EntradaItem => {
    const datos = leerFases(db, f.id).find((v) => v.fase === FASE_ANALISIS)?.datos as { analisis?: Analisis } | undefined;
    return { id: f.id, titulo: f.titulo, organo: f.organo, puntuacion: f.puntuacion, plazo: f.plazo, analisis: datos?.analisis ?? null };
  };
  const usadas = new Set<string>();
  const tomar = (filas: typeof ranking, max: number) => {
    const r = filas.filter((f) => !usadas.has(f.id)).slice(0, max);
    for (const f of r) usadas.add(f.id);
    return r.map((f) => itemCorreo(entrada(f), urlPublica));
  };

  // Destacadas: las de mayor puntuación de cualquier sección. Cierran pronto: las que faltan, por fecha de cierre. Parecidas: las que faltan.
  const destacadas = tomar([...ranking].sort((a, b) => (b.puntuacion?.total ?? -1) - (a.puntuacion?.total ?? -1)), MAX_DESTACADAS);
  const cierranTodas = ranking.filter((f) => f.seccion === 'cierran_pronto');
  const cierran = tomar([...cierranTodas].sort((a, b) => (a.plazo?.fechaCierre ?? '9999').localeCompare(b.plazo?.fechaCierre ?? '9999')), MAX_CIERRAN);
  const parecidas = tomar(seccionParecidas(ranking), MAX_PARECIDAS);

  const extras = deps.seccionesExtra?.({ db, hoy, urlPublica }) ?? [];
  const secciones: SeccionCorreo[] = [
    { titulo: 'Destacadas de la semana', items: destacadas },
    { titulo: 'Cierran pronto', intro: `Plazo de ${cfg.cierranProntoDias} días o menos.`, items: cierran },
    { titulo: 'Las ganan organizaciones como vosotros', intro: 'Convocatorias que ya han ganado organizaciones parecidas a Reforesta.', items: parecidas },
    ...extras,
  ];
  const correo = componerCorreo({ hoy, lunes: lunesDeLaSemana(hoy), total: usadas.size, cierranPronto: cierranTodas.length, secciones, urlPublica });
  return { correo, convocatorias: [...usadas], semana: semanaIso(hoy), extras: extras.reduce((n, x) => n + x.items.length, 0) };
}

export async function enviarResumen(deps: DependenciasResumen, opciones: OpcionesResumen = {}): Promise<ResultadoResumen> {
  const { db, reloj } = deps;
  const log = deps.log ?? (() => {});
  const cfg = deps.config ?? config.resumen;
  const semana = semanaIso(diaLocal(reloj.now()));

  if (!cfg.destinatarios.length) {
    log('Sin destinatarios (RADAR_DIGEST_DESTINATARIOS): no se envía nada');
    return { estado: 'sin_destinatarios', semana };
  }
  if (!deps.emisor) throw new Error('Hay destinatarios pero falta RESEND_API_KEY: no se puede enviar el resumen');
  if (!cfg.urlPublica) throw new Error('Hay destinatarios pero falta RADAR_URL_PUBLICA (la URL pública de esta instancia, p. ej. https://radar.tu-dominio.org): sin ella los enlaces del correo no llevarían a ninguna parte');
  if (!opciones.forzar && db.prepare('SELECT 1 FROM envios_resumen WHERE semana = ? AND error IS NULL').get(semana)) {
    log(`El resumen de ${semana} ya se envió; usa --forzar para repetirlo`);
    return { estado: 'ya_enviado', semana };
  }

  const { correo, convocatorias, extras } = prepararResumen(deps, cfg);
  if (!convocatorias.length && !extras) {
    log('Nada que contar esta semana: no se envía');
    return { estado: 'sin_novedades', semana };
  }
  const registrar = (proveedorId: string | null, error: string | null) => db.prepare(
    'INSERT INTO envios_resumen (semana, enviado_en, destinatarios, convocatorias, proveedor_id, error) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(semana, reloj.now().toISOString(), cfg.destinatarios.length, JSON.stringify(convocatorias), proveedorId, error);
  try {
    const { id } = await deps.emisor.enviar({ de: cfg.remitente, para: cfg.destinatarios, asunto: correo.asunto, html: correo.html, texto: correo.texto });
    registrar(id, null);
    log(`Resumen ${semana} enviado a ${cfg.destinatarios.length} destinatarios (${convocatorias.length} convocatorias)${id ? `, id ${id}` : ''}`);
    return { estado: 'enviado', semana, destinatarios: cfg.destinatarios.length, convocatorias, proveedorId: id, correo };
  } catch (e) {
    registrar(null, (e as Error).message);
    throw e;
  }
}
