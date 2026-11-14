// Perfil editable desde la web: validación de lo que se acepta, guardado y versiones para reconsiderar veredictos del LLM.
//
// Reglas del motor (`rules.ts`) y puntuación (importe mínimo) leen el perfil guardado en cada ejecución, así que un cambio
// les llega solo. Los veredictos del LLM se guardan en `convocatoria_fases` y la fase no repite lo que ya tiene veredicto;
// para que un cambio de perfil cuente se estampa en cada veredicto la versión del perfil con la que se hizo:
//  - criba (Haiku): versión = hash de lo que ve el prompt (nombre, líneas, descripción del ámbito, territorios) + las regiones y niveles.
//  - análisis (Sonnet): versión = hash de las líneas de trabajo. Si no cambian, los análisis se conservan (son caros).
//  Las líneas entran como conjunto ordenado: reordenarlas no cambia ninguna versión (no repite análisis).
//  Un veredicto con otra versión NO se borra: se marca obsoleto (`datos.obsoleta = true`) y conserva su efecto (si descartaba, sigue
//  descartando). La fase vuelve a procesar solo los obsoletos que están en su ventana de pendientes (ver `pendientesDeFase`); fuera de
//  ella se queda el veredicto anterior. Así un cambio de perfil sin LLM disponible (o con el presupuesto agotado) no devuelve al ranking
//  lo que estaba descartado.
// Importe mínimo: no entra en ninguna versión; se aplica al puntuar en cada ejecución y en cada petición de /api/semana.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { urlPermitidaSintactica } from './fetch-seguro.ts';
import { transaccion } from './db/repo.ts';
import type { Domicilio, Perfil, TerritorioAmbito } from './types.ts';

export const NIVELES_ADMINISTRACION = ['ESTADO', 'AUTONOMICA', 'LOCAL', 'OTROS'] as const;
const NUTS = /^ES\d{0,3}$/;

export interface PerfilEditable {
  lineas: { nombre: string; descripcion: string }[];
  ambito: Perfil['ambito'];
  /** undefined = no se toca el que ya hay. */
  domicilio?: Domicilio;
  importeMinimo: number | null;
  /** undefined = no se toca el que ya hay. */
  umbralEncaje?: number;
  /** Memorias anuales (URL de cada documento); undefined = no se toca la lista que ya hay. */
  memorias?: string[];
  /** Página donde se publican las memorias; undefined = no se toca; null = se quita. */
  paginaMemorias?: string | null;
}

/** Máximo de memorias que acepta el perfil (una al año da para décadas). */
export const MAX_MEMORIAS = 60;

/** Puntuación mínima del corte de "Esta semana" cuando el perfil no fija una. */
export const UMBRAL_CORTE_POR_DEFECTO = 50;

/** Umbral efectivo del corte: el del perfil o el de por defecto. */
/** Licitaciones: presupuesto base sin IVA por encima del cual un contrato es «probablemente fuera de escala» (`perfil.licitaciones.presupuestoMaximo`); null = sin límite. */
export const presupuestoMaximoLicitacion = (p: Pick<Perfil, 'licitaciones'> | null | undefined): number | null => p?.licitaciones?.presupuestoMaximo ?? null;
/** Ingresos anuales por servicios (`perfil.licitaciones.ingresosAnuales`) con los que se compara la solvencia económica exigida; null = no se juzga. */
export const ingresosAnuales = (p: Pick<Perfil, 'licitaciones'> | null | undefined): number | null => p?.licitaciones?.ingresosAnuales ?? null;

export const umbralDelPerfil = (p: Pick<Perfil, 'umbralEncaje'> | null | undefined): number => p?.umbralEncaje ?? UMBRAL_CORTE_POR_DEFECTO;

export class ErrorPerfil extends Error {}

function lista(v: unknown, campo: string, valida?: (s: string) => boolean, mensaje?: string): string[] {
  if (!Array.isArray(v)) throw new ErrorPerfil(`"${campo}" debe ser una lista`);
  const salida: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim()) throw new ErrorPerfil(`"${campo}" no admite elementos vacíos`);
    const s = x.trim();
    if (valida && !valida(s)) throw new ErrorPerfil(mensaje ?? `"${campo}": valor no válido: ${s}`);
    if (!salida.includes(s)) salida.push(s);
  }
  return salida;
}

