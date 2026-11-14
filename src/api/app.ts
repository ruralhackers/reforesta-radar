// API HTTP (Hono). Sin estado propio: lee de la BD. `crearApi` es el punto de prueba (app.request en memoria).
import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { diaLocal, sumarDias } from '../dates.ts';
import { descartesEntre, leerConvocatoria, leerPerfil, leerPlazo, ultimasEjecuciones, type VeredictoFase } from '../db/repo.ts';
import { crearProbabilidad, ganadoresPrevios, resumirHistorial } from '../ganadores.ts';
import { FASE_ANALISIS } from '../fases/analisis.ts';
import type { Analisis } from '../fases/analisis-esquema.ts';
import { FASE_CRIBA } from '../fases/criba.ts';
import { puntuarConvocatoria } from '../fases/puntuacion.ts';
import { type ConfigPuntuacion, leerConfigPuntuacion, type ProveedorProbabilidad } from '../puntuacion.ts';
import { seccionParecidas } from '../ranking.ts';
import { calcularSemana, resumenTarjeta } from '../semana.ts';
import { calcularLicitaciones, resumenTarjetaLicitacion } from '../licitaciones.ts';
import { esAnalisisLicitacion } from '../fases/analisis-licitacion-esquema.ts';
import { licitacionDe } from '../sources/placsp.ts';
import { PROXIMAS_DIAS_POR_DEFECTO, serieDeConvocatoria, seriesProximas } from '../series.ts';
import { tituloParaMostrar } from '../titulo.ts';
import { infoParecidas } from '../parecidas.ts';
import { activarParecida, altaParecidaManual, leerParecidasConAportes, NIF_ENTIDAD_VALIDO, quitarParecidaManual } from '../db/ganadores.ts';
import { anadirNota, borrarNota, decidir, deshacerDecision, ErrorDecision, leerDecision, leerDecisiones, leerNotas, MOTIVOS_DESCARTE, nosInteresa } from '../db/decisiones.ts';
import { actualizarEmpresa, contarEmpresasBaja, ErrorEmpresa, ESTADOS_EMPRESA, type EstadoEmpresa, leerEmpresas } from '../db/empresas.ts';
import { activarFuente, altaFuente, ErrorFundacion, leerFuentesVigiladas, quitarFuente } from '../db/fundaciones.ts';
import { construirInforme, type Informe } from '../backtest/informe.ts';
import { config } from '../config.ts';
import { financiadoresConocidos, proyectosPropios, resumenMemorias, claveFinanciador } from '../db/memorias.ts';
import { aniosMemorias, experienciaRelacionada } from '../memorias.ts';
import { crearAcceso, type OpcionesEquipo } from './equipo.ts';
import { fuentePorNombre } from '../sources/index.ts';
import type { Fuente } from '../sources/source.ts';
import { ErrorPerfil, guardarPerfilEditable, umbralDelPerfil, validarPerfilEditable } from '../perfil.ts';
import type { Reloj } from '../types.ts';

const DIA = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_CUERPO = 64 * 1024;

