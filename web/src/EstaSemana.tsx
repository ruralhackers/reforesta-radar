import { useEffect, useState } from 'react';
import { type ConvocatoriaSemana, type DecisionEquipo, type Semana, leerDecisiones, leerSemana, rutaFicha } from './api.ts';
import { BotonesDecision } from './Decision.tsx';
import { Cierre } from './Plazo.tsx';
import { Nota } from './Puntuacion.tsx';
import { useSesion } from './Sesion.tsx';

const instante = (iso: string) =>
  new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** La frase de arriba: qué toca esta semana. */
function Resumen({ s }: { s: Semana }) {
  const { paraPreparar, cierranPronto, empresasNuevas } = s.resumen;
  const semanas = Math.round(s.cierranProntoDias / 7);
  const partes = [
    paraPreparar > 0 && (cierranPronto === 0 ? 'ninguna cierra pronto' : `${cierranPronto} ${cierranPronto === 1 ? 'cierra' : 'cierran'} en menos de ${semanas} semanas`),
    empresasNuevas > 0 && `${plural(empresasNuevas, 'empresa nueva', 'empresas nuevas')}`,
  ].filter(Boolean);
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        {paraPreparar === 0 ? 'Nada que preparar esta semana' : `${plural(paraPreparar, 'convocatoria', 'convocatorias')} para preparar`}
      </h1>
      {partes.length > 0 && <p className="mt-1 text-tinta-suave">{partes.join(' · ')}</p>}
      {paraPreparar === 0 && <p className="mt-1 text-tinta-suave">Ninguna analizada llega al encaje mínimo ({s.umbral} puntos). Puedes bajarlo en el <a href="/perfil" className="text-marca-fuerte underline">perfil</a>.</p>}
    </header>
  );
}

function Parecida({ c }: { c: ConvocatoriaSemana }) {
  if (!c.parecidas) return null;
  const nombres = c.parecidas.organizaciones.map((o) => o.nombre).join(', ');
  return (
    <p className="mt-2 text-xs text-aviso">
      <span className="rounded bg-aviso-suave px-2 py-0.5 font-medium">La ganan organizaciones como vosotros</span>{' '}
      {c.parecidas.descubierta ? 'La hemos encontrado por ' : 'Entre los ganadores previos: '}{nombres}
    </p>
  );
}

const CHIP = 'rounded-full bg-fondo-suave px-2.5 py-0.5 text-xs text-tinta';

/** Tarjeta corta: título corto, qué decide (cierre, importe, línea), una frase de por qué y las acciones. */
function Tarjeta({ c, semana, decision, alCambiar, puedeEditar }: { c: ConvocatoriaSemana; semana: Semana; decision: DecisionEquipo | null; alCambiar: (d: DecisionEquipo | null) => void; puedeEditar: boolean }) {
  const dias = c.plazo?.diasHastaCierre ?? null;
  const urgente = dias !== null && dias >= 0 && dias <= semana.cierranProntoDias;
  const verFicha = <a href={rutaFicha(c.id)} className="ml-auto rounded-md px-2 py-1.5 text-sm font-medium text-marca-fuerte hover:underline">Ver ficha →</a>;
  return (
    <li className="rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-base font-semibold leading-snug [overflow-wrap:anywhere]">
          <a href={rutaFicha(c.id)} className="text-tinta hover:text-marca-fuerte hover:underline">{c.tarjeta.tituloCorto}</a>
        </h3>
        <Nota puntuacion={c.puntuacion} />
      </div>
      <p className="mt-0.5 text-sm text-tinta-suave [overflow-wrap:anywhere]">{c.organo}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {c.plazo?.fechaCierre && c.plazo.diasHastaCierre !== null && (
          <span className={`rounded-full px-2.5 py-0.5 text-xs ${urgente ? 'bg-aviso-suave font-semibold text-aviso ring-1 ring-aviso-borde' : CHIP}`}><Cierre plazo={c.plazo} /></span>
        )}
        <span className={CHIP}>{c.tarjeta.importe ?? 'Importe por confirmar'}</span>
        {c.tarjeta.lineas.map((l) => <span key={l} className="rounded-full bg-marca-suave px-2.5 py-0.5 text-xs text-marca-fuerte">{l}</span>)}
      </div>
      {c.tarjeta.porQue && <p className="mt-3 text-sm text-tinta">{c.tarjeta.porQue}</p>}
      <Parecida c={c} />
      {puedeEditar
        ? <BotonesDecision id={c.id} decision={decision} alCambiar={alCambiar} extra={verFicha} />
        : <div className="mt-3 flex">{verFicha}</div>}
    </li>
  );
}

/** Fila compacta para lo plegado: sin botones, con el motivo de que no esté arriba. */
function Fila({ c }: { c: ConvocatoriaSemana }) {
  const sinAnalizar = !c.puntuacion?.analizada;
  return (
    <li className="flex items-start justify-between gap-3 border-b border-linea py-2.5 last:border-b-0">
      <div className="min-w-0">
        <a href={rutaFicha(c.id)} className="font-medium text-tinta hover:text-marca-fuerte hover:underline [overflow-wrap:anywhere]">{c.tarjeta.tituloCorto}</a>
        <p className="text-xs text-tinta-suave">
          {c.organo}{c.plazo?.fechaCierre && <> · <Cierre plazo={c.plazo} /></>}{sinAnalizar && ' · sin analizar todavía'}
        </p>
      </div>
      {!sinAnalizar && <Nota puntuacion={c.puntuacion} />}
    </li>
  );
}

