// Acceso a datos. Funciones pequeñas sobre DatabaseSync; nada de lógica de negocio.
import type { DatabaseSync } from 'node:sqlite';
import { diasEntre } from '../dates.ts';
import type { Plazo } from '../plazos.ts';
import type { Puntuacion } from '../puntuacion.ts';
import type { Convocatoria, Cribada, Fundacion, Perfil, Semilla } from '../types.ts';

export function transaccion<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// --- Perfil y semilla ---

export function leerPerfil(db: DatabaseSync): Perfil | null {
  const fila = db.prepare('SELECT datos FROM perfil WHERE id = 1').get() as { datos: string } | undefined;
  return fila ? (JSON.parse(fila.datos) as Perfil) : null;
}

export function guardarSemilla(db: DatabaseSync, s: Semilla, ahora: Date): void {
  transaccion(db, () => {
    db.prepare('INSERT INTO perfil (id, datos, actualizado_en) VALUES (1, ?, ?)').run(JSON.stringify(s.perfil), ahora.toISOString());
    const org = db.prepare("INSERT OR IGNORE INTO organizaciones_parecidas (nif, nombre, origen) VALUES (?, ?, 'semilla')");
    for (const o of s.organizacionesParecidas) org.run(o.nif, o.nombre);
    const fun = db.prepare('INSERT OR IGNORE INTO fundaciones (nombre, url, notas, tipo, activa) VALUES (?, ?, ?, ?, ?)');
    const vista = db.prepare('INSERT OR IGNORE INTO fundaciones_sembradas (nombre) VALUES (?)');
    for (const f of s.fundaciones) {
      fun.run(f.nombre, f.url, f.notas, f.tipo ?? 'fundacion', f.activa === false || !f.url ? 0 : 1);
      vista.run(f.nombre);
    }
  });
}

/**
 * Añade a una BD ya sembrada las fuentes vigiladas de la semilla que aún no se le habían ofrecido (por nombre). Nunca toca las que existen
 * (ni su URL, nota o activación editadas por el equipo) ni resucita las que el equipo quitó. Devuelve cuántas añadió.
 */
export function sembrarFuentesFaltantes(db: DatabaseSync, fundaciones: Fundacion[]): number {
  let n = 0;
  transaccion(db, () => {
    const vista = db.prepare('SELECT 1 FROM fundaciones_sembradas WHERE nombre = ?');
    const marca = db.prepare('INSERT OR IGNORE INTO fundaciones_sembradas (nombre) VALUES (?)');
    const existe = db.prepare('SELECT 1 FROM fundaciones WHERE nombre = ? OR (url IS NOT NULL AND url = ?)');
    const alta = db.prepare('INSERT INTO fundaciones (nombre, url, notas, tipo, activa) VALUES (?, ?, ?, ?, ?)');
    for (const f of fundaciones) {
      if (vista.get(f.nombre)) continue;
      marca.run(f.nombre);
      if (existe.get(f.nombre, f.url)) continue;
      alta.run(f.nombre, f.url, f.notas, f.tipo ?? 'fundacion', f.activa === false || !f.url ? 0 : 1);
      n++;
    }
  });
  return n;
}

// --- Convocatorias ---

/**
 * Inserta o actualiza lo que dicen la fuente y las reglas deterministas. Devuelve true si era nueva.
 * Conserva `primera_vez` y no toca el estado de fases posteriores (`convocatoria_fases`).
 */
export function guardarConvocatoria(
  db: DatabaseSync, { convocatoria: c, descarte, condicion = null }: Cribada & { condicion?: string | null }, ahora: Date,
): boolean {
  const existe = db.prepare('SELECT 1 FROM convocatorias WHERE id = ?').get(c.id) !== undefined;
  const t = ahora.toISOString();
  db.prepare(`
    INSERT INTO convocatorias (id, fuente, fuente_id, titulo, organo_nivel1, organo_nivel2, organo_nivel3, fecha_publicacion,
      url, tipo, finalidad, regiones, abierto, descarte_regla, descarte_motivo, condicion, datos, primera_vez, ultima_vez)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      titulo = excluded.titulo, organo_nivel1 = excluded.organo_nivel1, organo_nivel2 = excluded.organo_nivel2,
      organo_nivel3 = excluded.organo_nivel3, fecha_publicacion = excluded.fecha_publicacion, url = excluded.url,
      tipo = excluded.tipo, finalidad = excluded.finalidad, regiones = excluded.regiones, abierto = excluded.abierto,
      descarte_regla = excluded.descarte_regla, descarte_motivo = excluded.descarte_motivo, condicion = excluded.condicion,
      datos = excluded.datos,
      ultima_vez = excluded.ultima_vez
  `).run(
    c.id, c.fuente, c.fuenteId, c.titulo, c.organo.nivel1, c.organo.nivel2, c.organo.nivel3, c.fechaPublicacion,
    c.url, c.tipo, c.finalidad, JSON.stringify(c.regiones), c.abierto === null ? null : Number(c.abierto),
    descarte?.regla ?? null, descarte?.motivo ?? null, descarte ? null : condicion, JSON.stringify(c.datos), t, t,
  );
  return !existe;
}

