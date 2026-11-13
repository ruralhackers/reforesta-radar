// Acceso a datos. Funciones pequeñas sobre DatabaseSync; nada de lógica de negocio.
import type { DatabaseSync } from 'node:sqlite';
import type { Convocatoria, Cribada, Perfil, Semilla } from '../types.ts';

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
    const fun = db.prepare('INSERT OR IGNORE INTO fundaciones (nombre, url, notas) VALUES (?, ?, ?)');
    for (const f of s.fundaciones) fun.run(f.nombre, f.url, f.notas);
  });
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

/** SQL: la fila `c` sigue en juego (sin descarte de reglas ni de fases; si tiene condición, la criba LLM la aceptó). */
const EN_JUEGO = `
  c.descarte_regla IS NULL
  AND NOT EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.descarta = 1)
  AND (c.condicion IS NULL OR EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.fase = 'criba_llm' AND f.descarta = 0))
`;

/**
 * Candidatas publicadas entre dos días incluidos, más recientes primero: sin descarte de reglas ni de ninguna fase,
 * y las que llevan condición (otra comunidad) solo si la criba LLM ya las dio por buenas.
 */
export function candidatasEntre(db: DatabaseSync, desde: string, hasta: string): FilaConvocatoria[] {
  const filas = db.prepare(`
    SELECT id, fuente, titulo, organo_nivel1, organo_nivel2, organo_nivel3, fecha_publicacion, url
    FROM convocatorias c
    WHERE fecha_publicacion BETWEEN ? AND ? AND ${EN_JUEGO}
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
 * Convocatorias pendientes de `fase`: siguen en juego según las reglas y las fases anteriores, no tienen veredicto
 * de `fase` y se publicaron desde `publicadasDesde` (YYYY-MM-DD) — da igual que la fuente las haya vuelto a devolver
 * en esta ejecución: lo omitido por el tope o por un error se recupera en la siguiente aunque ya no esté en la ventana.
 * `requiereFase` exige además un veredicto no descartante de otra fase. Más recientes primero.
 */
export function pendientesDeFase(
  db: DatabaseSync, fase: string, publicadasDesde: string, requiereFase: string | null = null,
): { convocatoria: Convocatoria; condicion: string | null }[] {
  const filas = db.prepare(`
    SELECT * FROM convocatorias c
    WHERE c.fecha_publicacion >= ? AND c.descarte_regla IS NULL
      AND NOT EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND (f.fase = ? OR f.descarta = 1))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM convocatoria_fases f WHERE f.convocatoria_id = c.id AND f.fase = ? AND f.descarta = 0))
    ORDER BY c.fecha_publicacion DESC, c.id
  `).all(publicadasDesde, fase, requiereFase, requiereFase) as Record<string, unknown>[];
  return filas.map((f) => ({ convocatoria: filaAConvocatoria(f), condicion: (f.condicion as string | null) ?? null }));
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