function Plegable({ id, titulo, ayuda, abiertaInicial = false, children }: { id?: string; titulo: string; ayuda?: string; abiertaInicial?: boolean; children: React.ReactNode }) {
  return (
    <details id={id} open={abiertaInicial} className="group mb-6 rounded-[var(--radio)] bg-superficie ring-1 ring-linea">
      <summary className="cursor-pointer list-none rounded-[var(--radio)] px-4 py-3 text-sm font-medium text-marca-fuerte hover:bg-fondo-suave [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>{titulo}
      </summary>
      <div className="px-4 pb-3">
        {ayuda && <p className="mb-2 text-sm text-tinta-suave">{ayuda}</p>}
        {children}
      </div>
    </details>
  );
}

export function EstaSemana() {
  const [semana, setSemana] = useState<Semana | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { puedeEditar } = useSesion();
  const [decisiones, setDecisiones] = useState<Map<string, DecisionEquipo>>(new Map());

  useEffect(() => {
    leerSemana().then(setSemana, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!puedeEditar) { setDecisiones(new Map()); return; }
    leerDecisiones().then((ds) => setDecisiones(new Map(ds.map((d) => [d.convocatoriaId, d]))), () => { /* sin acceso al equipo: sin botones marcados */ });
  }, [puedeEditar]);

  // Descartar la quita de la lista (el servidor ya no la devuelve); "nos interesa" solo marca la fila.
  const alCambiar = (id: string, d: DecisionEquipo | null) => {
    setDecisiones((m) => { const n = new Map(m); if (d) n.set(id, d); else n.delete(id); return n; });
    if (d?.decision === 'descartada') {
      setSemana((s) => s && {
        ...s,
        convocatorias: s.convocatorias.filter((c) => c.id !== id),
        paraPreparar: s.paraPreparar.filter((x) => x !== id),
        conMenosEncaje: s.conMenosEncaje.filter((x) => x !== id),
        lasGananParecidas: s.lasGananParecidas.filter((x) => x !== id),
        resumen: { ...s.resumen, paraPreparar: s.paraPreparar.filter((x) => x !== id).length },
      });
    }
  };

  if (error) return <p role="alert" className="rounded-md bg-peligro-suave p-4 text-peligro">No se pudo cargar la lista: {error}</p>;
  if (!semana) return <p className="text-tinta-suave">Cargando…</p>;

  const por = new Map(semana.convocatorias.map((c) => [c.id, c]));
  const lista = (ids: string[]) => ids.map((id) => por.get(id)).filter((c): c is ConvocatoriaSemana => !!c);
  const arriba = lista(semana.paraPreparar);
  const menos = lista(semana.conMenosEncaje);
  const consorcio = semana.convocatorias.filter((c) => c.seccion === 'consorcio');

  return (
    <div className="max-w-3xl">
      <Resumen s={semana} />

      {arriba.length > 0 && (
        <ul className="mb-6 space-y-3" aria-label="Convocatorias para preparar">
          {arriba.map((c) => <Tarjeta key={c.id} c={c} semana={semana} decision={decisiones.get(c.id) ?? null} alCambiar={(d) => alCambiar(c.id, d)} puedeEditar={puedeEditar} />)}
        </ul>
      )}

      {menos.length > 0 && (
        <Plegable titulo={`El radar vio otras ${menos.length} con menos encaje · ver`} ayuda={`Sin analizar todavía, por debajo de ${semana.umbral} puntos o fuera de las 7 de arriba. Por puntuación.`}>
          <ul>{menos.map((c) => <Fila key={c.id} c={c} />)}</ul>
        </Plegable>
      )}

      {consorcio.length > 0 && (
        <Plegable id="consorcio" abiertaInicial={window.location.hash === '#consorcio'} titulo={`UE · como socio de consorcio (${consorcio.length}) · ver`}
          ayuda="Grandes consorcios de investigación (Horizon Europe): para una entidad pequeña solo es realista ir como socia. Su esfuerzo está penalizado en la puntuación.">
          <ul>{consorcio.map((c) => <Fila key={c.id} c={c} />)}</ul>
        </Plegable>
      )}

      {arriba.length === 0 && menos.length === 0 && consorcio.length === 0 && (
        <p className="rounded-md bg-superficie p-4 text-tinta-suave ring-1 ring-linea">No hay convocatorias candidatas esta semana.</p>
      )}

      {semana.ultimaEjecucion && (
        <p className="mt-8 border-t border-linea pt-4 text-xs text-tinta-suave">
          Última revisión: {instante(semana.ultimaEjecucion.inicio)}
          {semana.ultimaEjecucion.estado === 'con_errores' && ' · con errores en alguna fuente'}
        </p>
      )}
    </div>
  );
}
