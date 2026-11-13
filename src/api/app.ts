// API HTTP (Hono). Sin estado propio: lee de la BD. `crearApi` es el punto de prueba (app.request en memoria).
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { diaLocal, sumarDias } from '../dates.ts';
import { descartesEntre, leerConvocatoria, leerPerfil, leerPlazo, ultimasEjecuciones, type VeredictoFase } from '../db/repo.ts';
import { crearProbabilidad, ganadoresPrevios, resumirHistorial } from '../ganadores.ts';
import { FASE_ANALISIS } from '../fases/analisis.ts';
import type { Analisis } from '../fases/analisis-esquema.ts';
import { FASE_CRIBA } from '../fases/criba.ts';
import { puntuarConvocatoria } from '../fases/puntuacion.ts';
import { type ConfigPuntuacion, leerConfigPuntuacion, type ProveedorProbabilidad } from '../puntuacion.ts';
import { seccionParecidas } from '../ranking.ts';
import { calcularRanking } from '../semana.ts';
import { infoParecidas } from '../parecidas.ts';
import { activarParecida, altaParecidaManual, leerParecidasConAportes, NIF_ENTIDAD_VALIDO, quitarParecidaManual } from '../db/ganadores.ts';
import { anadirNota, borrarNota, decidir, deshacerDecision, ErrorDecision, leerDecision, leerDecisiones, leerNotas, MOTIVOS_DESCARTE, nosInteresa } from '../db/decisiones.ts';
import { actualizarEmpresa, ErrorEmpresa, ESTADOS_EMPRESA, type EstadoEmpresa, leerEmpresas } from '../db/empresas.ts';
import { activarFuente, altaFuente, ErrorFundacion, leerFuentesVigiladas, quitarFuente } from '../db/fundaciones.ts';
import { config } from '../config.ts';
import { crearAcceso, type OpcionesEquipo } from './equipo.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import { ErrorPerfil, guardarPerfilEditable, validarPerfilEditable } from '../perfil.ts';
import type { Reloj } from '../types.ts';

const DIA = /^\d{4}-\d{2}-\d{2}$/;