// --- Fases posteriores (criba LLM, análisis, decisión del equipo…) ---

export interface VeredictoFase {
  convocatoriaId: string;
  fase: string;
  /** true = esta fase la saca de las candidatas. */
  descarta: boolean;
  motivo: string | null;
  datos?: unknown;
}

export function guardarFase(db: DatabaseSync, v: VeredictoFase, ahora: Date): void {
  db.prepare(`
    INSERT INTO convocatoria_fases (convocatoria_id, fase, descarta, motivo, datos, actualizado_en) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (convocatoria_id, fase) DO UPDATE SET
      descarta = excluded.descarta, motivo = excluded.motivo, datos = excluded.datos, actualizado_en = excluded.actualizado_en
  `).run(v.convocatoriaId, v.fase, Number(v.descarta), v.motivo, JSON.stringify(v.datos ?? {}), ahora.toISOString());
}

export function leerFases(db: DatabaseSync, convocatoriaId: string): VeredictoFase[] {
  const filas = db.prepare('SELECT fase, descarta, motivo, datos FROM convocatoria_fases WHERE convocatoria_id = ? ORDER BY fase')
    .all(convocatoriaId) as { fase: string; descarta: number; motivo: string | null; datos: string }[];
  return filas.map((f) => ({ convocatoriaId, fase: f.fase, descarta: f.descarta === 1, motivo: f.motivo, datos: JSON.parse(f.datos) }));
}

export interface FilaConvocatoria {
  id: string;
  fuente: string;
  titulo: string;
  organo: string;
  fechaPublicacion: string;
  url: string;
}

const organoLegible = (f: Record<string, unknown>) =>
  [f.organo_nivel2, f.organo_nivel3].filter(Boolean).join(' · ') || String(f.organo_nivel1);

/**
 * SQL: la fila `c` sigue en juego (sin descarte de reglas ni de fases; si tiene condición, la criba LLM la aceptó).
 * Una descubierta SOLO por organizaciones parecidas deja de estar en juego si ya no le queda ninguna etiqueta (se desactivó la organización).
 */
const EN_JUEGO = `
  c.descarte_regla IS NULL
  AND NOT EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.descarta = 1)
  AND (c.condicion IS NULL OR EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.fase = 'criba_llm' AND f.descarta = 0))
  AND (NOT EXISTS (SELECT 1 FROM descubiertas_parecidas d WHERE d.convocatoria_id = c.id)
    OR EXISTS (SELECT 1 FROM origenes_convocatoria o WHERE o.convocatoria_id = c.id))
`;

/**
 * SQL: la fila `c` ya pasó la criba LLM (veredicto de Haiku que no la descarta). Es lo que la deja entrar en el ranking de "Esta semana" y en el correo:
 * sin veredicto (la criba aún no llegó a ella, p. ej. por tope de llamadas) "en juego" solo quiere decir "no descartada todavía", y puntuaría 47 con solo
 * el factor de cierre conocido (un concurso de escaparates navideños en "cierran pronto"). Las fuentes que no pasan por criba (ninguna hoy) tendrían que
 * guardar su propio veredicto.
 */
const CRIBADA = `EXISTS (SELECT 1 FROM convocatoria_fases fc WHERE fc.convocatoria_id = c.id AND fc.fase = 'criba_llm' AND fc.descarta = 0)`;

/** SQL: la fila `c` no la ha descartado el equipo (lo descartado no sale en ranking, listas ni resumen; no es lo mismo que "fuera de juego" del motor). */
const NO_DESCARTADA_POR_EQUIPO = `NOT EXISTS (SELECT 1 FROM decisiones dq WHERE dq.convocatoria_id = c.id AND dq.decision = 'descartada')`;

/**
 * Candidatas publicadas entre dos días incluidos, más recientes primero: sin descarte de reglas ni de ninguna fase,
 * y las que llevan condición (otra comunidad) solo si la criba LLM ya las dio por buenas.
 */
export function candidatasEntre(db: DatabaseSync, desde: string, hasta: string): FilaConvocatoria[] {
  const filas = db.prepare(`
    SELECT id, fuente, titulo, organo_nivel1, organo_nivel2, organo_nivel3, fecha_publicacion, url
    FROM convocatorias c
    WHERE fecha_publicacion BETWEEN ? AND ? AND ${EN_JUEGO} AND ${NO_DESCARTADA_POR_EQUIPO} AND ${NO_LICITACION}
    ORDER BY fecha_publicacion DESC, id DESC
  `).all(desde, hasta) as Record<string, string | null>[];
  return filas.map((f) => ({
    id: f.id!,
    fuente: f.fuente!,
    titulo: f.titulo!,
    organo: organoLegible(f),
    fechaPublicacion: f.fecha_publicacion!,
    url: f.url!,
  }));
}

