// Fase `empresas_dia_boe`: empresas con obligación legal de restaurar, a partir de las declaraciones (e informes) de impacto ambiental
// que MITECO publica en el BOE. Por ejecución:
//   1. Recorre los días de la ventana que aún no se han revisado del todo (hoy siempre se vuelve a mirar) y pide el sumario de cada uno.
//   2. Pre-filtro determinista por título (src/sources/boe.ts): DIA / informe de impacto ambiental de MITECO, sin correcciones de errores.
//   3. De cada resolución nueva (el id ya leído no se repite) se descarga el texto y Haiku extrae promotor, proyecto, provincia y las medidas
//      de restauración / revegetación / hábitat con cita literal. El CÓDIGO lo comprueba todo contra el texto: promotor y proyecto deben
//      aparecer en él, cada medida necesita una cita que esté (citaEnTexto) y el motivo de la empresa lo compone el código, no el modelo.
//   4. Resolución desfavorable (el proyecto no se ejecuta: no hay obligación), sin promotor empresa o sin ninguna medida con cita comprobada → no hay empresa. Con ellas → la empresa (unida por CIF o nombre normalizado)
//      y una señal por cada DIA.
// Fallos de red/LLM en una resolución: se anotan y se reintenta en la siguiente ejecución (no se marca como leída). Un día solo se da por
// revisado si todas sus resoluciones se leyeron. No se leen webs de empresas ni se guardan personas de contacto.
import type { DatabaseSync } from 'node:sqlite';
import { diaLocal, sumarDias } from '../dates.ts';
import { diaRevisado, esEntidadJuridica, marcarDiaRevisado, marcarResolucion, registrarSenal, resolucionProcesada } from '../db/empresas.ts';
import { type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import type { Llm } from '../llm/llm.ts';
import { ESQUEMA_DIA, ETIQUETA_MEDIDA_DIA, promptDia, TIPOS_MEDIDA_DIA, type TipoMedidaDia } from '../llm/prompts.ts';
import { enlaceBoe, type ItemBoe, sumarioDia, textoResolucion } from '../sources/boe.ts';
import { citaEnTexto, normalizarParaCita } from '../texto.ts';
import type { Reloj } from '../types.ts';
import { aCache, claveCache, desdeCache, esPresupuestoAgotado, llamar } from './comun.ts';

export const FASE_EMPRESAS = 'empresas_dia_boe';

export interface ConfigEmpresas {
  /** Días hacia atrás (hoy incluido) que se revisan; los ya revisados no se repiten, así que tras la primera vez solo cuenta lo nuevo. */
  diasAtras: number;
  /** Tope de resoluciones leídas con el LLM por ejecución; el resto queda para la siguiente. */
  maxResoluciones: number;
  /** Pausa entre peticiones al BOE, en ms. */
  pausaMs: number;
  /** Texto máximo de una resolución que se pasa al LLM (se conservan el principio y, sobre todo, el final, donde están las condiciones). */
  maxCaracteres: number;
  timeoutMs: number;
}

export const CONFIG_EMPRESAS_POR_DEFECTO: ConfigEmpresas = { diasAtras: 60, maxResoluciones: 40, pausaMs: 300, maxCaracteres: 150_000, timeoutMs: 30_000 };

export interface ResumenEmpresas {
  diasRevisados: number;
  /** Resoluciones DIA/informe que pasan el pre-filtro de título y aún no se habían leído. */
  resolucionesNuevas: number;
  leidas: number;
  conMedidas: number;
  sinMedidas: number;
  /** Declaraciones desfavorables: el proyecto no se ejecuta, no hay obligación. */
  desfavorables: number;
  sinPromotor: number;
  empresasNuevas: number;
  senales: number;
  omitidasPorTope: number;
  fase: RegistroFase;
  errores: string[];
}

export interface ContextoEmpresas {
  db: DatabaseSync;
  fetch: typeof fetch;
  reloj: Reloj;
  /** null = sin LLM: la fase se salta con un aviso. */
  llm: Llm | null;
  modelo: string;
  dormir?: (ms: number) => Promise<void>;
}

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_NOMBRE = 200;
const MAX_PROYECTO = 200;
const MAX_CITA = 600;
const MAX_MEDIDAS = 5;
const CIF = /^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/;
const PROVINCIA = /^[\p{L}][\p{L} ,.'\-/()]{1,59}$/u;
/** Administraciones y entidades que no son empresas a las que escribir (el promotor de muchas obras públicas). */
const NO_EMPRESA = /\b(ministerio|ayuntamiento|diputaci[oó]n|confederaci[oó]n hidrogr[aá]fica|comunidad de regantes|junta de|xunta|generalitat|gobierno de|consejer[ií]a|direcci[oó]n general|autoridad portuaria|puertos del estado|adif|aena|universidad|mancomunidad|consorcio)\b/i;

/** Quita ángulos y saltos de línea: lo que sale del texto no puede cerrar etiquetas de otros prompts ni romper la línea del motivo. */
const limpio = (t: string) => t.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();

export interface DatosDia {
  promotor: string;
  cif: string | null;
  proyecto: string | null;
  provincia: string | null;
  medidas: { tipo: TipoMedidaDia; cita: string }[];
}

/**
 * Valida la respuesta del modelo contra el texto enviado. Resolución desfavorable (no impone nada) → 'desfavorable'. Sin medidas con cita comprobada → 'sin_medidas'; con medidas pero sin un promotor que
 * sea una empresa citada en el texto → 'sin_promotor'. Lanza si la forma de la respuesta es imposible (no se cachea, se reintenta).
 */
export function validarDia(datos: unknown, texto: string): DatosDia | 'sin_medidas' | 'sin_promotor' | 'desfavorable' {
  const o = (datos ?? {}) as Record<string, unknown>;
  if (typeof o.promotor !== 'string' || !Array.isArray(o.medidas)) throw new Error('La extracción no devolvió promotor y medidas');
  const norm = normalizarParaCita(texto);
  const s = (k: string) => (typeof o[k] === 'string' ? limpio(o[k] as string) : '');
  const aparece = (t: string) => t.length >= 3 && norm.includes(normalizarParaCita(t).replace(/^["'.…\s]+|["'.…\s]+$/g, ''));

  if (o.sentido === 'desfavorable') return 'desfavorable';
  const medidas: DatosDia['medidas'] = [];
  for (const m of o.medidas.slice(0, MAX_MEDIDAS)) {
    const x = (m ?? {}) as Record<string, unknown>;
    const cita = typeof x.cita === 'string' ? x.cita.trim() : '';
    if (!(TIPOS_MEDIDA_DIA as readonly string[]).includes(x.tipo as string) || !cita || cita.length > MAX_CITA || !citaEnTexto(cita, norm)) continue;
    medidas.push({ tipo: x.tipo as TipoMedidaDia, cita });
  }
  if (medidas.length === 0) return 'sin_medidas';
  const promotor = s('promotor');
  if (!promotor || promotor.length > MAX_NOMBRE || NO_EMPRESA.test(promotor) || !aparece(promotor)) return 'sin_promotor';
  const cifBruto = s('cif').replace(/[\s.-]/g, '').toUpperCase();
  const cif = CIF.test(cifBruto) && norm.replace(/[\s.-]/g, '').toUpperCase().includes(cifBruto) ? cifBruto : null;
  // Solo personas jurídicas: ni un nombre de persona ni un DNI/NIE llegan a la BD, a la web pública ni al correo.
  if (!esEntidadJuridica(promotor, cif)) return 'sin_promotor';
  // Orden de importancia para el motivo y la cita de la empresa: la primera es la más cercana a lo que hace Reforesta.
  medidas.sort((a, b) => TIPOS_MEDIDA_DIA.indexOf(a.tipo) - TIPOS_MEDIDA_DIA.indexOf(b.tipo));
  const proyecto = s('proyecto');
  const provincia = s('provincia');
  return {
    promotor, cif,
    proyecto: proyecto && proyecto.length <= MAX_PROYECTO && aparece(proyecto) ? proyecto : null,
    provincia: PROVINCIA.test(provincia) ? provincia : null,
    medidas,
  };
}

/** Una línea compuesta por el código a partir de lo comprobado (nada de texto libre del modelo). */
export function motivoDia(d: DatosDia, tipoDia: 'declaración' | 'informe'): string {
  const una = tipoDia === 'informe' ? 'un informe' : 'una declaración';
  const otras = new Set(d.medidas.map((m) => ETIQUETA_MEDIDA_DIA[m.tipo]));
  return limpio(`Obligada por ${una} de impacto ambiental a ${[...otras].join(' y ')}${d.proyecto ? ` («${d.proyecto}»)` : ''}`).slice(0, 300);
}

/** Recorta un texto largo conservando el principio y el final (donde están las condiciones al proyecto). */
export function recortar(texto: string, max: number): { texto: string; recortado: boolean } {
  if (texto.length <= max) return { texto, recortado: false };
  const cabeza = Math.min(30_000, Math.floor(max / 4));
  return { texto: `${texto.slice(0, cabeza)}\n[… texto omitido …]\n${texto.slice(texto.length - (max - cabeza))}`, recortado: true };
}

export async function recogerEmpresasDia(ctx: ContextoEmpresas, cfg: ConfigEmpresas = CONFIG_EMPRESAS_POR_DEFECTO): Promise<ResumenEmpresas> {
  const { db } = ctx;
  const ahora = ctx.reloj.now();
  const hoy = diaLocal(ahora);
  const dormir = ctx.dormir ?? dormirReal;
  const fase = registroFaseVacio(FASE_EMPRESAS, ctx.modelo);
  const r: ResumenEmpresas = {
    diasRevisados: 0, resolucionesNuevas: 0, leidas: 0, conMedidas: 0, sinMedidas: 0, desfavorables: 0, sinPromotor: 0, empresasNuevas: 0, senales: 0, omitidasPorTope: 0, fase, errores: [],
  };
  if (!ctx.llm) {
    fase.avisos.push('Sin LLM configurado (falta ANTHROPIC_API_KEY): empresas de las DIA del BOE omitidas en esta ejecución');
    return r;
  }
  let peticiones = 0;
  let sinPresupuesto = false; // agotado el presupuesto de LLM de la ejecución: no se descargan más resoluciones
  const pausa = async () => { if (peticiones++ > 0 && cfg.pausaMs > 0) await dormir(cfg.pausaMs); };

  // De más antiguo a más reciente: los ids de las empresas siguen el orden del BOE.
  for (let i = cfg.diasAtras - 1; i >= 0; i--) {
    const dia = sumarDias(hoy, -i);
    if (dia < hoy && diaRevisado(db, dia)) continue;
    let items: ItemBoe[];
    try {
      await pausa();
      items = await sumarioDia(ctx.fetch, dia, cfg.timeoutMs);
    } catch (e) {
      r.errores.push((e as Error).message);
      continue;
    }
    let completo = true;
    for (const item of items) {
      if (resolucionProcesada(db, item.id)) continue;
      r.resolucionesNuevas++;
      if (sinPresupuesto || fase.llamadas + fase.desdeCache >= cfg.maxResoluciones) { r.omitidasPorTope++; completo = false; continue; }
      try {
        await pausa();
        await leerResolucion(ctx, cfg, item, dia, r);
      } catch (e) {
        completo = false;
        if (esPresupuestoAgotado(e)) { r.omitidasPorTope++; sinPresupuesto = true; continue; }
        const m = `${item.id}: ${(e as Error).message}`;
        r.errores.push(m);
        fase.errores.push(m);
      }
    }
    if (completo) {
      marcarDiaRevisado(db, dia, ahora);
      r.diasRevisados++;
    }
  }
  if (r.omitidasPorTope) fase.omitidasPorTope = r.omitidasPorTope;
  fase.procesadas = r.leidas;
  fase.descartadas = r.sinMedidas + r.sinPromotor + r.desfavorables;
  return r;
}

async function leerResolucion(ctx: ContextoEmpresas, cfg: ConfigEmpresas, item: ItemBoe, dia: string, r: ResumenEmpresas): Promise<void> {
  const { db } = ctx;
  const ahora = ctx.reloj.now();
  const completo = await textoResolucion(ctx.fetch, item.id, cfg.timeoutMs);
  const { texto, recortado } = recortar(completo, cfg.maxCaracteres);
  if (recortado) r.fase.avisos.push(`${item.id}: ${completo.length} caracteres, se leen ${texto.length}`);
  const { sistema, mensaje } = promptDia(item.titulo, texto);
  const peticion = { tarea: 'extraccion' as const, modelo: ctx.modelo, sistema, mensaje, esquema: ESQUEMA_DIA, maxTokens: 3000 };
  const clave = claveCache(peticion);
  const fctx = { db, llm: ctx.llm!, reloj: ctx.reloj, fetch: ctx.fetch };
  const resp = desdeCache(db, clave) ?? (await llamar(fctx, r.fase, peticion));
  if (resp.desdeCache) r.fase.desdeCache++;
  const datos = validarDia(resp.datos, texto);
  aCache(fctx, clave, resp); // solo si la respuesta era válida (validarDia lanza ante una forma imposible)
  r.leidas++;
  if (typeof datos === 'string') {
    marcarResolucion(db, item.id, item.fecha || dia, item.titulo, datos, ahora);
    if (datos === 'sin_promotor') r.sinPromotor++; else if (datos === 'desfavorable') r.desfavorables++; else r.sinMedidas++;
    return;
  }
  const enlace = enlaceBoe(item.id);
  const tipoDia = /informe de impacto ambiental/i.test(item.titulo) ? 'informe' : 'declaración';
  const motivo = motivoDia(datos, tipoDia);
  const { nueva } = registrarSenal(db, {
    nombre: datos.promotor, cif: datos.cif, origen: 'dia_boe', motivo, cita: datos.medidas[0].cita, provincia: datos.provincia,
    senal: { boeId: item.id, titulo: item.titulo, proyecto: datos.proyecto, provincia: datos.provincia, medidas: datos.medidas, enlace, fechaPublicacion: item.fecha || dia },
  }, ahora);
  marcarResolucion(db, item.id, item.fecha || dia, item.titulo, 'con_medidas', ahora);
  r.conMedidas++;
  r.senales++;
  if (nueva) r.empresasNuevas++;
}

