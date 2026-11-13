// Perfil editable desde la web: validación de lo que se acepta, guardado y versiones para reconsiderar veredictos del LLM.
//
// Reglas del motor (`rules.ts`) y puntuación (importe mínimo) leen el perfil guardado en cada ejecución, así que un cambio
// les llega solo. Los veredictos del LLM se guardan en `convocatoria_fases` y la fase no repite lo que ya tiene veredicto;
// para que un cambio de perfil cuente se estampa en cada veredicto la versión del perfil con la que se hizo:
//  - criba (Haiku): versión = hash de lo que ve el prompt (nombre, líneas, descripción del ámbito) + las regiones, niveles,
//    comunidades y la bandera de otras comunidades. Si cambia, se borran los veredictos de criba y la siguiente
//    ejecución los rehace (Haiku es barato y la caché de peticiones evita repetir las que no cambian de prompt).
//  - análisis (Sonnet): versión = hash de las líneas de trabajo. Si no cambian, los análisis se conservan (son caros).
// Importe mínimo: no entra en ninguna versión; se aplica al puntuar en cada ejecución y en cada petición de /api/semana.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaccion } from './db/repo.ts';
import type { Perfil } from './types.ts';

export const NIVELES_ADMINISTRACION = ['ESTADO', 'AUTONOMICA', 'LOCAL', 'OTROS'] as const;
const NUTS = /^ES\d{0,3}$/;

export interface PerfilEditable {
  lineas: { nombre: string; descripcion: string }[];
  ambito: Perfil['ambito'];
  importeMinimo: number | null;
}

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
  const comunidades = lista(a.comunidades, 'comunidades');
  const regiones = lista(a.regiones, 'regiones', (s) => NUTS.test(s.toUpperCase()), 'Las regiones son códigos NUTS como ES30 (Comunidad de Madrid)').map((s) => s.toUpperCase());
  if (typeof a.otrasComunidadesSiNoExigenSede !== 'boolean') throw new ErrorPerfil('Indica si se aceptan otras comunidades que no exijan sede (sí/no)');

  let importeMinimo: number | null = null;
  if (o.importeMinimo !== null && o.importeMinimo !== undefined && o.importeMinimo !== '') {
    if (typeof o.importeMinimo !== 'number' || !Number.isFinite(o.importeMinimo)) throw new ErrorPerfil('El importe mínimo debe ser un número');
    if (o.importeMinimo < 0) throw new ErrorPerfil('El importe mínimo no puede ser negativo');
    importeMinimo = Math.round(o.importeMinimo);
  }
  return { lineas, ambito: { descripcion, nivelesSiempre, comunidades, regiones, otrasComunidadesSiNoExigenSede: a.otrasComunidadesSiNoExigenSede }, importeMinimo };
}

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

/** Versión del perfil para la criba: todo lo que cambia el prompt o las condiciones de ámbito. */
export function versionCriba(p: Perfil): string {
  const a = p.ambito;
  return hash([p.nombre, p.lineas.map((l) => [l.nombre, l.descripcion]), a.descripcion, [...a.nivelesSiempre].sort(), [...a.comunidades].sort(), [...a.regiones].sort(), a.otrasComunidadesSiNoExigenSede === true]);
}

/** Versión del perfil para el análisis: solo las líneas de trabajo (prompt y enumerado del esquema). */
export function versionLineas(p: Perfil): string {
  return hash([p.nombre, p.lineas.map((l) => [l.nombre, l.descripcion])]);
}

/** Aplica lo editado sobre el perfil guardado y lo guarda. Devuelve el perfil completo. */
export function guardarPerfilEditable(db: DatabaseSync, e: PerfilEditable, ahora: Date): Perfil {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  if (!fila) throw new Error('La BD no tiene perfil');
  const nuevo: Perfil = { ...(JSON.parse(fila.datos) as Perfil), lineas: e.lineas, ambito: e.ambito, importeMinimo: e.importeMinimo };
  db.prepare('UPDATE perfil SET datos = ?, actualizado_en = ? WHERE id = 1').run(JSON.stringify(nuevo), ahora.toISOString());
  return nuevo;
}

export interface Reconsideradas { cribas: number; analisis: number }

/**
 * Hace reconsiderables los veredictos de LLM hechos con otro perfil. Los veredictos sin versión (anteriores a esta función)
 * se estampan con la actual en vez de borrarse. Se llama al empezar cada ejecución, antes de las fases.
 */
export function reconsiderarVeredictos(db: DatabaseSync, perfil: Perfil): Reconsideradas {
  const vc = versionCriba(perfil);
  const vl = versionLineas(perfil);
  const r: Reconsideradas = { cribas: 0, analisis: 0 };
  transaccion(db, () => {
    for (const [fase, version, clave] of [['criba_llm', vc, 'versionPerfil'], ['analisis', vl, 'versionLineas']] as const) {
      const filas = db.prepare('SELECT convocatoria_id AS id, datos FROM convocatoria_fases WHERE fase = ?').all(fase) as { id: string; datos: string }[];
      for (const f of filas) {
        const d = JSON.parse(f.datos) as Record<string, unknown>;
        if (d[clave] === version) continue;
        if (d[clave] === undefined) {
          db.prepare('UPDATE convocatoria_fases SET datos = ? WHERE convocatoria_id = ? AND fase = ?').run(JSON.stringify({ ...d, [clave]: version }), f.id, fase);
        } else {
          db.prepare('DELETE FROM convocatoria_fases WHERE convocatoria_id = ? AND fase = ?').run(f.id, fase);
          if (fase === 'criba_llm') r.cribas++; else r.analisis++;
        }
      }
    }
  });
  return r;
}
