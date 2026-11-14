import { useEffect, useState } from 'react';
import { type DecisionEquipo, type LicitacionLista, type Licitaciones as TLicitaciones, leerDecisiones, leerLicitaciones, rutaFicha } from './api.ts';
import { BotonesDecision } from './Decision.tsx';
import { Plegable } from './Plegable.tsx';
import { Nota } from './Puntuacion.tsx';
import { useSesion } from './Sesion.tsx';

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const eurosEnteros = (n: number) => `${Math.round(n).toLocaleString('es-ES')} €`;
const dia = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
const instante = (iso: string) => new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });
const CHIP = 'rounded-full bg-fondo-suave px-2.5 py-0.5 text-xs text-tinta';

/** «Ofertas: faltan 12 días (hasta el 28 dic)» / «las ofertas se presentan hoy». */
export function TextoOfertas({ l }: { l: LicitacionLista }) {
  const p = l.plazo;
  if (!p?.fechaCierre || p.diasHastaCierre === null) return <>Plazo de ofertas por confirmar</>;
  const d = p.diasHastaCierre;
  const cuando = d < 0 ? 'ofertas cerradas' : d === 0 ? 'ofertas: hoy' : d === 1 ? 'ofertas: mañana' : `ofertas: faltan ${d} días`;
  return <>{cuando} (hasta el {dia(p.fechaCierre)})</>;
}

/** Tarjeta de una licitación: título, órgano, presupuesto sin IVA, plazo de ofertas, lotes, por qué encaja y titular de la solvencia. */
function Tarjeta({ l, decision, alCambiar, puedeEditar }: { l: LicitacionLista; decision: DecisionEquipo | null; alCambiar: (d: DecisionEquipo | null) => void; puedeEditar: boolean }) {
  const t = l.tarjeta;
  const dias = l.plazo?.diasHastaCierre ?? null;
  const urgente = dias !== null && dias >= 0 && dias <= 5;
  const verFicha = <a href={rutaFicha(l.id)} className="ml-auto rounded-md px-2 py-1.5 text-sm font-medium text-marca-fuerte hover:underline">Ver ficha →</a>;
  return (
    <li className="rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-semibold leading-snug [overflow-wrap:anywhere]">
          <a href={rutaFicha(l.id)} className="text-tinta hover:text-marca-fuerte hover:underline">{t.tituloCorto}</a>
        </h3>
        <Nota puntuacion={l.puntuacion} />
      </div>
      <p className="mt-0.5 text-sm text-tinta-suave [overflow-wrap:anywhere]">{l.organo}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="rounded-full bg-marca-suave px-2.5 py-0.5 text-xs font-semibold text-marca-fuerte ring-1 ring-marca-borde">Licitación</span>
        <span className={t.fueraDeEscala ? 'rounded-full bg-aviso-suave px-2.5 py-0.5 text-xs font-semibold text-aviso ring-1 ring-aviso-borde' : CHIP}>
          {t.presupuesto !== null ? `${t.presupuestoDeLote ? 'Lote desde ' : ''}${eurosEnteros(t.presupuesto)} sin IVA` : 'Presupuesto por confirmar'}
          {t.fueraDeEscala && ' · probablemente fuera de escala'}
        </span>
        <span className={urgente ? 'rounded-full bg-aviso-suave px-2.5 py-0.5 text-xs font-semibold text-aviso ring-1 ring-aviso-borde' : CHIP}><TextoOfertas l={l} /></span>
        {t.lotes && <span className={CHIP}>{t.lotes}</span>}
        {t.lineas.map((x) => <span key={x} className="rounded-full bg-marca-suave px-2.5 py-0.5 text-xs text-marca-fuerte">{x}</span>)}
      </div>
      {t.porQue && <p className="mt-3 text-sm text-tinta">{t.porQue}</p>}
      {t.solvencia && (
        <p className="mt-2 text-sm text-tinta-suave [overflow-wrap:anywhere]">
          <span className="font-medium text-tinta">Solvencia:</span> {t.solvencia.texto}{t.solvencia.origen === 'anuncio' && <span className="text-xs"> (según el anuncio)</span>}
        </p>
      )}
      {puedeEditar
        ? <BotonesDecision id={l.id} decision={decision} alCambiar={alCambiar} extra={verFicha} />
        : <div className="mt-3 flex">{verFicha}</div>}
    </li>
  );
}

/** Fila compacta para lo plegado. */
function Fila({ l }: { l: LicitacionLista }) {
  const t = l.tarjeta;
  const sinAnalizar = !l.puntuacion?.analizada;
  return (
    <li className="flex items-start justify-between gap-3 border-b border-linea py-2.5 last:border-b-0">
      <div className="min-w-0">
        <a href={rutaFicha(l.id)} className="font-medium text-tinta hover:text-marca-fuerte hover:underline [overflow-wrap:anywhere]">{t.tituloCorto}</a>
        <p className="text-xs text-tinta-suave">
          {l.organo} · {t.presupuesto !== null ? `${eurosEnteros(t.presupuesto)} sin IVA` : 'presupuesto por confirmar'}{t.fueraDeEscala && ' (probablemente fuera de escala)'} · <TextoOfertas l={l} />{sinAnalizar && ' · sin analizar todavía'}
        </p>
      </div>
      {!sinAnalizar && <Nota puntuacion={l.puntuacion} />}
    </li>
  );
}