/** Convocatoria tal y como se guardó (fuente + reglas), con sus veredictos de fases. */
export interface ConvocatoriaGuardada {
  convocatoria: Convocatoria;
  descarte: { regla: string; motivo: string | null } | null;
  condicion: string | null;
  primeraVez: string;
  ultimaVez: string;
  fases: VeredictoFase[];
}

function filaAConvocatoria(f: Record<string, unknown>): Convocatoria {
  return {
    id: String(f.id), fuente: String(f.fuente), fuenteId: String(f.fuente_id), titulo: String(f.titulo),
    organo: { nivel1: String(f.organo_nivel1), nivel2: (f.organo_nivel2 as string | null) ?? null, nivel3: (f.organo_nivel3 as string | null) ?? null },
    fechaPublicacion: String(f.fecha_publicacion), url: String(f.url), tipo: (f.tipo as string | null) ?? null,
    finalidad: (f.finalidad as string | null) ?? null, regiones: JSON.parse(String(f.regiones)) as string[],
    abierto: f.abierto === null ? null : f.abierto === 1, datos: JSON.parse(String(f.datos)),
  };
}

/**
 * Vuelve a aplicar las reglas deterministas a todo lo guardado con el perfil actual (descarte por regla y condición de ámbito): un cambio de
 * ámbito debe alcanzar también a lo que la fuente ya no devuelve. Devuelve cuántas cambian de descarte o de condición.
 */
export function reaplicarReglas(
  db: DatabaseSync, perfil: Perfil, regla: (c: Convocatoria, p: Perfil) => { regla: string; motivo: string } | null, condicion: (c: Convocatoria, p: Perfil) => string | null,
): number {
  let cambian = 0;
  transaccion(db, () => {
    const filas = db.prepare('SELECT * FROM convocatorias').all() as Record<string, unknown>[];
    const actualizar = db.prepare('UPDATE convocatorias SET descarte_regla = ?, descarte_motivo = ?, condicion = ? WHERE id = ?');
    for (const f of filas) {
      if (f.descarte_regla === 'tema' || f.descarte_regla === 'pais') continue; // lo descarta la fuente (eu_ft, eu_cascada), no estas reglas
      const c = filaAConvocatoria(f);
      const d = regla(c, perfil);
      const cond = d ? null : condicion(c, perfil);
      if ((d?.regla ?? null) !== (f.descarte_regla ?? null) || (cond ?? null) !== (f.condicion ?? null)) {
        actualizar.run(d?.regla ?? null, d?.motivo ?? null, cond, c.id);
        cambian++;
      }
    }
  });
  return cambian;
}