function validarTerritorios(v: unknown): TerritorioAmbito[] {
  if (!Array.isArray(v) || v.length === 0) throw new ErrorPerfil('Indica al menos un territorio donde se pueden ejecutar los proyectos');
  const salida: TerritorioAmbito[] = [];
  for (const t of v) {
    const x = (t ?? {}) as Record<string, unknown>;
    const comunidad = typeof x.comunidad === 'string' ? x.comunidad.trim() : '';
    if (!comunidad) throw new ErrorPerfil('Cada territorio necesita una comunidad autónoma');
    if (salida.some((y) => y.comunidad.toLowerCase() === comunidad.toLowerCase())) throw new ErrorPerfil(`El territorio "${comunidad}" está repetido`);
    salida.push({ comunidad, provincias: lista(x.provincias ?? [], `provincias de ${comunidad}`) });
  }
  return salida;
}

/** Lista de URL http(s) públicas (sin repetir). Lanza ErrorPerfil con el motivo. */
function validarUrls(v: unknown, campo: string, max: number): string[] {
  if (!Array.isArray(v)) throw new ErrorPerfil(`"${campo}" debe ser una lista de direcciones`);
  const salida: string[] = [];
  for (const x of v) {
    const t = typeof x === 'string' ? x.trim() : '';
    if (!t) throw new ErrorPerfil(`"${campo}" no admite elementos vacíos`);
    let u: URL;
    try { u = new URL(t); } catch { throw new ErrorPerfil(`"${campo}": «${t}» no es una dirección válida (p. ej. https://entidad.org/memoria-2024.pdf)`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ErrorPerfil(`"${campo}": «${t}» debe empezar por http:// o https://`);
    if (!urlPermitidaSintactica(u.toString())) throw new ErrorPerfil(`"${campo}": «${t}» debe ser una web pública (con nombre de dominio, no una IP ni una dirección interna)`);
    if (!salida.includes(u.toString())) salida.push(u.toString());
  }
  if (salida.length > max) throw new ErrorPerfil(`"${campo}": como mucho ${max}`);
  return salida;
}

function validarDomicilio(v: unknown): Domicilio {
  const x = (v ?? {}) as Record<string, unknown>;
  const texto = (k: string) => (typeof x[k] === 'string' ? (x[k] as string).trim() : '');
  const municipio = texto('municipio');
  const provincia = texto('provincia');
  const comunidad = texto('comunidad');
  if (!municipio || !provincia || !comunidad) throw new ErrorPerfil('El domicilio social necesita municipio, provincia y comunidad autónoma');
  const distrito = texto('distrito');
  return { municipio, provincia, comunidad, ...(distrito ? { distrito } : {}) };
}

/** Valida el cuerpo del PUT. Lanza ErrorPerfil con un mensaje en castellano. */
export function validarPerfilEditable(cuerpo: unknown): PerfilEditable {
  const o = (cuerpo ?? {}) as Record<string, unknown>;
  if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) throw new ErrorPerfil('El cuerpo debe ser un objeto JSON');

  if (!Array.isArray(o.lineas) || o.lineas.length === 0) throw new ErrorPerfil('Hace falta al menos una línea de trabajo');
  const lineas: PerfilEditable['lineas'] = [];
  for (const l of o.lineas) {
    const x = (l ?? {}) as Record<string, unknown>;
    const nombre = typeof x.nombre === 'string' ? x.nombre.trim() : '';
    const descripcion = typeof x.descripcion === 'string' ? x.descripcion.trim() : '';
    if (!nombre) throw new ErrorPerfil('Cada línea de trabajo necesita un nombre');
    if (!descripcion) throw new ErrorPerfil(`La línea "${nombre}" necesita una descripción`);
    if (lineas.some((y) => y.nombre.toLowerCase() === nombre.toLowerCase())) throw new ErrorPerfil(`La línea "${nombre}" está repetida`);
    lineas.push({ nombre, descripcion });
  }

  const a = (o.ambito ?? null) as Record<string, unknown> | null;
  if (typeof a !== 'object' || a === null) throw new ErrorPerfil('Falta el ámbito geográfico');
  const descripcion = typeof a.descripcion === 'string' ? a.descripcion.trim() : '';
  if (!descripcion) throw new ErrorPerfil('Describe el ámbito geográfico con una frase');
  const nivelesSiempre = lista(a.nivelesSiempre, 'niveles siempre admitidos', (s) => (NIVELES_ADMINISTRACION as readonly string[]).includes(s.toUpperCase()),
    `Los niveles admitidos son: ${NIVELES_ADMINISTRACION.join(', ')}`).map((s) => s.toUpperCase());
  const territorios = validarTerritorios(a.territorios);
  const regiones = lista(a.regiones, 'regiones', (s) => NUTS.test(s.toUpperCase()), 'Las regiones son códigos NUTS como ES30 (Comunidad de Madrid)').map((s) => s.toUpperCase());

  let importeMinimo: number | null = null;
  if (o.importeMinimo !== null && o.importeMinimo !== undefined && o.importeMinimo !== '') {
    if (typeof o.importeMinimo !== 'number' || !Number.isFinite(o.importeMinimo)) throw new ErrorPerfil('El importe mínimo debe ser un número');
    if (o.importeMinimo < 0) throw new ErrorPerfil('El importe mínimo no puede ser negativo');
    importeMinimo = Math.round(o.importeMinimo);
  }
  let umbralEncaje: number | undefined;
  if (o.umbralEncaje !== undefined && o.umbralEncaje !== null && o.umbralEncaje !== '') {
    if (typeof o.umbralEncaje !== 'number' || !Number.isFinite(o.umbralEncaje)) throw new ErrorPerfil('El umbral de encaje debe ser un número');
    if (o.umbralEncaje < 0 || o.umbralEncaje > 100) throw new ErrorPerfil('El umbral de encaje debe estar entre 0 y 100');
    umbralEncaje = Math.round(o.umbralEncaje);
  }
  const domicilio = o.domicilio === undefined || o.domicilio === null ? undefined : validarDomicilio(o.domicilio);
  const memorias = o.memorias === undefined ? undefined : validarUrls(o.memorias, 'memorias', MAX_MEMORIAS);
  let paginaMemorias: string | null | undefined;
  if (o.paginaMemorias !== undefined) {
    if (o.paginaMemorias === null || (typeof o.paginaMemorias === 'string' && !o.paginaMemorias.trim())) paginaMemorias = null;
    else paginaMemorias = validarUrls([o.paginaMemorias], 'página de memorias', 1)[0];
  }
  return { ...(memorias === undefined ? {} : { memorias }), ...(paginaMemorias === undefined ? {} : { paginaMemorias }), ...(umbralEncaje === undefined ? {} : { umbralEncaje }), ...(domicilio ? { domicilio } : {}), lineas, ambito: { descripcion, nivelesSiempre, territorios, comunidades: territorios.filter((t) => t.provincias.length === 0).map((t) => t.comunidad), regiones }, importeMinimo };
}

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

/** Líneas como conjunto: ordenadas por nombre, para que el orden en el que se escriben no cuente. */
const lineasOrdenadas = (p: Perfil) => p.lineas.map((l) => [l.nombre, l.descripcion]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

/** Territorios como conjunto: el orden de comunidades y provincias no cuenta. */
const territoriosOrdenados = (p: Perfil) => (p.ambito.territorios ?? []).map((t) => [t.comunidad, [...t.provincias].sort()] as const).sort((x, y) => x[0].localeCompare(y[0]));

/** Domicilio como parte del hash: nada si no hay (así un perfil sin domicilio conserva su versión de siempre). */
const parteDomicilio = (p: Perfil) => (p.domicilio ? [[p.domicilio.municipio, p.domicilio.provincia, p.domicilio.comunidad, p.domicilio.distrito ?? '']] : []);

/** Versión del perfil para la criba: todo lo que cambia el prompt o las condiciones de ámbito. */
export function versionCriba(p: Perfil): string {
  const a = p.ambito;
  return hash([p.nombre, lineasOrdenadas(p), a.descripcion, [...a.nivelesSiempre].sort(), territoriosOrdenados(p), [...a.regiones].sort(), ...parteDomicilio(p)]);
}

/** Versión del perfil para el análisis: las líneas de trabajo (prompt y enumerado del esquema) y el domicilio (elegibilidad por sede). */
export function versionLineas(p: Perfil): string {
  return hash([p.nombre, lineasOrdenadas(p), ...parteDomicilio(p)]);
}

/** Versiones con la fórmula anterior (líneas en su orden): un veredicto hecho con el mismo perfil se re-estampa sin rehacerse. */
function versionesAnteriores(p: Perfil): { criba: string; lineas: string } {
  const a = p.ambito;
  const lineas = p.lineas.map((l) => [l.nombre, l.descripcion]);
  return {
    criba: hash([p.nombre, lineas, a.descripcion, [...a.nivelesSiempre].sort(), territoriosOrdenados(p), [...a.regiones].sort(), ...parteDomicilio(p)]),
    lineas: hash([p.nombre, lineas, ...parteDomicilio(p)]),
  };
}

/** Aplica lo editado sobre el perfil guardado y lo guarda. Devuelve el perfil completo. */
export function guardarPerfilEditable(db: DatabaseSync, e: PerfilEditable, ahora: Date): Perfil {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  if (!fila) throw new Error('La BD no tiene perfil');
  const nuevo: Perfil = { ...(JSON.parse(fila.datos) as Perfil), ...(e.domicilio ? { domicilio: e.domicilio } : {}), lineas: e.lineas, ambito: e.ambito, importeMinimo: e.importeMinimo, ...(e.umbralEncaje === undefined ? {} : { umbralEncaje: e.umbralEncaje }), ...(e.memorias === undefined ? {} : { memorias: e.memorias }), ...(e.paginaMemorias === undefined ? {} : { paginaMemorias: e.paginaMemorias }) };
  db.prepare('UPDATE perfil SET datos = ?, actualizado_en = ? WHERE id = 1').run(JSON.stringify(nuevo), ahora.toISOString());
  return nuevo;
}

export interface Reconsideradas { cribas: number; analisis: number }

/**
 * Marca como obsoletos (sin borrarlos) los veredictos de LLM hechos con otro perfil; quita la marca a los que vuelven a coincidir (el perfil
 * volvió a como estaba). Los veredictos sin versión (anteriores a esta función) o con la fórmula anterior del mismo perfil se estampan con la
 * actual. Se llama al empezar cada ejecución, antes de las fases. Devuelve cuántos pasan a obsoletos en esta llamada.
 */
export function reconsiderarVeredictos(db: DatabaseSync, perfil: Perfil): Reconsideradas {
  const vc = versionCriba(perfil);
  const vl = versionLineas(perfil);
  const anteriores = versionesAnteriores(perfil);
  const r: Reconsideradas = { cribas: 0, analisis: 0 };
  transaccion(db, () => {
    const actualizar = db.prepare('UPDATE convocatoria_fases SET datos = ? WHERE convocatoria_id = ? AND fase = ?');
    for (const [fase, version, anterior, clave] of [['criba_llm', vc, anteriores.criba, 'versionPerfil'], ['analisis', vl, anteriores.lineas, 'versionLineas']] as const) {
      const filas = db.prepare('SELECT convocatoria_id AS id, datos FROM convocatoria_fases WHERE fase = ?').all(fase) as { id: string; datos: string }[];
      for (const f of filas) {
        const d = JSON.parse(f.datos) as Record<string, unknown>;
        if (d[clave] === undefined || (d[clave] === anterior && anterior !== version)) {
          const { obsoleta: _o, ...resto } = d;
          actualizar.run(JSON.stringify({ ...resto, [clave]: version }), f.id, fase);
        } else if (d[clave] === version) {
          if (d.obsoleta) {
            const { obsoleta: _o, ...resto } = d;
            actualizar.run(JSON.stringify(resto), f.id, fase);
          }
        } else if (!d.obsoleta) {
          actualizar.run(JSON.stringify({ ...d, obsoleta: true }), f.id, fase);
          if (fase === 'criba_llm') r.cribas++; else r.analisis++;
        }
      }
    }
  });
  return r;
}

/**
 * Migra un perfil guardado antes del ámbito de actuación: si no tiene `territorios`, los toma de la semilla (con sus regiones, sumadas a las que había,
 * y su descripción), deriva las comunidades y quita la bandera antigua "otras comunidades si no exigen sede". Un perfil que ya los tiene no se toca.
 * Devuelve true si migró. El cambio de versión de la criba marca como obsoletos los veredictos anteriores (ver `reconsiderarVeredictos`).
 */
export function migrarAmbito(db: DatabaseSync, semilla: Perfil, ahora: Date): boolean {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  if (!fila) return false;
  const p = JSON.parse(fila.datos) as Perfil;
  if (Array.isArray(p.ambito?.territorios)) return false;
  const { otrasComunidadesSiNoExigenSede: _o, ...resto } = p.ambito as Perfil['ambito'] & { otrasComunidadesSiNoExigenSede?: boolean };
  const nuevo: Perfil = {
    ...p,
    ambito: {
      ...resto, descripcion: semilla.ambito.descripcion, territorios: semilla.ambito.territorios,
      comunidades: semilla.ambito.comunidades, regiones: [...new Set([...(p.ambito?.regiones ?? []), ...semilla.ambito.regiones])],
    },
  };
  db.prepare('UPDATE perfil SET datos = ?, actualizado_en = ? WHERE id = 1').run(JSON.stringify(nuevo), ahora.toISOString());
  return true;
}

/**
 * Migra un perfil guardado antes del domicilio social: si no lo tiene, lo toma de la semilla. Un perfil que ya lo tiene (o una semilla sin él) no se toca.
 * El cambio de versión de la criba marca como obsoletos los veredictos anteriores (ver `reconsiderarVeredictos`). Devuelve true si migró.
 */
export function migrarDomicilio(db: DatabaseSync, semilla: Perfil, ahora: Date): boolean {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  if (!fila || !semilla.domicilio) return false;
  const p = JSON.parse(fila.datos) as Perfil;
  if (p.domicilio) return false;
  db.prepare('UPDATE perfil SET datos = ?, actualizado_en = ? WHERE id = 1').run(JSON.stringify({ ...p, domicilio: semilla.domicilio }), ahora.toISOString());
  return true;
}

/** Perfiles guardados antes de los campos de licitaciones (`licitaciones`, `entidad`) los reciben de la semilla; nunca pisa lo que ya tengan. */
export function migrarLicitaciones(db: DatabaseSync, semilla: Perfil, ahora: Date): boolean {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  if (!fila) return false;
  const p = JSON.parse(fila.datos) as Perfil;
  const nuevo: Perfil = { ...p, ...(p.licitaciones || !semilla.licitaciones ? {} : { licitaciones: semilla.licitaciones }), ...(p.entidad || !semilla.entidad ? {} : { entidad: semilla.entidad }) };
  if (nuevo.licitaciones === p.licitaciones && nuevo.entidad === p.entidad) return false;
  db.prepare('UPDATE perfil SET datos = ?, actualizado_en = ? WHERE id = 1').run(JSON.stringify(nuevo), ahora.toISOString());
  return true;
}

/** Perfiles guardados antes de las memorias reciben de la semilla la lista y la página; nunca pisa lo que ya tengan (aunque la hayan vaciado a propósito: `memorias: []` cuenta como tenerla). */
export function migrarMemorias(db: DatabaseSync, semilla: Perfil, ahora: Date): boolean {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  if (!fila) return false;
  const p = JSON.parse(fila.datos) as Perfil;
  const nuevo: Perfil = { ...p, ...(p.memorias !== undefined || !semilla.memorias ? {} : { memorias: semilla.memorias }), ...(p.paginaMemorias !== undefined || semilla.paginaMemorias === undefined ? {} : { paginaMemorias: semilla.paginaMemorias }) };
  if (nuevo.memorias === p.memorias && nuevo.paginaMemorias === p.paginaMemorias) return false;
  db.prepare('UPDATE perfil SET datos = ?, actualizado_en = ? WHERE id = 1').run(JSON.stringify(nuevo), ahora.toISOString());
  return true;
}

/** Añade a la lista de memorias del perfil las direcciones descubiertas en su página (las que ya estaban no se repiten). Devuelve el perfil guardado. */
export function anadirMemorias(db: DatabaseSync, urls: string[], ahora: Date): Perfil {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  if (!fila) throw new Error('La BD no tiene perfil');
  const p = JSON.parse(fila.datos) as Perfil;
  const nuevo: Perfil = { ...p, memorias: [...new Set([...(p.memorias ?? []), ...urls])] };
  db.prepare('UPDATE perfil SET datos = ?, actualizado_en = ? WHERE id = 1').run(JSON.stringify(nuevo), ahora.toISOString());
  return nuevo;
}