export function crearApi({ db, reloj, fuentes, puntuacion, probabilidad: probabilidadInyectada, equipo: opcionesEquipo }: { db: DatabaseSync; reloj: Reloj; fuentes?: Fuente[]; puntuacion?: ConfigPuntuacion; probabilidad?: ProveedorProbabilidad; equipo?: OpcionesEquipo }): Hono {
  const api = new Hono();
  // Modo privado (TEAM_PASSWORD): ver src/api/equipo.ts. `acceso.requiereEquipo` es el marcador de lo privado.
  const acceso = crearAcceso(opcionesEquipo ?? config.equipo);
  api.route('/sesion', acceso.sesion);
  const cfg = puntuacion ?? leerConfigPuntuacion(config.rutaPuntuacion);
  // Por defecto, la probabilidad sale de los ganadores previos y las organizaciones parecidas guardadas.
  const probabilidad = probabilidadInyectada ?? crearProbabilidad(db);

  api.get('/salud', (c) => c.json({ ok: true }));

  /**
   * "Esta semana": ranking por puntuación dividido en "cierran pronto" (cierre en `cierranProntoDias` días o menos) y
   * "nuevas" (vistas por primera vez en los últimos `nuevasDias` días); cada convocatoria sale en una sola sección
   * (cierran pronto manda). Las cerradas y las excluidas no salen. Ver src/ranking.ts.
   * `convocatorias` ya viene en orden: "cierran_pronto", "nuevas" y "abiertas" (el resto de abiertas, con cierre lejano o desconocido), cada una por puntuación.
   */
  api.get('/semana', (c) => {
    const hasta = diaLocal(reloj.now());
    const { nuevasDias, cierranProntoDias } = cfg;
    const filas = calcularRanking(db, reloj.now(), cfg, probabilidad);
    return c.json({
      desde: sumarDias(hasta, -(nuevasDias - 1)),
      hasta,
      nuevasDias,
      cierranProntoDias,
      // plazo: { fechaCierre, tipo (literal|calculada|desconocida), textoOriginal, fechaBase, baseOrigen, aproximada, detalle, diasHastaCierre }
      // puntuacion: { total 0-100, factores: [{ id, nombre, peso, subpuntuacion 0-1, conocido, explicacion }], analizada, calculadoEn } | null
      convocatorias: filas.map(({ primeraVez, puntuacion, ...f }) => ({
        ...f,
        primeraVez,
        puntuacion: puntuacion && { total: puntuacion.total, analizada: puntuacion.analizada, factores: puntuacion.factores, calculadoEn: puntuacion.calculadoEn },
      })),
      // Ids (ya en orden por puntuación) de la lista "las ganan organizaciones como vosotros": paralela, repite convocatorias de las secciones de arriba.
      lasGananParecidas: seccionParecidas(filas).map((f) => f.id),
      ultimaEjecucion: ultimasEjecuciones(db, 1)[0] ?? null,
    });
  });

  // --- Fundaciones y agregadores vigilados ---
  // GET público (nombre, URL, última revisión, último cambio y último error: nada del equipo). Altas, bajas y activación en `privadaFundaciones`.
  // Lo que se añade o quita cuenta desde la siguiente ejecución del radar (la fuente lee la tabla en cada pasada).
  api.get('/fundaciones', (c) => c.json({ fundaciones: leerFuentesVigiladas(db).map(({ huella: _huella, ...f }) => f) }));

  const privadaFundaciones = new Hono();
  privadaFundaciones.use('*', acceso.requiereEquipo);
  const idDe = (c: { req: { param: (k: string) => string } }) => Number(c.req.param('id'));
  const fallo = (e: unknown) => {
    if (e instanceof ErrorFundacion) return { cuerpo: { error: e.message }, estado: e.estado };
    throw e;
  };
  privadaFundaciones.post('/', async (c) => {
    const cuerpo = await c.req.json().catch(() => null) as { nombre?: unknown; url?: unknown; tipo?: unknown } | null;
    try {
      const { huella: _h, ...f } = altaFuente(db, { nombre: cuerpo?.nombre, url: cuerpo?.url, tipo: cuerpo?.tipo });
      return c.json(f, 201);
    } catch (e) {
      const r = fallo(e);
      return c.json(r.cuerpo, r.estado);
    }
  });
  privadaFundaciones.patch('/:id', async (c) => {
    const cuerpo = await c.req.json().catch(() => null) as { activa?: unknown } | null;
    if (typeof cuerpo?.activa !== 'boolean') return c.json({ error: 'Falta "activa" (true o false)' }, 400);
    try {
      activarFuente(db, idDe(c), cuerpo.activa);
      return c.json({ id: idDe(c), activa: cuerpo.activa });
    } catch (e) {
      const r = fallo(e);
      return c.json(r.cuerpo, r.estado);
    }
  });
  privadaFundaciones.delete('/:id', (c) => {
    try {
      quitarFuente(db, idDe(c));
      return c.json({ quitada: true });
    } catch (e) {
      const r = fallo(e);
      return c.json(r.cuerpo, r.estado);
    }
  });
  api.route('/fundaciones', privadaFundaciones);

  // --- Organizaciones parecidas (ajuste desde la web) ---
  // GET es de lectura. Las escrituras (PATCH/POST/DELETE) van en `privada`, un sub-router aparte: Task 9 le pone el middleware de
  // TEAM_PASSWORD con una sola línea (`privada.use('*', ...)`) sin tocar las rutas.
  api.get('/parecidas', (c) => c.json({ parecidas: leerParecidasConAportes(db) }));

  const privada = new Hono();
  privada.use('*', acceso.requiereEquipo);
  privada.patch('/:nif', async (c) => {
    const cuerpo = await c.req.json().catch(() => null) as { activa?: unknown } | null;
    if (typeof cuerpo?.activa !== 'boolean') return c.json({ error: 'Falta "activa" (true o false)' }, 400);
    if (!activarParecida(db, c.req.param('nif').toUpperCase(), cuerpo.activa, reloj.now())) return c.json({ error: 'No existe esa organización' }, 404);
    return c.json({ nif: c.req.param('nif').toUpperCase(), activa: cuerpo.activa });
  });
  privada.post('/', async (c) => {
    const cuerpo = await c.req.json().catch(() => null) as { nif?: unknown; nombre?: unknown } | null;
    const nif = typeof cuerpo?.nif === 'string' ? cuerpo.nif.replace(/[\s.-]/g, '').toUpperCase() : '';
    if (!NIF_ENTIDAD_VALIDO.test(nif)) return c.json({ error: 'NIF/CIF de entidad no válido (una letra, siete cifras y un control, p. ej. G78456118)' }, 400);
    const nombre = typeof cuerpo?.nombre === 'string' && cuerpo.nombre.trim() ? cuerpo.nombre.trim().slice(0, 120) : null;
    if (!altaParecidaManual(db, nif, nombre, reloj.now())) return c.json({ error: 'Ya está en la lista (puedes activarla)' }, 409);
    return c.json({ nif, nombre: nombre ?? nif, origen: 'manual', activa: true }, 201);
  });
  privada.delete('/:nif', (c) => {
    const nif = c.req.param('nif').toUpperCase();
    const r = quitarParecidaManual(db, nif);
    if (r === 'no_existe') return c.json({ error: 'No existe esa organización' }, 404);
    if (r === 'no_manual') return c.json({ error: 'Solo se pueden quitar las añadidas a mano; las demás se desactivan' }, 409);
    return c.json({ nif, quitada: true });
  });
  api.route('/parecidas', privada);

  // --- Perfil editable (líneas de trabajo, ámbito, importe mínimo). NIF e idPersona solo se leen. ---
  // PUT va en su propio sub-router `privadaPerfil` (Task 9: `privadaPerfil.use('*', ...)`).
  const vistaPerfil = (p: NonNullable<ReturnType<typeof leerPerfil>>) => ({
    nombre: p.nombre, nif: p.nif, bdnsIdPersona: p.bdnsIdPersona, lineas: p.lineas, ambito: p.ambito, importeMinimo: p.importeMinimo,
  });
  api.get('/perfil', (c) => {
    const p = leerPerfil(db);
    return p ? c.json(vistaPerfil(p)) : c.json({ error: 'La base de datos no tiene perfil' }, 404);
  });
  const privadaPerfil = new Hono();
  privadaPerfil.use('*', acceso.requiereEquipo);
  privadaPerfil.put('/', async (c) => {
    const cuerpo = await c.req.json().catch(() => undefined);
    if (cuerpo === undefined) return c.json({ error: 'El cuerpo no es JSON válido' }, 400);
    try {
      return c.json(vistaPerfil(guardarPerfilEditable(db, validarPerfilEditable(cuerpo), reloj.now())));
    } catch (e) {
      if (e instanceof ErrorPerfil) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  api.route('/perfil', privadaPerfil);

  // --- Decisiones del equipo y notas ---
  // LECTURAS en un solo sitio (`equipo`, montado en /api/equipo): son lo que Task 9 esconderá cuando haya TEAM_PASSWORD
  // (`equipo.use('*', ...)`). ESCRITURAS en `privadaDecisiones` (/api/decisiones), el sub-router para su middleware.
  // Lo descartado por el equipo ya no sale en /api/semana (ni en la lista paralela de parecidas); ver NO_DESCARTADA_POR_EQUIPO en db/repo.ts.
  const equipo = new Hono();
  equipo.use('*', acceso.requiereEquipo);
  /** Motivos de descarte de un clic (el último, "Otro", exige texto libre). */
  equipo.get('/motivos', (c) => c.json({ motivos: MOTIVOS_DESCARTE }));
  /** Todas las decisiones: [{ convocatoriaId, decision, motivo, detalle, decididaEn }], las más recientes primero. */
  equipo.get('/decisiones', (c) => c.json({ decisiones: leerDecisiones(db) }));
  /** "Nos interesa" por plazo (cierre más próximo primero, plazo desconocido al final) con los días que faltan (negativo = cerrada). */
  equipo.get('/nos-interesa', (c) => c.json({ hasta: diaLocal(reloj.now()), convocatorias: nosInteresa(db, diaLocal(reloj.now())) }));
  /** Decisión (o null) y notas de una convocatoria. */
  equipo.get('/convocatorias/:id', (c) => {
    const id = c.req.param('id');
    if (!leerConvocatoria(db, id)) return c.json({ error: 'No existe' }, 404);
    return c.json({ decision: leerDecision(db, id), notas: leerNotas(db, id) });
  });
  const filtroEstado = (c: { req: { query: (k: string) => string | undefined } }): EstadoEmpresa | null | 'invalido' => {
    const e = c.req.query('estado');
    if (!e) return null;
    return (ESTADOS_EMPRESA as readonly string[]).includes(e) ? (e as EstadoEmpresa) : 'invalido';
  };
  equipo.get('/empresas', (c) => {
    const estado = filtroEstado(c);
    if (estado === 'invalido') return c.json({ error: `"estado" debe ser uno de: ${ESTADOS_EMPRESA.join(', ')}` }, 400);
    return c.json({ empresas: leerEmpresas(db, { estado, conNota: true }) });
  });
  api.route('/equipo', equipo);

  const privadaDecisiones = new Hono();
  privadaDecisiones.use('*', acceso.requiereEquipo);
  const respuestaDecision = (c: { json: (o: object, s?: 400 | 404) => Response }, e: unknown) => {
    if (e instanceof ErrorDecision) return c.json({ error: e.message }, e.estado);
    throw e;
  };
  /** Cuerpo: { decision: 'nos_interesa' } | { decision: 'descartada', motivo, detalle? }. Cambia la decisión si ya había una. */
  privadaDecisiones.put('/:id', async (c) => {
    const cuerpo = await c.req.json().catch(() => undefined);
    if (cuerpo === undefined) return c.json({ error: 'El cuerpo no es JSON válido' }, 400);
    try { return c.json(decidir(db, c.req.param('id'), cuerpo, reloj.now())); } catch (e) { return respuestaDecision(c, e); }
  });
  /** Deshace la decisión. */
  privadaDecisiones.delete('/:id', (c) => (deshacerDecision(db, c.req.param('id')) ? c.json({ deshecha: true }) : c.json({ error: 'No había decisión' }, 404)));
  /** Cuerpo: { texto, autor? }. */
  privadaDecisiones.post('/:id/notas', async (c) => {
    const cuerpo = await c.req.json().catch(() => undefined);
    if (cuerpo === undefined) return c.json({ error: 'El cuerpo no es JSON válido' }, 400);
    try { return c.json(anadirNota(db, c.req.param('id'), cuerpo, reloj.now()), 201); } catch (e) { return respuestaDecision(c, e); }
  });
  privadaDecisiones.delete('/:id/notas/:notaId', (c) => (borrarNota(db, c.req.param('id'), Number(c.req.param('notaId'))) ? c.json({ borrada: true }) : c.json({ error: 'No existe esa nota' }, 404)));
  api.route('/decisiones', privadaDecisiones);

  // --- Empresas (canal de empresas: DIA del BOE con medidas de restauración) ---
  // GET público (empresa, motivo, cita, enlace al BOE, provincia, estado y señales; SIN la nota del equipo). La nota va solo en la lectura del equipo
  // (/api/equipo/empresas). Estado y nota se escriben en `privadaEmpresas` (cuerpo { estado?, nota? }). `?estado=` filtra.
  api.get('/empresas', (c) => {
    const estado = filtroEstado(c);
    if (estado === 'invalido') return c.json({ error: `"estado" debe ser uno de: ${ESTADOS_EMPRESA.join(', ')}` }, 400);
    return c.json({ empresas: leerEmpresas(db, { estado }) });
  });
  const privadaEmpresas = new Hono();
  privadaEmpresas.use('*', acceso.requiereEquipo);
  privadaEmpresas.patch('/:id', async (c) => {
    const cuerpo = await c.req.json().catch(() => undefined);
    if (cuerpo === undefined) return c.json({ error: 'El cuerpo no es JSON válido' }, 400);
    try {
      return c.json(actualizarEmpresa(db, Number(c.req.param('id')), cuerpo, reloj.now()));
    } catch (e) {
      if (e instanceof ErrorEmpresa) return c.json({ error: e.message }, e.estado);
      throw e;
    }
  });
  api.route('/empresas', privadaEmpresas);

  /**
   * Descartadas con su motivo (reglas y fases). Por defecto, los últimos 7 días.
   * `?por=criba_llm` (o `analisis`, `regla:ambito`…) filtra; `?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` cambia la ventana.
   */
  api.get('/descartes', (c) => {
    const hoy = diaLocal(reloj.now());
    const hasta = DIA.test(c.req.query('hasta') ?? '') ? c.req.query('hasta')! : hoy;
    const desde = DIA.test(c.req.query('desde') ?? '') ? c.req.query('desde')! : sumarDias(hasta, -6);
    const por = c.req.query('por') || null;
    return c.json({ desde, hasta, por, convocatorias: descartesEntre(db, desde, hasta, por) });
  });

  /** Ficha de una convocatoria: datos de la fuente, veredictos de criba y análisis (campos con cita) y enlaces. */
  api.get('/convocatorias/:id', (c) => {
    const g = leerConvocatoria(db, c.req.param('id'));
    if (!g) return c.json({ error: 'No existe' }, 404);
    const conv = g.convocatoria;
    const fase = (nombre: string): VeredictoFase | null => g.fases.find((f) => f.fase === nombre) ?? null;
    const criba = fase(FASE_CRIBA);
    const analisis = fase(FASE_ANALISIS);
    const datosAnalisis = analisis?.datos as { analisis: Analisis; modelo: string; documentos: unknown; documentosConError: string[] } | undefined;
    const enJuego = !g.descarte && !g.fases.some((f) => f.descarta) && (!g.condicion || (criba !== null && !criba.descarta));
    const perfil = leerPerfil(db);
    const previos = perfil ? ganadoresPrevios(db, conv, perfil) : { esSerie: false, ediciones: [] };
    const historial = resumirHistorial(db, previos);
    return c.json({
      id: conv.id,
      fuente: conv.fuente,
      titulo: conv.titulo,
      organo: [conv.organo.nivel1, conv.organo.nivel2, conv.organo.nivel3].filter(Boolean).join(' · '),
      fechaPublicacion: conv.fechaPublicacion,
      url: conv.url,
      tipo: conv.tipo,
      finalidad: conv.finalidad,
      abierto: conv.abierto,
      descarte: g.descarte,
      condicion: g.condicion,
      enJuego,
      criba: criba && { descarta: criba.descarta, motivo: criba.motivo, ...(criba.datos as object) },
      analisis: analisis && datosAnalisis
        ? {
          descarta: analisis.descarta,
          motivo: analisis.motivo,
          modelo: datosAnalisis.modelo,
          campos: datosAnalisis.analisis,
          documentos: datosAnalisis.documentos,
          documentosConError: datosAnalisis.documentosConError,
        }
        : null,
      plazo: leerPlazo(db, conv.id, diaLocal(reloj.now())),
      // Calculada ahora con el reloj de la petición; null si la convocatoria ya no está en juego (descartada).
      // `excluida` = motivo por el que no entra en el ranking (cerrada).
      puntuacion: enJuego ? { ...puntuarConvocatoria(db, conv, leerPlazo(db, conv.id, diaLocal(reloj.now())), leerPerfil(db)?.importeMinimo ?? null, cfg, probabilidad), calculadoEn: reloj.now().toISOString() } : null,
      // Quién la ganó antes: su propia resolución (si ya la hay) y las ediciones anteriores de su serie (mismo órgano y título salvo el año).
      // Cada edición: { numeroConvocatoria, anio, titulo, url, propia, ganadores: [{ nombre, nif, importe, fechaConcesion, esReforesta, esParecida }], importeTotal,
      // reforesta: 'gano' | 'no_figura' | 'sin_datos', importeReforesta }. BDNS solo publica ganadores: 'no_figura' no significa que la perdiera.
      ganadoresPrevios: {
        esSerie: previos.esSerie,
        ediciones: previos.ediciones,
        reforestaGano: historial.ganadasPorReforesta.map((e) => ({ numeroConvocatoria: e.numeroConvocatoria, anio: e.anio, importe: e.importeReforesta })),
        parecidas: historial.parecidas,
      },
      // Las parecidas activas relacionadas (origen del descubrimiento y/o entre los ganadores previos); null si ninguna.
      parecidas: infoParecidas(db, conv, perfil),
      enlaces: fuentePorNombre(conv.fuente, fuentes)?.enlaces?.(conv) ?? [{ tipo: 'ficha', titulo: 'Ficha en la fuente', url: conv.url }],
    });
  });

  api.get('/ejecuciones', (c) => c.json(ultimasEjecuciones(db, 20)));

  return api;
}
