// Fase `empresas_huella_carbono`: empresas del registro de huella de carbono del MITECO que pueden financiar proyectos de restauración.
// Por ejecución:
//   1. Baja los listados del registro (src/sources/huella.ts): huellas inscritas y compensaciones con proyectos de absorción. Si ninguno ha cambiado
//      desde que se recorrieron enteros, no se hace nada más.
//   2. Agrupa las filas por organización (NIF o nombre) y aplica un pre-filtro DETERMINISTA, sin LLM: solo personas jurídicas, medianas o grandes,
//      con huella reciente y que no sean administración. Dos niveles:
//        A (prioridad 2): compensa con proyectos de absorción (listado de compensaciones) o tiene el sello COMPENSO. Es el motivo concreto.
//        B (prioridad 1, baja confianza): gran empresa de un sector afín (config) en la zona del perfil (ámbito), sin compensación. Se guarda sin LLM
//        y no se muestra por defecto.
//   3. Solo las de nivel A llegan a Haiku: por prioridad y, de las que el registro no ha cambiado desde la última criba (hash de lo que dice de
//      ellas), solo `maxCribadas` por ejecución (el resto queda para la siguiente).
//   4. Haiku decide si es posible financiadora con un motivo de una línea (y puede degradarla: si cumple el nivel B pasa a B, si no se descarta);
//      el código compone el motivo con los datos del registro, la cita es el texto literal de la fila y la empresa se guarda con `registrarSenal`
//      (se une a las que ya vienen de una DIA por CIF o nombre).
import type { DatabaseSync } from 'node:sqlite';
import { claveEmpresa, esEntidadJuridica, PRIORIDAD_REGISTRO_COMPENSA, PRIORIDAD_REGISTRO_ZONA, bajarSenalRegistro, registrarSenal } from '../db/empresas.ts';
import { type RegistroFase, registroFaseVacio } from '../db/repo.ts';
import type { Llm } from '../llm/llm.ts';
import { ESQUEMA_HUELLA, promptHuella } from '../llm/prompts.ts';
import { descargarFichero, type FilaCompensacion, type FilaHuella, hash, leerListadoCompensacion, leerListadoHuella, textoCompensacion, textoFila, URL_COMPENSACION, URL_HUELLA } from '../sources/huella.ts';
import type { Perfil, Reloj } from '../types.ts';
import { aCache, claveCache, desdeCache, esPresupuestoAgotado, llamar } from './comun.ts';
import { diaLocal } from '../dates.ts';
import { enZona, sinAcentos, type Zona, zonaDePerfil } from '../zona.ts';

export { zonaDePerfil };

export const FASE_HUELLA = 'empresas_huella_carbono';

export interface ConfigHuella {
  /** Tope de organizaciones que se mandan al LLM por ejecución (las demás esperan a la siguiente). */
  maxCribadas: number;
  /** Cuántos años hacia atrás (desde el último año del registro) cuenta una huella como reciente. */
  aniosAtras: number;
  timeoutMs: number;
  maxBytes: number;
  /**
   * Letras CNAE de los sectores del registro que cuentan como afines para el nivel B (zona + sector sin compensación). Por defecto, las que más
   * impacto tienen sobre el medio natural: B industrias extractivas, D energía, E agua y residuos, F construcción, G comercio, H transporte.
   * Es un ajuste de la organización (RADAR_SECTORES_HUELLA, p. ej. "B,D,F"), no del código.
   */
  sectores: string[];
}

export const CONFIG_HUELLA_POR_DEFECTO: ConfigHuella = { maxCribadas: 50, aniosAtras: 3, timeoutMs: 60_000, maxBytes: 60 * 1024 * 1024, sectores: ['B', 'D', 'E', 'F', 'G', 'H'] };

export interface ResumenHuella {
  /** true = ningún fichero ha cambiado desde que se recorrieron enteros: no se ha hecho nada. */
  sinCambios: boolean;
  filasLeidas: number;
  compensacionesLeidas: number;
  organizaciones: number;
  /** Organizaciones que pasan el pre-filtro de código. */
  preFiltradas: number;
  /** De ellas, nivel B (solo zona y sector): se guardan sin LLM y quedan ocultas por defecto. */
  bajaConfianza: number;
  /** Pasan el pre-filtro pero el registro no ha cambiado desde su última criba. */
  yaCribadas: number;
  cribadas: number;
  financiadoras: number;
  descartadas: number;
  omitidasPorTope: number;
  empresasNuevas: string[];
  empresasUnidas: string[];
  fase: RegistroFase;
  errores: string[];
}

