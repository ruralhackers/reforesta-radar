import { useEffect, useState } from 'react';
import { type DecisionEquipo, type Ficha as TFicha, type NotaEquipo, leerEquipoFicha, leerFicha } from './api.ts';
import { BotonesDecision, Notas } from './Decision.tsx';
import { SeccionGanadores } from './Ganadores.tsx';
import { SeccionExperiencia } from './Experiencia.tsx';
import { SeccionSerie } from './Serie.tsx';
import { OrigenFuente, TEXTO_CASCADA, etiquetaFuente } from './Origen.tsx';
import { SeccionPlazo, textoCierre } from './Plazo.tsx';
import { SeccionPuntuacion } from './Puntuacion.tsx';
import { useSesion } from './Sesion.tsx';
import { Cita, citado, Dato, Desconocido, euros, fecha, TARJETA } from './ficha-comun.tsx';
import { FichaLicitacion } from './FichaLicitacion.tsx';

/** Historial de Reforesta con esta convocatoria, lo primero que se quiere saber. */
function Historial({ ficha }: { ficha: TFicha }) {
  const { reforestaGano, ediciones } = ficha.ganadoresPrevios;
  if (reforestaGano.length > 0) {
    return (
      <p className="mb-5 rounded-[var(--radio)] bg-marca-suave p-4 text-base font-semibold text-marca-fuerte ring-1 ring-marca-borde">
        Reforesta ganó {reforestaGano.length === 1 ? 'la edición' : 'las ediciones'}{' '}
        {reforestaGano.map((g) => `${g.anio ?? g.numeroConvocatoria}${g.importe !== null ? ` con ${euros(g.importe)}` : ''}`).join(', ')}.
      </p>
    );
  }
  if (ediciones.some((e) => e.reforesta === 'no_figura')) {
    return <p className="mb-5 rounded-[var(--radio)] bg-fondo-suave p-4 text-sm text-tinta">Reforesta no figura entre los ganadores de ediciones anteriores (BDNS solo publica a los ganadores).</p>;
  }
  return null;
}

/** Enlaces con nombre: Bases, Extracto, Sede y cada documento con su nombre real de BDNS. */
function Enlaces({ ficha }: { ficha: TFicha }) {
  const sueltos = ficha.enlaces.filter((e) => e.tipo !== 'documento');
  const docs = ficha.enlaces.filter((e) => e.tipo === 'documento');
  const texto = (e: TFicha['enlaces'][number]) => (e.tipo === 'ficha' ? `Ficha en ${etiquetaFuente(ficha.fuente)}` : e.tipo === 'bases' ? 'Bases' : e.tipo === 'extracto' ? 'Extracto' : e.tipo === 'sede' ? 'Sede electrónica' : e.titulo);
  const enlace = (e: TFicha['enlaces'][number]) => (
    <li key={e.url}>
      <a href={e.url} target="_blank" rel="noreferrer" className="inline-flex items-baseline gap-1 text-sm text-marca-fuerte underline-offset-2 hover:underline">
        <span className="[overflow-wrap:anywhere]">{texto(e)}</span><span aria-hidden="true">↗</span><span className="sr-only">(se abre en otra pestaña)</span>
      </a>
      {e.tipo !== 'documento' && e.titulo !== texto(e) && <span className="block text-xs text-tinta-suave [overflow-wrap:anywhere]">{e.titulo}</span>}
    </li>
  );
  return (
    <div className="mt-4 border-t border-linea pt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-tinta-suave">Enlaces</h3>
      <ul className="mt-1.5 space-y-1.5">{sueltos.map(enlace)}</ul>
      {docs.length > 0 && (
        <>
          <h3 className="mt-3 text-xs font-medium uppercase tracking-wide text-tinta-suave">Documentos de BDNS</h3>
          <ul className="mt-1.5 space-y-1.5">{docs.map(enlace)}</ul>
        </>
      )}
    </div>
  );
}