export function leerConvocatoria(db: DatabaseSync, id: string): ConvocatoriaGuardada | null {
  const f = db.prepare('SELECT * FROM convocatorias WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!f) return null;
  return {
    convocatoria: filaAConvocatoria(f),
    descarte: f.descarte_regla ? { regla: String(f.descarte_regla), motivo: (f.descarte_motivo as string | null) ?? null } : null,
    condicion: (f.condicion as string | null) ?? null,
    primeraVez: String(f.primera_vez),
    ultimaVez: String(f.ultima_vez),
    fases: leerFases(db, id),
  };
}

/**
 * Fuentes cuyas fichas son ofertas vigentes sin una fecha de publicación que sirva para la ventana de pendientes (un topic de la UE
 * abrió hace meses y sigue abierto): están pendientes de criba y análisis mientras la fuente las siga devolviendo.
 */
const FUENTES_VIGENTES = ['eu_ft', 'eu_cascada', 'placsp'];

/** Las licitaciones (fuente `placsp`) no son convocatorias de ayudas: tienen su propia página y no entran en "Esta semana", el correo ni sus listas. */
export const FUENTE_LICITACIONES = 'placsp';
const NO_LICITACION = `c.fuente <> '${FUENTE_LICITACIONES}'`;

/** SQL: el veredicto `f` está marcado como obsoleto (hecho con otro perfil; ver src/perfil.ts). */
const OBSOLETA = `IFNULL(json_extract(f.datos, '$.obsoleta'), 0) = 1`;

export interface OpcionesPendientes {
  /** Además de la ventana, estas convocatorias (por id) aunque sean antiguas (`npm run cargar`). */
  incluirIds?: string[];
  /** Solo las de `incluirIds` (nada de la ventana): `npm run cargar` no procesa lo pendiente de otras fuentes. */
  soloIncluidas?: boolean;
  /** Las que ya fallaron por error del LLM en esta fase tantas veces (entre ejecuciones) dejan de reintentarse. */
  maxIntentos?: number;
  /** `solo`: únicamente las de esa fuente (las licitaciones tienen su propio análisis); `sin`: todas menos las de esa fuente. */
  fuente?: { solo?: string; sin?: string };
}

/**
 * Convocatorias pendientes de `fase`: siguen en juego según las reglas y las demás fases, no tienen veredicto vigente de `fase`
 * (sin veredicto, o con uno obsoleto por un cambio de perfil) y se publicaron desde `publicadasDesde` (YYYY-MM-DD) — da igual que la
 * fuente las haya vuelto a devolver en esta ejecución: lo omitido por el tope o por un error se recupera en la siguiente aunque ya no
 * esté en la ventana. Un veredicto obsoleto fuera de la ventana se conserva tal cual (no se rehace).
 * `requiereFase` exige además un veredicto vigente y no descartante de otra fase. Más recientes primero.
 */
export function pendientesDeFase(
  db: DatabaseSync, fase: string, publicadasDesde: string, requiereFase: string | null = null, opciones: OpcionesPendientes = {},
): { convocatoria: Convocatoria; condicion: string | null }[] {
  const incluir = JSON.stringify(opciones.incluirIds ?? []);
  const filas = db.prepare(`
    SELECT * FROM convocatorias c
    WHERE (? = 0 OR c.id IN (SELECT value FROM json_each(?))) AND (c.fecha_publicacion >= ? OR EXISTS (SELECT 1 FROM origenes_convocatoria o WHERE o.convocatoria_id = c.id)
        OR (c.fuente IN (${FUENTES_VIGENTES.map((f) => `'${f}'`).join(',')}) AND c.ultima_vez >= ?)
        OR c.id IN (SELECT value FROM json_each(?))) AND c.descarte_regla IS NULL
      AND NOT EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.fase = ? AND NOT (${OBSOLETA}))
      AND NOT EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.fase <> ? AND f.descarta = 1 AND NOT (${OBSOLETA}))
      AND ${NO_DESCARTADA_POR_EQUIPO}
      AND (? IS NULL OR EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.fase = ? AND f.descarta = 0 AND NOT (${OBSOLETA})))
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM llm_fallos lf WHERE lf.convocatoria_id = c.id AND lf.fase = ? AND lf.intentos >= ?))
      AND (? IS NULL OR c.fuente = ?) AND (? IS NULL OR c.fuente <> ?)
    ORDER BY c.fecha_publicacion DESC, c.id
  `).all(opciones.soloIncluidas ? 1 : 0, incluir, publicadasDesde, publicadasDesde, incluir, fase, fase, requiereFase, requiereFase, opciones.maxIntentos ?? null, fase, opciones.maxIntentos ?? null,
    opciones.fuente?.solo ?? null, opciones.fuente?.solo ?? null, opciones.fuente?.sin ?? null, opciones.fuente?.sin ?? null) as Record<string, unknown>[];
  return filas.map((f) => ({ convocatoria: filaAConvocatoria(f), condicion: (f.condicion as string | null) ?? null }));
}

// --- Fallos del LLM por convocatoria y fase (límite de reintentos entre ejecuciones) ---

/** Apunta un intento fallido por error del LLM (respuesta cortada, rechazo, JSON o esquema no válido). Devuelve los intentos acumulados. */
export function apuntarFalloLlm(db: DatabaseSync, convocatoriaId: string, fase: string, error: string, ahora: Date): number {
  db.prepare(`
    INSERT INTO llm_fallos (convocatoria_id, fase, intentos, ultimo_error, actualizado_en) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT (convocatoria_id, fase) DO UPDATE SET intentos = intentos + 1, ultimo_error = excluded.ultimo_error, actualizado_en = excluded.actualizado_en
  `).run(convocatoriaId, fase, error.slice(0, 500), ahora.toISOString());
  return Number((db.prepare('SELECT intentos FROM llm_fallos WHERE convocatoria_id = ? AND fase = ?').get(convocatoriaId, fase) as { intentos: number }).intentos);
}

/** Tras un veredicto bueno se olvidan los fallos anteriores. */
export function borrarFallosLlm(db: DatabaseSync, convocatoriaId: string, fase: string): void {
  db.prepare('DELETE FROM llm_fallos WHERE convocatoria_id = ? AND fase = ?').run(convocatoriaId, fase);
}

export interface FilaDescarte extends FilaConvocatoria {
  /** `regla:<regla>` para las reglas deterministas, o el nombre de la fase (criba_llm, analisis…). */
  por: string;
  motivo: string | null;
}

/** Descartadas (por reglas o por alguna fase) publicadas entre dos días incluidos. `por` filtra (p. ej. 'criba_llm'). */
export function descartesEntre(db: DatabaseSync, desde: string, hasta: string, por: string | null = null): FilaDescarte[] {
  const filas = db.prepare(`
    SELECT * FROM (
      SELECT c.id, c.fuente, c.titulo, c.organo_nivel1, c.organo_nivel2, c.organo_nivel3, c.fecha_publicacion, c.url,
        'regla:' || c.descarte_regla AS por, c.descarte_motivo AS motivo
      FROM convocatorias c WHERE c.descarte_regla IS NOT NULL
      UNION ALL
      SELECT c.id, c.fuente, c.titulo, c.organo_nivel1, c.organo_nivel2, c.organo_nivel3, c.fecha_publicacion, c.url,
        f.fase AS por, f.motivo
      FROM convocatorias c JOIN convocatoria_fases f ON f.convocatoria_id = c.id
      WHERE c.descarte_regla IS NULL AND f.descarta = 1
    ) WHERE fecha_publicacion BETWEEN ? AND ? AND (? IS NULL OR por = ?)
    ORDER BY fecha_publicacion DESC, id DESC
  `).all(desde, hasta, por, por) as Record<string, string | null>[];
  return filas.map((f) => ({
    id: f.id!, fuente: f.fuente!, titulo: f.titulo!, organo: organoLegible(f), fechaPublicacion: f.fecha_publicacion!,
    url: f.url!, por: f.por!, motivo: f.motivo,
  }));
}

// --- Cachés: documentos, textos y respuestas del LLM ---

export interface DocumentoCacheado {
  hash: string | null;
  tipo: string | null;
  error: string | null;
  /** Fallos pasajeros seguidos (0 tras una descarga buena). */
  fallos: number;
}

export function leerDocumento(db: DatabaseSync, url: string): DocumentoCacheado | null {
  return (db.prepare('SELECT hash, tipo, error, fallos FROM documentos WHERE url = ?').get(url) as DocumentoCacheado | undefined) ?? null;
}

export function guardarDocumento(db: DatabaseSync, url: string, d: DocumentoCacheado, ahora: Date): void {
  db.prepare(`
    INSERT INTO documentos (url, hash, tipo, error, fallos, descargado_en) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (url) DO UPDATE SET hash = excluded.hash, tipo = excluded.tipo, error = excluded.error,
      fallos = excluded.fallos, descargado_en = excluded.descargado_en
  `).run(url, d.hash, d.tipo, d.error, d.fallos, ahora.toISOString());
}

export function leerTexto(db: DatabaseSync, hash: string): { texto: string; paginas: number | null } | null {
  return (db.prepare('SELECT texto, paginas FROM textos WHERE hash = ?').get(hash) as { texto: string; paginas: number | null } | undefined) ?? null;
}

export function guardarTexto(db: DatabaseSync, hash: string, texto: string, paginas: number | null, ahora: Date): void {
  db.prepare('INSERT OR IGNORE INTO textos (hash, texto, paginas, creado_en) VALUES (?, ?, ?, ?)').run(hash, texto, paginas, ahora.toISOString());
}

export function leerLlmCache(db: DatabaseSync, clave: string): unknown {
  const f = db.prepare('SELECT respuesta FROM llm_cache WHERE clave = ?').get(clave) as { respuesta: string } | undefined;
  return f ? JSON.parse(f.respuesta) : undefined;
}

export function guardarLlmCache(db: DatabaseSync, clave: string, modelo: string, respuesta: unknown, ahora: Date): void {
  db.prepare('INSERT OR REPLACE INTO llm_cache (clave, modelo, respuesta, creado_en) VALUES (?, ?, ?, ?)')
    .run(clave, modelo, JSON.stringify(respuesta), ahora.toISOString());
}

// --- Registro de ejecuciones ---

export interface ContadoresFuente {
  recibidas: number;
  nuevas: number;
  candidatas: number;
  descartadas: number;
}

export function empezarEjecucion(db: DatabaseSync, ahora: Date): number {
  const r = db.prepare("INSERT INTO ejecuciones (inicio, estado) VALUES (?, 'en_curso')").run(ahora.toISOString());
  return Number(r.lastInsertRowid);
}

/**
 * Ejecuciones que siguen "en_curso" y empezaron hace más de `horas` (ninguna pasada dura tanto): el proceso murió sin cerrarlas. Se marcan
 * como abortadas. El margen evita tocar una pasada que de verdad está en marcha a la vez (p. ej. `npm run cargar` durante el cron).
 */
export function abortarEjecucionesColgadas(db: DatabaseSync, ahora: Date, horas = 6): number {
  const antes = new Date(ahora.getTime() - horas * 3600_000).toISOString();
  return Number(db.prepare("UPDATE ejecuciones SET estado = 'abortada', fin = ?, error = 'El proceso terminó antes de cerrar la ejecución' WHERE estado = 'en_curso' AND inicio < ?")
    .run(ahora.toISOString(), antes).changes);
}

export function empezarFuente(db: DatabaseSync, ejecucionId: number, fuente: string, ahora: Date): void {
  db.prepare('INSERT INTO ejecucion_fuentes (ejecucion_id, fuente, inicio) VALUES (?, ?, ?)').run(ejecucionId, fuente, ahora.toISOString());
}

export function terminarFuente(
  db: DatabaseSync, ejecucionId: number, fuente: string, ahora: Date, n: ContadoresFuente, errores: string[],
): void {
  db.prepare(`
    UPDATE ejecucion_fuentes SET fin = ?, recibidas = ?, nuevas = ?, candidatas = ?, descartadas = ?, errores = ?
    WHERE ejecucion_id = ? AND fuente = ?
  `).run(ahora.toISOString(), n.recibidas, n.nuevas, n.candidatas, n.descartadas, JSON.stringify(errores), ejecucionId, fuente);
}

export function terminarEjecucion(db: DatabaseSync, ejecucionId: number, ahora: Date, conErrores: boolean, error: string | null = null): void {
  db.prepare('UPDATE ejecuciones SET fin = ?, estado = ?, error = ? WHERE id = ?')
    .run(ahora.toISOString(), conErrores || error ? 'con_errores' : 'ok', error, ejecucionId);
}

/** Registro de una fase posterior (criba LLM, análisis) en una ejecución. */
export interface RegistroFase {
  fase: string;
  modelo: string | null;
  procesadas: number;
  descartadas: number;
  omitidasPorTope: number;
  llamadas: number;
  desdeCache: number;
  tokensEntrada: number;
  tokensSalida: number;
  tokensCacheLectura: number;
  tokensCacheEscritura: number;
  costeUsd: number;
  avisos: string[];
  errores: string[];
}

export function registroFaseVacio(fase: string, modelo: string | null): RegistroFase {
  return {
    fase, modelo, procesadas: 0, descartadas: 0, omitidasPorTope: 0, llamadas: 0, desdeCache: 0, tokensEntrada: 0,
    tokensSalida: 0, tokensCacheLectura: 0, tokensCacheEscritura: 0, costeUsd: 0, avisos: [], errores: [],
  };
}

export function guardarRegistroFase(db: DatabaseSync, ejecucionId: number, r: RegistroFase): void {
  db.prepare(`
    INSERT OR REPLACE INTO ejecucion_fases (ejecucion_id, fase, modelo, procesadas, descartadas, omitidas_por_tope, llamadas,
      desde_cache, tokens_entrada, tokens_salida, tokens_cache_lectura, tokens_cache_escritura, coste_usd, avisos, errores)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ejecucionId, r.fase, r.modelo, r.procesadas, r.descartadas, r.omitidasPorTope, r.llamadas, r.desdeCache, r.tokensEntrada,
    r.tokensSalida, r.tokensCacheLectura, r.tokensCacheEscritura, r.costeUsd, JSON.stringify(r.avisos), JSON.stringify(r.errores),
  );
}

function leerRegistrosFase(db: DatabaseSync, ejecucionId: number): RegistroFase[] {
  const filas = db.prepare('SELECT * FROM ejecucion_fases WHERE ejecucion_id = ? ORDER BY rowid').all(ejecucionId) as Record<string, unknown>[];
  return filas.map((f) => ({
    fase: String(f.fase), modelo: (f.modelo as string | null) ?? null, procesadas: Number(f.procesadas),
    descartadas: Number(f.descartadas), omitidasPorTope: Number(f.omitidas_por_tope), llamadas: Number(f.llamadas),
    desdeCache: Number(f.desde_cache), tokensEntrada: Number(f.tokens_entrada), tokensSalida: Number(f.tokens_salida),
    tokensCacheLectura: Number(f.tokens_cache_lectura), tokensCacheEscritura: Number(f.tokens_cache_escritura),
    costeUsd: Number(f.coste_usd), avisos: JSON.parse(String(f.avisos)) as string[], errores: JSON.parse(String(f.errores)) as string[],
  }));
}

export interface Ejecucion {
  id: number;
  inicio: string;
  fin: string | null;
  estado: string;
  /** Fallo general que cortó la ejecución (no de una fuente concreta). */
  error: string | null;
  fuentes: (ContadoresFuente & { fuente: string; inicio: string; fin: string | null; errores: string[] })[];
  /** Fases posteriores (criba LLM, análisis) con tokens y coste. */
  fases: RegistroFase[];
  /** Coste total de LLM de la ejecución, en dólares. */
  costeLlmUsd: number;
}

export function ultimasEjecuciones(db: DatabaseSync, limite: number): Ejecucion[] {
  const ejecuciones = db.prepare('SELECT id, inicio, fin, estado, error FROM ejecuciones ORDER BY id DESC LIMIT ?').all(limite) as unknown as Omit<Ejecucion, 'fuentes' | 'fases' | 'costeLlmUsd'>[];
  const fuentes = db.prepare(`
    SELECT fuente, inicio, fin, recibidas, nuevas, candidatas, descartadas, errores
    FROM ejecucion_fuentes WHERE ejecucion_id = ? ORDER BY fuente
  `);
  return ejecuciones.map((e) => {
    const fases = leerRegistrosFase(db, e.id);
    return {
    ...e,
    fases,
    costeLlmUsd: fases.reduce((t, f) => t + f.costeUsd, 0),
    fuentes: (fuentes.all(e.id) as unknown as (Omit<Ejecucion['fuentes'][number], 'errores'> & { errores: string })[]).map((f) => ({
      ...f,
      errores: JSON.parse(f.errores) as string[],
    })),
    };
  });
}


// --- Plazos (fase determinista) ---

/** Plazo guardado más los días que faltan para el cierre desde `hoy` (negativo = ya cerrada; null = desconocida). */
export interface PlazoGuardado extends Plazo {
  diasHastaCierre: number | null;
}

export function conDiasHastaCierre(p: Plazo, hoy: string): PlazoGuardado {
  return { ...p, diasHastaCierre: p.fechaCierre ? diasEntre(hoy, p.fechaCierre) : null };
}

export function guardarPlazo(db: DatabaseSync, convocatoriaId: string, p: Plazo, ahora: Date): void {
  db.prepare(`
    INSERT INTO plazos (convocatoria_id, fecha_cierre, tipo, texto_original, fecha_base, base_origen, aproximada, detalle, calculado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (convocatoria_id) DO UPDATE SET fecha_cierre = excluded.fecha_cierre, tipo = excluded.tipo,
      texto_original = excluded.texto_original, fecha_base = excluded.fecha_base, base_origen = excluded.base_origen,
      aproximada = excluded.aproximada, detalle = excluded.detalle, calculado_en = excluded.calculado_en
  `).run(convocatoriaId, p.fechaCierre, p.tipo, p.textoOriginal, p.fechaBase, p.baseOrigen, Number(p.aproximada), p.detalle, ahora.toISOString());
}

function filaAPlazo(f: Record<string, unknown>): Plazo {
  return {
    fechaCierre: (f.fecha_cierre as string | null) ?? null, tipo: f.tipo as Plazo['tipo'],
    textoOriginal: (f.texto_original as string | null) ?? null, fechaBase: (f.fecha_base as string | null) ?? null,
    baseOrigen: (f.base_origen as Plazo['baseOrigen']) ?? null, aproximada: f.aproximada === 1, detalle: String(f.detalle),
  };
}

export function leerPlazo(db: DatabaseSync, convocatoriaId: string, hoy: string): PlazoGuardado | null {
  const f = db.prepare('SELECT * FROM plazos WHERE convocatoria_id = ?').get(convocatoriaId) as Record<string, unknown> | undefined;
  return f ? conDiasHastaCierre(filaAPlazo(f), hoy) : null;
}

/** Plazos de varias convocatorias a la vez (id → plazo). */
export function leerPlazos(db: DatabaseSync, ids: string[], hoy: string): Map<string, PlazoGuardado> {
  const r = new Map<string, PlazoGuardado>();
  const q = db.prepare('SELECT * FROM plazos WHERE convocatoria_id = ?');
  for (const id of ids) {
    const f = q.get(id) as Record<string, unknown> | undefined;
    if (f) r.set(id, conDiasHastaCierre(filaAPlazo(f), hoy));
  }
  return r;
}

/**
 * Candidatas en juego con fecha de cierre conocida entre `desde` y `hasta` (YYYY-MM-DD, incluidos), por cierre más próximo:
 * base de "cierran pronto" (Task 4). Las ya cerradas quedan fuera si `desde` es hoy.
 */
export function cierresEntre(db: DatabaseSync, desde: string, hasta: string, hoy: string): (FilaConvocatoria & { plazo: PlazoGuardado })[] {
  const filas = db.prepare(`
    SELECT c.id, c.fuente, c.titulo, c.organo_nivel1, c.organo_nivel2, c.organo_nivel3, c.fecha_publicacion, c.url, p.*
    FROM convocatorias c JOIN plazos p ON p.convocatoria_id = c.id
    WHERE p.fecha_cierre BETWEEN ? AND ? AND ${EN_JUEGO} AND ${NO_DESCARTADA_POR_EQUIPO} AND ${NO_LICITACION}
    ORDER BY p.fecha_cierre, c.id
  `).all(desde, hasta) as Record<string, string | null>[];
  return filas.map((f) => ({
    id: f.id!, fuente: f.fuente!, titulo: f.titulo!, organo: organoLegible(f), fechaPublicacion: f.fecha_publicacion!, url: f.url!,
    plazo: conDiasHastaCierre(filaAPlazo(f), hoy),
  }));
}

/** Candidatas en juego (reglas y fases) de cualquier fecha de publicación, para recalcular su plazo. */
export function enJuegoTodas(db: DatabaseSync): Convocatoria[] {
  const filas = db.prepare(`SELECT * FROM convocatorias c WHERE ${EN_JUEGO} ORDER BY c.fecha_publicacion DESC, c.id`).all() as Record<string, unknown>[];
  return filas.map(filaAConvocatoria);
}

// --- Puntuación (fase determinista) ---

export interface PuntuacionGuardada extends Puntuacion {
  calculadoEn: string;
}

export function guardarPuntuacion(db: DatabaseSync, convocatoriaId: string, p: Puntuacion, ahora: Date): void {
  db.prepare(`
    INSERT INTO puntuaciones (convocatoria_id, total, excluida, analizada, factores, calculado_en) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (convocatoria_id) DO UPDATE SET total = excluded.total, excluida = excluded.excluida,
      analizada = excluded.analizada, factores = excluded.factores, calculado_en = excluded.calculado_en
  `).run(convocatoriaId, p.total, p.excluida, Number(p.analizada), JSON.stringify(p.factores), ahora.toISOString());
}

export function leerPuntuacion(db: DatabaseSync, convocatoriaId: string): PuntuacionGuardada | null {
  const f = db.prepare('SELECT * FROM puntuaciones WHERE convocatoria_id = ?').get(convocatoriaId) as Record<string, unknown> | undefined;
  if (!f) return null;
  return {
    total: Number(f.total), excluida: (f.excluida as string | null) ?? null, analizada: f.analizada === 1,
    factores: JSON.parse(String(f.factores)) as Puntuacion['factores'], calculadoEn: String(f.calculado_en),
  };
}

/** Candidata en juego con lo necesario para el ranking: primera vez vista, plazo (días desde `hoy`) y última puntuación. */
export interface FilaRanking extends FilaConvocatoria {
  primeraVez: string;
  plazo: PlazoGuardado | null;
  puntuacion: PuntuacionGuardada | null;
}

/**
 * `puntuador` calcula la puntuación en el momento de la petición (con el reloj de ahora): así el factor de cierre, el total
 * y las secciones son coherentes. Lo guardado por la última pasada (`puntuaciones`) es solo registro.
 */
export function filasRanking(
  db: DatabaseSync, hoy: string, puntuador: (c: Convocatoria, plazo: PlazoGuardado | null) => Puntuacion, ahora: Date,
): FilaRanking[] {
  return filasPuntuadas(db, hoy, puntuador, ahora, NO_LICITACION);
}

/** Licitaciones abiertas que pasaron la criba LLM y no ha descartado el equipo, puntuadas con el reloj de ahora (ver `filasRanking`). */
export function filasLicitaciones(
  db: DatabaseSync, hoy: string, puntuador: (c: Convocatoria, plazo: PlazoGuardado | null) => Puntuacion, ahora: Date,
): FilaRanking[] {
  return filasPuntuadas(db, hoy, puntuador, ahora, `c.fuente = '${FUENTE_LICITACIONES}'`);
}

function filasPuntuadas(
  db: DatabaseSync, hoy: string, puntuador: (c: Convocatoria, plazo: PlazoGuardado | null) => Puntuacion, ahora: Date, filtro: string,
): FilaRanking[] {
  const filas = db.prepare(`SELECT * FROM convocatorias c WHERE ${EN_JUEGO} AND ${CRIBADA} AND ${NO_DESCARTADA_POR_EQUIPO} AND ${filtro} ORDER BY c.fecha_publicacion DESC, c.id DESC`).all() as Record<string, string | null>[];
  return filas.map((f) => {
    const plazo = leerPlazo(db, f.id!, hoy);
    const p = puntuador(filaAConvocatoria(f), plazo);
    return {
      id: f.id!, fuente: f.fuente!, titulo: f.titulo!, organo: organoLegible(f), fechaPublicacion: f.fecha_publicacion!, url: f.url!,
      primeraVez: f.primera_vez!, plazo, puntuacion: { ...p, calculadoEn: ahora.toISOString() },
    };
  });
}

// --- Estado propio de una fuente entre ejecuciones (p. ej. el cursor del feed de licitaciones) ---

export function leerEstadoFuente(db: DatabaseSync, fuente: string, clave: string): string | null {
  const f = db.prepare('SELECT valor FROM fuente_estado WHERE fuente = ? AND clave = ?').get(fuente, clave) as { valor: string } | undefined;
  return f?.valor ?? null;
}

export function guardarEstadoFuente(db: DatabaseSync, fuente: string, clave: string, valor: string, ahora: Date): void {
  db.prepare(`
    INSERT INTO fuente_estado (fuente, clave, valor, actualizado_en) VALUES (?, ?, ?, ?)
    ON CONFLICT (fuente, clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
  `).run(fuente, clave, valor, ahora.toISOString());
}

/** Borra las puntuaciones guardadas de convocatorias que ya no están en juego (descartadas después de puntuarse). */
export function borrarPuntuacionesFueraDeJuego(db: DatabaseSync): number {
  return Number(db.prepare(`DELETE FROM puntuaciones WHERE convocatoria_id NOT IN (SELECT c.id FROM convocatorias c WHERE ${EN_JUEGO})`).run().changes);
}

/**
 * Para la predicción de apertura de series: números BDNS de las convocatorias guardadas que pasaron la criba LLM y siguen en juego y no las
 * descartó el equipo (`relevantes`), y los de las que sí descartó el equipo (`descartadasPorEquipo`).
 */
export function relevantesBdns(db: DatabaseSync): { relevantes: Set<string>; descartadasPorEquipo: Set<string> } {
  const numeros = (cond: string) => new Set((db.prepare(`SELECT c.fuente_id AS n FROM convocatorias c WHERE c.fuente = 'bdns' AND ${cond}`).all() as { n: string }[]).map((r) => r.n));
  return {
    relevantes: numeros(`${EN_JUEGO} AND ${CRIBADA} AND ${NO_DESCARTADA_POR_EQUIPO}`),
    descartadasPorEquipo: numeros(`NOT (${NO_DESCARTADA_POR_EQUIPO})`),
  };
}