export interface ContextoHuella {
  db: DatabaseSync;
  fetch: typeof fetch;
  reloj: Reloj;
  llm: Llm | null;
  modelo: string;
  perfil: Perfil;
}

const CIF = /^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/;
const MAX_MOTIVO_LLM = 200;
const MAX_MOTIVO = 260;
/** Administración, educación, hogares y organismos extraterritoriales: no son empresas a las que pedir patrocinio. */
const SECTORES_EXCLUIDOS = new Set(['O', 'P', 'T', 'U']);
const TAMANOS = new Set(['gran empresa', 'mediana']);

const letraSector = (s: string) => /^([A-Z])\./.exec(s.trim())?.[1] ?? '';
const limpio = (t: string) => t.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
/** Sin la forma societaria final: para casar nombres de organizaciones entre los dos listados (el de compensaciones no trae NIF). */
const claveSinForma = (n: string) => claveEmpresa(n).replace(/ (slu|sau|sl|sa|sll|scoop)$/, '');

export interface Organizacion {
  /** NIF si es válido; si no, el nombre normalizado. */
  clave: string;
  nombre: string;
  cif: string | null;
  /** Más reciente primero. */
  filas: FilaHuella[];
  compensaciones: FilaCompensacion[];
}

export function agruparOrganizaciones(filas: FilaHuella[], compensaciones: FilaCompensacion[]): Organizacion[] {
  const porClave = new Map<string, Organizacion>();
  for (const f of filas) {
    const cif = CIF.test(f.nif) ? f.nif : null;
    const clave = cif ?? claveEmpresa(f.nombre);
    if (!clave) continue;
    const o = porClave.get(clave) ?? { clave, nombre: f.nombre, cif, filas: [], compensaciones: [] };
    o.filas.push(f);
    porClave.set(clave, o);
  }
  const porNombre = new Map<string, Organizacion[]>();
  for (const o of porClave.values()) {
    o.filas.sort((a, b) => b.anio - a.anio || b.inscrita.localeCompare(a.inscrita) || b.fila - a.fila);
    o.nombre = o.filas[0].nombre;
    for (const n of new Set(o.filas.map((f) => claveSinForma(f.nombre)))) porNombre.set(n, [...(porNombre.get(n) ?? []), o]);
  }
  for (const c of compensaciones) {
    // Solo si el nombre identifica a una única organización: un nombre ambiguo no se atribuye a ninguna.
    const candidatas = porNombre.get(claveSinForma(c.organizacion)) ?? [];
    if (candidatas.length === 1) candidatas[0].compensaciones.push(c);
  }
  for (const o of porClave.values()) o.compensaciones.sort((a, b) => b.fecha.localeCompare(a.fecha) || b.fila - a.fila);
  return [...porClave.values()];
}

export interface Evaluacion {
  pasa: boolean;
  /** A = compensa con proyectos de absorción o sello COMPENSO; B = solo zona y sector (baja confianza); null = no pasa. */
  nivel: 'A' | 'B' | null;
  /** Cumple los requisitos del nivel B (zona + sector + gran empresa), compense o no: a donde baja una A si el LLM la degrada. */
  cumpleB: boolean;
  /** Mayor = antes. Solo ordena; no decide. */
  prioridad: number;
  motivos: string[];
}