/** Página «Licitaciones»: los contratos públicos abiertos (PLACSP) que encajan, aparte de las convocatorias de ayudas. */
export function Licitaciones() {
  const [datos, setDatos] = useState<TLicitaciones | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { puedeEditar } = useSesion();
  const [decisiones, setDecisiones] = useState<Map<string, DecisionEquipo>>(new Map());

  useEffect(() => { leerLicitaciones().then(setDatos, (e: Error) => setError(e.message)); }, []);
  useEffect(() => {
    if (!puedeEditar) { setDecisiones(new Map()); return; }
    leerDecisiones().then((ds) => setDecisiones(new Map(ds.map((d) => [d.convocatoriaId, d]))), () => { /* sin acceso al equipo: sin botones marcados */ });
  }, [puedeEditar]);

  const alCambiar = (id: string, d: DecisionEquipo | null) => {
    setDecisiones((m) => { const n = new Map(m); if (d) n.set(id, d); else n.delete(id); return n; });
    if (d?.decision === 'descartada') {
      setDatos((s) => s && { ...s, licitaciones: s.licitaciones.filter((x) => x.id !== id), paraPreparar: s.paraPreparar.filter((x) => x !== id), conMenosEncaje: s.conMenosEncaje.filter((x) => x !== id) });
    }
  };

  if (error) return <p role="alert" className="rounded-md bg-peligro-suave p-4 text-peligro">No se pudo cargar la lista: {error}</p>;
  if (!datos) return <p className="text-tinta-suave">Cargando…</p>;

  const por = new Map(datos.licitaciones.map((l) => [l.id, l]));
  const lista = (ids: string[]) => ids.map((id) => por.get(id)).filter((l): l is LicitacionLista => !!l);
  const arriba = lista(datos.paraPreparar);
  const menos = lista(datos.conMenosEncaje);
  const pronto = arriba.filter((l) => l.plazo?.diasHastaCierre != null && l.plazo.diasHastaCierre <= 7).length;

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {arriba.length === 0 ? 'Ninguna licitación para preparar' : `${plural(arriba.length, 'licitación', 'licitaciones')} para preparar`}
        </h1>
        <p className="mt-1 text-tinta-suave">
          Contratos públicos abiertos (Plataforma de Contratación del Sector Público) de servicios y obras que encajan con las líneas de Reforesta, dentro de su territorio.
          {pronto > 0 && ` ${pronto === 1 ? 'Una presenta' : `${pronto} presentan`} ofertas en menos de una semana.`}
        </p>
        <p className="mt-1 text-sm text-tinta-suave">
          Presupuesto base sin IVA; por encima de {eurosEnteros(datos.presupuestoMaximo)} se marca como «probablemente fuera de escala» (unos {(datos.presupuestoMaximo / datos.ingresosAnuales).toFixed(0)} años de ingresos por servicios). Aparte de las convocatorias de <a href="/" className="text-marca-fuerte underline">Esta semana</a>.
        </p>
      </header>

      {arriba.length > 0 && (
        <ul className="mb-6 space-y-3" aria-label="Licitaciones para preparar">
          {arriba.map((l) => <Tarjeta key={l.id} l={l} decision={decisiones.get(l.id) ?? null} alCambiar={(d) => alCambiar(l.id, d)} puedeEditar={puedeEditar} />)}
        </ul>
      )}

      {menos.length > 0 && (
        <Plegable titulo={`Otras ${menos.length} que pasaron la criba · ver`} abiertaInicial={arriba.length === 0}
          ayuda={`Sin analizar todavía, por debajo de ${datos.umbral} puntos o fuera de escala. Por puntuación.`}>
          <ul>{menos.map((l) => <Fila key={l.id} l={l} />)}</ul>
        </Plegable>
      )}

      {arriba.length === 0 && menos.length === 0 && (
        <p className="rounded-md bg-superficie p-4 text-tinta-suave ring-1 ring-linea">No hay licitaciones abiertas que encajen ahora mismo. El radar revisa a diario el feed de la Plataforma de Contratación.</p>
      )}

      {datos.ultimaEjecucion && (
        <p className="mt-8 border-t border-linea pt-4 text-xs text-tinta-suave">
          Última revisión: {instante(datos.ultimaEjecucion.inicio)}
          {datos.ultimaEjecucion.estado === 'con_errores' && ' · con errores en alguna fuente'}
        </p>
      )}
    </div>
  );
}