export function crearApi(opciones: { db: DatabaseSync; reloj: Reloj; fuentes?: Fuente[]; puntuacion?: ConfigPuntuacion; probabilidad?: ProveedorProbabilidad; equipo?: OpcionesEquipo; rutaBacktest?: string }): Hono {
  const { db, reloj, fuentes, puntuacion, probabilidad: probabilidadInyectada, equipo: opcionesEquipo } = opciones;
  const api = new Hono();
  // Ningún cuerpo legítimo (perfil, nota, decisión, alta de fuente) pasa de unos KB: tope de 64 KB para todo /api.
  api.use('*', bodyLimit({ maxSize: MAX_CUERPO, onError: (c) => c.json({ error: `El cuerpo de la petición es demasiado grande (máximo ${MAX_CUERPO / 1024} KB)` }, 413) }));
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
    const s = calcularSemana(db, reloj.now(), cfg, probabilidad);
    return c.json({
      desde: sumarDias(hasta, -(nuevasDias - 1)),
      hasta,
      nuevasDias,
      cierranProntoDias,
      // plazo: { fechaCierre, tipo (literal|calculada|desconocida), textoOriginal, fechaBase, baseOrigen, aproximada, detalle, diasHastaCierre }
      // puntuacion: { total 0-100, factores: [{ id, nombre, peso, subpuntuacion 0-1, conocido, explicacion }], analizada, calculadoEn } | null
      // tarjeta: { tituloCorto, importe, lineas, porQue } (ver ResumenTarjeta en src/semana.ts)
      convocatorias: s.filas.map(({ primeraVez, puntuacion, ...f }) => ({
        ...f,
        primeraVez,
        puntuacion: puntuacion && { total: puntuacion.total, analizada: puntuacion.analizada, factores: puntuacion.factores, calculadoEn: puntuacion.calculadoEn },
        tarjeta: resumenTarjeta(db, f.id, f.titulo, puntuacion),
      })),
      // Ids (ya en orden por puntuación) de la lista "las ganan organizaciones como vosotros": paralela, repite convocatorias de las secciones de arriba.
      lasGananParecidas: seccionParecidas(s.filas).map((f) => f.id),
      // El corte: `paraPreparar` = analizadas con puntuación >= `umbral` (el del perfil), como mucho 7; `conMenosEncaje` = el resto (sin consorcio, que va aparte), plegado en la web.
      umbral: s.umbral,
      paraPreparar: s.paraPreparar.map((f) => f.id),
      conMenosEncaje: s.conMenosEncaje.map((f) => f.id),
      // La frase de arriba: N para preparar, M de ellas cierran en `cierranProntoDias` días o menos, K empresas nuevas en la ventana de "nuevas".
      // `licitaciones`: las licitaciones abiertas que pasaron la criba (página /licitaciones; no están mezcladas con las convocatorias de arriba).
      resumen: { paraPreparar: s.paraPreparar.length, cierranPronto: s.cierranPronto, empresasNuevas: s.empresasNuevas, licitaciones: calcularLicitaciones(db, reloj.now(), cfg).filas.length },
      ultimaEjecucion: ultimasEjecuciones(db, 1)[0] ?? null,
      // "Se espera que abran pronto": series (relevantes para el perfil) cuya próxima edición suele abrir en los próximos `dias` días, o que ya
      // deberían haber abierto este año (estado 'retrasada'). Cada una: { serie, titulo, estado, ventana: {desde, hasta}, prediccion: { basadaEn, texto, duracionDias, … },
      // ultimaEdicion (EdicionSerie), resumen: { ultimoPresupuesto, ganadoresTipicos, premioMedioTipico, reforestaGano } }. Nunca hay series con menos de 2 aperturas pasadas.
      proximas: { dias: cfg.proximasDias ?? PROXIMAS_DIAS_POR_DEFECTO, series: seriesProximas(db, reloj.now(), leerPerfil(db), cfg.proximasDias ?? PROXIMAS_DIAS_POR_DEFECTO) },
    });
  });

  /** Contadores del menú lateral (públicos): las de arriba de "Esta semana" y las empresas (sin baja confianza). */
  api.get('/contadores', (c) => {
    const s = calcularSemana(db, reloj.now(), cfg, probabilidad);
    return c.json({ estaSemana: s.paraPreparar.length, empresas: leerEmpresas(db).length, licitaciones: calcularLicitaciones(db, reloj.now(), cfg).filas.length });
  });

  /**
   * Licitaciones públicas abiertas (PLACSP) que pasaron la criba, de mejor a peor puntuación; `paraPreparar` = analizadas con puntuación >= `umbral`,
   * `conMenosEncaje` = el resto (sin analizar, menos encaje o fuera de escala). Cada una: { id, titulo, organo, plazo, puntuacion, tarjeta: ResumenTarjetaLicitacion }.
   * `presupuestoMaximo` = el del perfil, por encima del cual un contrato es «probablemente fuera de escala».
   */
  api.get('/licitaciones', (c) => {
    const s = calcularLicitaciones(db, reloj.now(), cfg);
    return c.json({
      hasta: diaLocal(reloj.now()),
      umbral: s.umbral,
      presupuestoMaximo: s.presupuestoMaximo,
      ingresosAnuales: s.ingresosAnuales,
      licitaciones: s.filas.map(({ primeraVez, puntuacion, ...f }) => ({
        ...f,
        primeraVez,
        puntuacion: puntuacion && { total: puntuacion.total, analizada: puntuacion.analizada, factores: puntuacion.factores, calculadoEn: puntuacion.calculadoEn },
        tarjeta: resumenTarjetaLicitacion(db, leerConvocatoria(db, f.id)!.convocatoria),
      })),
      paraPreparar: s.paraPreparar.map((f) => f.id),
      conMenosEncaje: s.conMenosEncaje.map((f) => f.id),
      ultimaEjecucion: ultimasEjecuciones(db, 1)[0] ?? null,
    });
  });

  // --- Fundaciones y agregadores vigilados ---
  // GET público (nombre, URL, última revisión, último cambio y último error: nada del equipo). Altas, bajas y activación en `privadaFundaciones`.
  // Lo que se añade o quita cuenta desde la siguiente ejecución del radar (la fuente lee la tabla en cada pasada).
  // `yaFinanciador`: la fundación figura entre los financiadores de las memorias de la entidad (por nombre normalizado); solo las de tipo fundación.
  api.get('/fundaciones', (c) => {
    const k = financiadoresConocidos(db);
    return c.json({ fundaciones: leerFuentesVigiladas(db).map(({ huella: _huella, ...f }) => ({ ...f, yaFinanciador: f.tipo === 'fundacion' ? (k.fundaciones.get(claveFinanciador(f.nombre)) ?? k.comerciales.get(claveFinanciador(f.nombre)) ?? null) : null })) });
  });

  // --- Memorias de la entidad (las lee el motor o `npm run memorias`; aquí solo se ve el resultado) ---
  // `enLista`: las direcciones del perfil; `pendientes`: las de la lista aún sin extraer; `memorias`: una fila por memoria extraída (año, proyectos, financiadores, cifras de cabecera).
  api.get('/memorias', (c) => {
    const memorias = resumenMemorias(db);
    const enLista = leerPerfil(db)?.memorias ?? [];
    const hechas = new Set(memorias.map((m) => m.url));
    return c.json({ enLista, pendientes: enLista.filter((u) => !hechas.has(u)), memorias, totales: { proyectos: memorias.reduce((n, m) => n + m.proyectos, 0), financiadores: memorias.reduce((n, m) => n + m.financiadores, 0) } });
  });

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
    nombre: p.nombre, nif: p.nif, bdnsIdPersona: p.bdnsIdPersona, domicilio: p.domicilio ?? null, lineas: p.lineas, ambito: p.ambito, importeMinimo: p.importeMinimo, umbralEncaje: umbralDelPerfil(p), memorias: p.memorias ?? [], paginaMemorias: p.paginaMemorias ?? null,
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
    const incluirBaja = c.req.query('baja') === '1';
    return c.json({ empresas: leerEmpresas(db, { estado, conNota: true, incluirBaja, perfil: leerPerfil(db) }), ocultas: incluirBaja ? 0 : contarEmpresasBaja(db, estado) });
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
  // GET público (empresa, motivo, cita, enlace al BOE, provincia y señales; SIN la nota del equipo). La nota va solo en la lectura del equipo
  // (/api/equipo/empresas). Estado y nota se escriben en `privadaEmpresas` (cuerpo { estado?, nota? }). Orden: DIA, registro con compensación, y
  // (solo con `?baja=1`) registro de baja confianza; `ocultas` = cuántas de baja confianza no se devuelven.
  // El estado (pendiente/contactada/descartada) es trabajo del equipo: en modo demo va en la lectura pública y `?estado=` filtra; en modo privado
  // la lectura pública no lo lleva y `?estado=` da 401 (el equipo lo lee y filtra en /api/equipo/empresas).
  api.get('/empresas', (c) => {
    const incluirBaja = c.req.query('baja') === '1';
    if (acceso.modoPrivado) {
      if (c.req.query('estado')) return c.json({ error: 'El filtro por estado es del equipo: entra con la contraseña (/api/equipo/empresas)' }, 401);
      return c.json({ empresas: leerEmpresas(db, { incluirBaja, perfil: leerPerfil(db) }).map(({ estado: _e, ...e }) => e), ocultas: incluirBaja ? 0 : contarEmpresasBaja(db, null) });
    }
    const estado = filtroEstado(c);
    if (estado === 'invalido') return c.json({ error: `"estado" debe ser uno de: ${ESTADOS_EMPRESA.join(', ')}` }, 400);
    return c.json({ empresas: leerEmpresas(db, { estado, incluirBaja, perfil: leerPerfil(db) }), ocultas: incluirBaja ? 0 : contarEmpresasBaja(db, estado) });
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
      // Título corto del análisis; sin él, el oficial hecho legible (nunca en mayúsculas sostenidas).
      tituloCorto: tituloParaMostrar(datosAnalisis?.analisis?.tituloCorto, conv.titulo),
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
      // `excluida` = motivo por el que no entra en el ranking (cerrada, no admite ESFL, plazo desconocido desde hace demasiado).
      puntuacion: enJuego ? { ...puntuarConvocatoria(db, conv, leerPlazo(db, conv.id, diaLocal(reloj.now())), leerPerfil(db)?.importeMinimo ?? null, cfg, probabilidad, diaLocal(reloj.now())), calculadoEn: reloj.now().toISOString() } : null,
      // Quién la ganó antes: su propia resolución (si ya la hay) y las ediciones anteriores de su serie (mismo órgano y título salvo el año).
      // Cada edición: { numeroConvocatoria, anio, titulo, url, propia, ganadores: [{ nombre, nif, importe, fechaConcesion, esReforesta, esParecida }], importeTotal,
      // reforesta: 'gano' | 'no_figura' | 'sin_datos', importeReforesta }. BDNS solo publica ganadores: 'no_figura' no significa que la perdiera.
      ganadoresPrevios: {
        esSerie: previos.esSerie,
        ediciones: previos.ediciones,
        reforestaGano: historial.ganadasPorReforesta.map((e) => ({ numeroConvocatoria: e.numeroConvocatoria, anio: e.anio, importe: e.importeReforesta })),
        parecidas: historial.parecidas,
      },
      // La serie: una fila por edición (año, apertura, cierre, presupuesto, nº de ganadores, importe medio, Reforesta ganó / no figura / sin datos)
      // y, con 2 o más aperturas pasadas, la predicción de la siguiente ({ basadaEn, texto, duracionDias, desdeDia, hastaDia }); null si no.
      serie: serieDeConvocatoria(db, conv, perfil, diaLocal(reloj.now())),
      // Las parecidas activas relacionadas (origen del descubrimiento y/o entre los ganadores previos); null si ninguna.
      parecidas: infoParecidas(db, conv, perfil),
      // Hasta 3 proyectos propios parecidos (palabras, línea, lugar; sin LLM) con enlace a su memoria; [] si no hay memorias o ninguno se parece.
      experiencia: experienciaRelacionada(proyectosPropios(db), aniosMemorias(db), {
        texto: [conv.titulo, datosAnalisis?.analisis?.tituloCorto, conv.finalidad, conv.organo.nivel2, conv.organo.nivel3].filter(Boolean).join(' '),
        lineas: datosAnalisis?.analisis?.lineas?.map((l) => l.linea) ?? [],
      }),
      enlaces: fuentePorNombre(conv.fuente, fuentes)?.enlaces?.(conv) ?? [{ tipo: 'ficha', titulo: 'Ficha en la fuente', url: conv.url }],
      // Solo licitaciones (fuente placsp): lo que dice el anuncio de la Plataforma (expediente, órgano, presupuestos, plazo, duración, procedimiento, lotes, CPV, lugar,
      // solvencia y criterios de adjudicación) y el resumen de la tarjeta; `analisis.campos` es entonces un AnalisisLicitacion (campos con cita). null en el resto.
      licitacion: conv.fuente === 'placsp' && licitacionDe(conv) ? { anuncio: licitacionDe(conv), tarjeta: resumenTarjetaLicitacion(db, conv), esAnalisisLicitacion: esAnalisisLicitacion(datosAnalisis?.analisis) } : null,
    });
  });

  api.get('/ejecuciones', (c) => c.json(ultimasEjecuciones(db, 20)));

  // "Cómo sabemos": resultados del backtest (npm run backtest). Público y sin datos del equipo. Si esta BD aún no tiene resultados se sirve el
  // informe exportado en seed/backtest.json (así la demo desplegada enseña los números que se calcularon al preparar la entrega).
  api.get('/backtest', (c) => {
    const informe = construirInforme(db, reloj.now());
    if (Object.keys(informe.modos).length) return c.json({ ...informe, origen: 'bd' });
    const ruta = opciones.rutaBacktest ?? config.rutaBacktest;
    if (existsSync(ruta)) {
      try {
        return c.json({ ...(JSON.parse(readFileSync(ruta, 'utf8')) as Informe), origen: 'fichero' });
      } catch {
        // Fichero ilegible: se sirve como vacío en vez de romper la página.
      }
    }
    return c.json({ ...informe, origen: 'vacio' });
  });

  return api;
}