/** Pre-filtro determinista (sin LLM). `anioMax` = último año con huellas en el registro; `zona` = comunidades del perfil. */
export function evaluarOrganizacion(o: Organizacion, anioMax: number, cfg: Pick<ConfigHuella, 'aniosAtras'> & Partial<Pick<ConfigHuella, 'sectores'>>, zona: Zona): Evaluacion {
  const f = o.filas[0];
  const no = (m: string): Evaluacion => ({ pasa: false, nivel: null, cumpleB: false, prioridad: 0, motivos: [m] });
  if (f.anio < anioMax - cfg.aniosAtras) return no('huella antigua');
  if (!TAMANOS.has(sinAcentos(f.tamano))) return no('tamaño');
  if (SECTORES_EXCLUIDOS.has(letraSector(f.sector))) return no('sector');
  if (!esEntidadJuridica(o.nombre, o.cif)) return no('no es persona jurídica');
  const sectores = new Set(cfg.sectores ?? CONFIG_HUELLA_POR_DEFECTO.sectores);
  const compensaPorSello = o.filas.some((x) => /COMPENSO/i.test(x.sello));
  const compensaConProyecto = o.compensaciones.length > 0;
  const zonaOk = enZona(f.ccaa, zona);
  const sectorAfin = sectores.has(letraSector(f.sector));
  const grande = sinAcentos(f.tamano) === 'gran empresa';
  const cumpleB = zonaOk && sectorAfin && grande;
  const motivos: string[] = [];
  if (compensaConProyecto) motivos.push('compensa con proyectos de absorción');
  if (compensaPorSello) motivos.push('sello COMPENSO');
  if (motivos.length === 0 && !cumpleB) return no('sin compensación y fuera de zona o sector');
  if (motivos.length === 0) motivos.push('gran empresa de sector afín en la zona de la organización, sin compensación');
  const nivel = compensaConProyecto || compensaPorSello ? 'A' : 'B';
  const prioridad = (compensaConProyecto ? 4 : 0) + (compensaPorSello ? 2 : 0) + (grande ? 1 : 0) + (zonaOk ? 1 : 0) + (sectorAfin ? 1 : 0) + (o.filas.length > 1 ? 1 : 0);
  return { pasa: true, nivel, cumpleB, prioridad, motivos };
}

/** Lo que se muestra al LLM (y se hashea): la fila más reciente, la última con sello COMPENSO si es otra, y las últimas compensaciones. Texto literal del registro. */
export function evidenciaOrganizacion(o: Organizacion): { lineas: string[]; cita: string } {
  const filas = [o.filas[0]];
  const conCompenso = o.filas.find((x) => /COMPENSO/i.test(x.sello));
  if (conCompenso && conCompenso !== o.filas[0]) filas.push(conCompenso);
  const lineas = [...filas.map(textoFila), ...o.compensaciones.slice(0, 3).map(textoCompensacion)];
  const cita = [textoFila(o.filas[0]), ...(o.compensaciones[0] ? [textoCompensacion(o.compensaciones[0])] : [])].join(' // ');
  return { lineas, cita };
}

/** Respuesta del modelo → { financiador, motivo }. Lanza ante una forma imposible (no se cachea, se reintenta). */
export function validarHuella(datos: unknown): { financiador: boolean; motivo: string } {
  const o = (datos ?? {}) as Record<string, unknown>;
  if (typeof o.financiador !== 'boolean' || typeof o.motivo !== 'string') throw new Error('La criba no devolvió financiador y motivo');
  const motivo = limpio(o.motivo);
  if (o.financiador && (motivo.length < 10 || /https?:|www\./i.test(motivo))) throw new Error('Motivo de la criba vacío o con enlaces');
  // Un modelo pequeño se pasa de largo con frecuencia: se recorta en una palabra, no se descarta una respuesta por lo demás buena.
  return { financiador: o.financiador, motivo: motivo.length > MAX_MOTIVO_LLM ? `${motivo.slice(0, MAX_MOTIVO_LLM - 1).replace(/\s+\S*$/, '')}…` : motivo };
}

export function motivoHuella(o: Organizacion, motivoLlm: string): string {
  return limpio(`Registro de huella de carbono (MITECO), ${o.filas[0].anio}: ${motivoLlm}`).slice(0, MAX_MOTIVO);
}

/** Motivo de una de nivel B: lo dicen los datos, no el modelo. */
export const motivoBajaConfianza = (o: Organizacion) => limpio(`Registro de huella de carbono (MITECO), ${o.filas[0].anio}: ${o.filas[0].tamano.toLowerCase()} del sector ${o.filas[0].sector.replace(/^[A-Z]\.\s*/, '')} en ${o.filas[0].ccaa}; no consta compensación (baja confianza)`).slice(0, MAX_MOTIVO);

/** Versión de los criterios y del prompt de la criba: si cambia, lo ya cribado se vuelve a mirar. */
const VERSION_CRIBA = 'v2';