export function Ficha({ id }: { id: string }) {
  const [ficha, setFicha] = useState<TFicha | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { puedeEditar } = useSesion();
  const [decision, setDecision] = useState<DecisionEquipo | null>(null);
  const [notas, setNotas] = useState<NotaEquipo[]>([]);

  useEffect(() => {
    leerFicha(id).then(setFicha, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(() => {
    if (!puedeEditar) { setDecision(null); setNotas([]); return; }
    leerEquipoFicha(id).then((e) => { setDecision(e.decision); setNotas(e.notas); }, () => { /* sin acceso al equipo: se ve la ficha sin decisión ni notas */ });
  }, [id, puedeEditar]);

  if (error) return <p role="alert" className="rounded-md bg-peligro-suave p-4 text-peligro">No se pudo cargar la ficha: {error}</p>;
  if (!ficha) return <p className="text-tinta-suave">Cargando…</p>;

  if (ficha.licitacion) return <FichaLicitacion ficha={ficha} licitacion={ficha.licitacion} decision={decision} setDecision={setDecision} notas={notas} setNotas={setNotas} />;

  const campos = ficha.analisis?.campos;
  const a = campos && !('tipo' in campos) ? campos : undefined;
  const importe = a && (a.importeMaximoProyecto.valor ? { ...citado(a.importeMaximoProyecto), nombre: 'Importe máximo por proyecto' } : a.importeTotal.valor ? { ...citado(a.importeTotal), nombre: 'Importe total' } : null);
  const esfl = a?.elegibilidadEsfl;
  const sede = a?.elegibilidadSede?.valor === 'no' ? a.elegibilidadSede : null;
  const plazo = ficha.plazo;
  const cierre = plazo && textoCierre(plazo);
  const cerrada = plazo?.diasHastaCierre != null && plazo.diasHastaCierre < 0;
  const citaCierre = plazo?.textoOriginal ?? a?.plazo.cita ?? null;

  return (
    <div>
      <header className="mb-6 max-w-3xl">
        <h1 className="text-2xl font-bold leading-snug tracking-tight sm:text-3xl [overflow-wrap:anywhere]">{ficha.tituloCorto}</h1>
        {ficha.tituloCorto !== ficha.titulo && <p className="mt-1 text-sm text-tinta-suave [overflow-wrap:anywhere]">Título oficial: {ficha.titulo}</p>}
        <p className="mt-1 text-tinta-suave">{ficha.organo}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tinta-suave">
          <span>Publicada el {fecha(ficha.fechaPublicacion)}</span>
          <OrigenFuente fuente={ficha.fuente} url={ficha.enlaces.find((e) => e.tipo === 'ficha')?.url} />
          {ficha.tipo === 'premio'
            ? <span className="rounded-full bg-aviso-suave px-2 py-0.5 text-[11px] font-semibold text-aviso ring-1 ring-aviso-borde">Premio</span>
            : ficha.tipo && <span>{ficha.tipo}</span>}
        </p>
        {ficha.fuente === 'eu_cascada' && <p className="mt-1.5 text-sm text-tinta-suave">{TEXTO_CASCADA}.</p>}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        {/* Panel de datos: fijo a la derecha en escritorio; en móvil, arriba. */}
        <aside aria-label="Datos clave" className="order-first lg:sticky lg:top-6 lg:order-last">
          <div className="rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <dl className="divide-y divide-linea">
              <Dato nombre={importe?.nombre ?? 'Importe'} valor={importe?.valor ?? null} cita={importe?.cita} documento={importe?.documento} />
              <Dato nombre="Cierre" valor={cierre ?? (plazo?.fechaCierre ? fecha(plazo.fechaCierre) : null)} cita={citaCierre} documento={citaCierre && !plazo?.textoOriginal ? a?.plazo.documento : 'texto original'} resaltar={cerrada ? 'mal' : plazo?.diasHastaCierre != null && plazo.diasHastaCierre <= 7 ? 'aviso' : undefined} />
              <Dato nombre="¿Podemos pedirla?" valor={sede ? `No: ${sede.razon ?? 'exige sede en otro territorio'}` : esfl?.valor ? (esfl.valor === 'si' ? 'Sí, admite entidades sin ánimo de lucro' : 'No admite entidades sin ánimo de lucro') : null} cita={sede ? sede.cita : esfl?.cita} documento={sede ? sede.documento : esfl?.documento} resaltar={sede ? 'mal' : esfl?.valor === 'si' ? 'bien' : esfl?.valor === 'no' ? 'mal' : undefined} />
              <Dato nombre="Cofinanciación" valor={a?.cofinanciacion.valor ?? null} cita={a?.cofinanciacion.cita} documento={a?.cofinanciacion.documento} />
            </dl>
            {puedeEditar && <div className="border-t border-linea"><BotonesDecision id={ficha.id} decision={decision} alCambiar={setDecision} /></div>}
            <Enlaces ficha={ficha} />
          </div>
        </aside>

        <div className="min-w-0 max-w-3xl">
          {!ficha.enJuego && (
            <p className="mb-4 rounded-md bg-aviso-suave p-4 text-sm text-aviso">
              {ficha.descarte ? `Descartada por reglas: ${ficha.descarte.motivo}`
                : ficha.analisis?.descarta ? `Descartada en el análisis: ${ficha.analisis.motivo}`
                : ficha.criba?.descarta ? `Descartada en la criba: ${ficha.criba.motivo}`
                : `Pendiente de criba: ${ficha.condicion}`}
            </p>
          )}
          <Historial ficha={ficha} />
          {ficha.parecidas && (
            <p className="mb-5 rounded-md bg-aviso-suave p-3 text-sm text-aviso ring-1 ring-aviso-borde">
              <strong>La ganan organizaciones como vosotros.</strong>{' '}
              {ficha.parecidas.descubierta ? 'La hemos encontrado porque ' : 'Entre los ganadores previos figuran '}
              {ficha.parecidas.organizaciones.slice(0, 4).map((o) => `${o.nombre}${o.anios.length ? ` (${o.anios.join(', ')})` : ''}`).join(', ')}{ficha.parecidas.organizaciones.length > 4 && ` y ${ficha.parecidas.organizaciones.length - 4} más`}
              {ficha.parecidas.descubierta ? ' ganaron una edición anterior.' : '.'}
            </p>
          )}

          {!a && <p className={`${TARJETA} text-tinta-suave`}>Aún sin analizar: no hay idea de proyecto ni datos con cita.</p>}
          {a && (
            <section className={TARJETA}>
              <h2 className="text-lg font-semibold">Idea de proyecto</h2>
              <p className="mt-1.5 whitespace-pre-line">{a.ideaProyecto ?? <Desconocido />}</p>
              <h3 className="mt-5 text-sm font-semibold text-tinta-suave">Líneas de Reforesta con las que encaja</h3>
              {a.lineas.length === 0 ? <p className="mt-1 text-tinta-suave">Ninguna clara</p> : (
                <ul className="mt-1 space-y-2">
                  {a.lineas.map((l) => (
                    <li key={l.linea}>
                      <span className="font-semibold">{l.linea}</span>
                      {l.motivo && <span className="text-tinta-suave">: {l.motivo}</span>}
                      {l.cita && <Cita cita={l.cita} documento={l.documento} />}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="mt-5 text-sm font-semibold text-tinta-suave">Requisitos principales</h3>
              {a.requisitos.length === 0 ? <p className="mt-1"><Desconocido /></p> : (
                <ul className="mt-1 space-y-2">
                  {a.requisitos.map((q, i) => <li key={i}>{q.valor}{q.cita && <Cita cita={q.cita} documento={q.documento} />}</li>)}
                </ul>
              )}
            </section>
          )}

          <SeccionExperiencia experiencia={ficha.experiencia} />
          <SeccionSerie serie={ficha.serie} />
          <SeccionGanadores ganadores={ficha.ganadoresPrevios} />
          <SeccionPlazo plazo={ficha.plazo} />
          {ficha.criba && !ficha.criba.descarta && (
            <p className="mb-5 text-sm text-tinta-suave"><span className="font-medium">Criba:</span> {ficha.criba.motivo}</p>
          )}
          <SeccionPuntuacion puntuacion={ficha.puntuacion} />
          {puedeEditar && <Notas id={ficha.id} notas={notas} alCambiar={setNotas} />}
          {ficha.analisis && (
            <footer className="mt-4 space-y-1 text-xs text-tinta-suave">
              <p>Leído: {ficha.analisis.documentos.map((d) => d.titulo).join(' · ') || '—'}</p>
              {ficha.analisis.documentosConError.length > 0 && <p>No se pudieron leer: {ficha.analisis.documentosConError.join(' · ')}</p>}
              {a && a.correcciones.length > 0 && <p>Quitado por no tener cita comprobable: {a.correcciones.length} dato(s).</p>}
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}