function firmaGuardada(db: DatabaseSync, url: string): { firma: string; completo: boolean } | null {
  const r = db.prepare('SELECT firma, completo FROM huella_ficheros WHERE url = ?').get(url) as { firma: string; completo: number } | undefined;
  return r ? { firma: r.firma, completo: r.completo === 1 } : null;
}

function guardarFirma(db: DatabaseSync, url: string, firma: string, completo: boolean, ahora: Date): void {
  db.prepare('INSERT OR REPLACE INTO huella_ficheros (url, firma, completo, revisado_en) VALUES (?, ?, ?, ?)').run(url, firma, completo ? 1 : 0, ahora.toISOString());
}

export async function recogerEmpresasHuella(ctx: ContextoHuella, cfg: ConfigHuella = CONFIG_HUELLA_POR_DEFECTO): Promise<ResumenHuella> {
  const { db } = ctx;
  const ahora = ctx.reloj.now();
  const fase = registroFaseVacio(FASE_HUELLA, ctx.modelo);
  const r: ResumenHuella = {
    sinCambios: false, filasLeidas: 0, compensacionesLeidas: 0, organizaciones: 0, preFiltradas: 0, bajaConfianza: 0, yaCribadas: 0, cribadas: 0, financiadoras: 0, descartadas: 0, omitidasPorTope: 0,
    empresasNuevas: [], empresasUnidas: [], fase, errores: [],
  };
  if (!ctx.llm) {
    fase.avisos.push('Sin LLM configurado (falta ANTHROPIC_API_KEY): empresas del registro de huella de carbono omitidas en esta ejecución');
    return r;
  }
  const falla = (m: string) => { r.errores.push(m); fase.errores.push(m); return r; };

  let compensacion, huella;
  try {
    const antesC = firmaGuardada(db, URL_COMPENSACION);
    const antesH = firmaGuardada(db, URL_HUELLA);
    compensacion = await descargarFichero(ctx.fetch, URL_COMPENSACION, { timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes });
    const sinCambiosC = !!compensacion && antesC?.firma === compensacion.firma;
    huella = await descargarFichero(ctx.fetch, URL_HUELLA, { timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes, saltarSiFirma: antesH?.completo && sinCambiosC && antesC?.completo ? antesH.firma : null });
    if (!huella) {
      r.sinCambios = true;
      fase.avisos.push('El registro de huella de carbono no ha cambiado desde la última vez que se recorrió entero');
      return r;
    }
  } catch (e) {
    return falla(`Registro de huella de carbono: ${(e as Error).message}`);
  }
  let filas: FilaHuella[];
  let compensaciones: FilaCompensacion[];
  try {
    filas = leerListadoHuella(huella.datos);
    compensaciones = leerListadoCompensacion(compensacion!.datos);
  } catch (e) {
    return falla(`Registro de huella de carbono: ${(e as Error).message}`);
  }
  r.filasLeidas = filas.length;
  r.compensacionesLeidas = compensaciones.length;
  const organizaciones = agruparOrganizaciones(filas, compensaciones);
  r.organizaciones = organizaciones.length;
  const anioMax = filas.reduce((m, f) => Math.max(m, f.anio), 0);

  const zona = zonaDePerfil(ctx.perfil);
  if (zona.length === 0) fase.avisos.push('El ámbito del perfil no tiene comunidades autónomas: no se guardará ninguna empresa de baja confianza (zona + sector) del registro de huella de carbono');
  const evaluadas = organizaciones
    .map((o) => ({ o, ev: evaluarOrganizacion(o, anioMax, cfg, zona) }))
    .filter((x) => x.ev.pasa)
    .sort((a, b) => b.ev.prioridad - a.ev.prioridad || b.o.filas[0].anio - a.o.filas[0].anio || a.o.clave.localeCompare(b.o.clave));
  const candidatas = evaluadas.filter((x) => x.ev.nivel === 'A');
  const bajas = evaluadas.filter((x) => x.ev.nivel === 'B');
  r.preFiltradas = evaluadas.length;

  const hoy = diaLocal(ahora);
  const yaVista = db.prepare('SELECT 1 FROM huella_cribadas WHERE hash = ?');
  const guardarCribada = db.prepare('INSERT OR REPLACE INTO huella_cribadas (hash, clave, nombre, resultado, cribada_en) VALUES (?, ?, ?, ?, ?)');
  const fctx = { db, llm: ctx.llm, reloj: ctx.reloj, fetch: ctx.fetch };
  let pendientes = false;
  let intentos = 0; // llamadas al LLM (también las que acaban en error): el tope cuenta intentos, no aciertos

  /** Nivel B: sin LLM, motivo de los datos, prioridad 1 (no se muestra por defecto). Idempotente. */
  const guardarBaja = (o: Organizacion) => {
    const f = o.filas[0];
    const { cita } = evidenciaOrganizacion(o);
    const motivo = motivoBajaConfianza(o);
    registrarSenal(db, {
      nombre: o.nombre, cif: o.cif, origen: 'huella_carbono', prioridad: PRIORIDAD_REGISTRO_ZONA, motivo, cita, provincia: f.ccaa || null,
      senal: { boeId: `huella:${o.clave}`, titulo: `Registro de huella de carbono (MITECO): ${o.nombre}`, proyecto: null, provincia: f.ccaa || null, medidas: [{ tipo: 'registro_huella', cita }], enlace: URL_HUELLA, fechaPublicacion: f.inscrita || hoy },
    }, ahora);
    r.bajaConfianza++;
  };
  for (const { o } of bajas) guardarBaja(o);

  for (const { o, ev } of candidatas) {
    const { lineas, cita } = evidenciaOrganizacion(o);
    const evidencia = lineas.join('\n');
    const h = hash(`${VERSION_CRIBA}|${evidencia}`);
    if (yaVista.get(h)) { r.yaCribadas++; continue; }
    if (intentos >= cfg.maxCribadas) { r.omitidasPorTope++; pendientes = true; continue; }
    intentos++;
    try {
      const { sistema, mensaje } = promptHuella(ctx.perfil, evidencia);
      const peticion = { tarea: 'criba' as const, modelo: ctx.modelo, sistema, mensaje, esquema: ESQUEMA_HUELLA, maxTokens: 400 };
      const clave = claveCache(peticion);
      const resp = desdeCache(db, clave) ?? (await llamar(fctx, fase, peticion));
      if (resp.desdeCache) fase.desdeCache++;
      const v = validarHuella(resp.datos);
      aCache(fctx, clave, resp);
      r.cribadas++;
      if (!v.financiador) {
        // Degradada por el modelo: si además cumple zona y sector queda como baja confianza; si no, fuera.
        if (ev.cumpleB) guardarBaja(o);
        else bajarSenalRegistro(db, `huella:${o.clave}`, motivoBajaConfianza(o));
        guardarCribada.run(h, o.clave, o.nombre, 'descartada', ahora.toISOString());
        r.descartadas++;
        continue;
      }
      const f = o.filas[0];
      const { nueva } = registrarSenal(db, {
        nombre: o.nombre, cif: o.cif, origen: 'huella_carbono', prioridad: PRIORIDAD_REGISTRO_COMPENSA, motivo: motivoHuella(o, v.motivo), cita, provincia: f.ccaa || null,
        senal: {
          boeId: `huella:${o.clave}`, titulo: `Registro de huella de carbono (MITECO): ${o.nombre}`, proyecto: null, provincia: f.ccaa || null,
          medidas: [{ tipo: 'registro_huella', cita }], enlace: URL_HUELLA, fechaPublicacion: f.inscrita || hoy,
        },
      }, ahora);
      guardarCribada.run(h, o.clave, o.nombre, 'financiador', ahora.toISOString());
      r.financiadoras++;
      (nueva ? r.empresasNuevas : r.empresasUnidas).push(o.nombre);
    } catch (e) {
      pendientes = true;
      if (esPresupuestoAgotado(e)) { r.omitidasPorTope++; continue; }
      const m = `${o.nombre}: ${(e as Error).message}`;
      r.errores.push(m);
      fase.errores.push(m);
    }
  }
  guardarFirma(db, URL_COMPENSACION, compensacion!.firma, true, ahora);
  guardarFirma(db, URL_HUELLA, huella.firma, !pendientes, ahora);
  if (r.omitidasPorTope) fase.omitidasPorTope = r.omitidasPorTope;
  fase.procesadas = r.cribadas;
  fase.descartadas = r.descartadas;
  return r;
}
