// Ficha de una licitación (fuente placsp): el mismo marco de dos columnas que la de una convocatoria, con los datos de un contrato: presupuesto base sin IVA, plazo de
// ofertas, duración, lotes, solvencia, criterios de adjudicación y reserva social. Cada dato del análisis lleva su cita; lo que sale del anuncio de la Plataforma se dice.
import type { Dispatch, SetStateAction } from 'react';
import { type CamposLicitacion, type DecisionEquipo, type Ficha as TFicha, type NotaEquipo } from './api.ts';
import { BotonesDecision, Notas } from './Decision.tsx';
import { Cita, citado, Dato, Desconocido, euros, fecha, TARJETA } from './ficha-comun.tsx';
import { OrigenFuente } from './Origen.tsx';
import { SeccionExperiencia } from './Experiencia.tsx';
import { SeccionPlazo, textoCierre } from './Plazo.tsx';
import { SeccionPuntuacion } from './Puntuacion.tsx';
import { useSesion } from './Sesion.tsx';

const eurosEnteros = (n: number) => `${Math.round(n).toLocaleString('es-ES')} €`;
const corto = (t: string, max = 260) => (t.length <= max ? t : `${t.slice(0, max - 1).replace(/[\s,;:.]+$/, '')}…`);

function Enlaces({ licitacion }: { licitacion: NonNullable<TFicha['licitacion']> }) {
  const docs = licitacion.anuncio.documentos;
  if (docs.length === 0) return null;
  return (
    <div className="mt-4 border-t border-linea pt-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-tinta-suave">Pliegos y documentos</h3>
      <ul className="mt-1.5 space-y-1.5">
        {docs.slice(0, 8).map((d) => (
          <li key={d.url}>
            <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-baseline gap-1 text-sm text-marca-fuerte underline-offset-2 hover:underline">
              <span className="[overflow-wrap:anywhere]">{d.clase === 'pliego_administrativo' ? 'Pliego administrativo' : d.clase === 'pliego_tecnico' ? 'Pliego técnico' : 'Documento'}: {d.titulo}</span>
              <span aria-hidden="true">↗</span><span className="sr-only">(se abre en otra pestaña)</span>
            </a>
          </li>
        ))}
        {docs.length > 8 && <li className="text-xs text-tinta-suave">y {docs.length - 8} más en la Plataforma</li>}
      </ul>
    </div>
  );
}

export function FichaLicitacion({ ficha, licitacion, decision, setDecision, notas, setNotas }: {
  ficha: TFicha;
  licitacion: NonNullable<TFicha['licitacion']>;
  decision: DecisionEquipo | null;
  setDecision: Dispatch<SetStateAction<DecisionEquipo | null>>;
  notas: NotaEquipo[];
  setNotas: Dispatch<SetStateAction<NotaEquipo[]>>;
}) {
  const { puedeEditar } = useSesion();
  const { anuncio: l, tarjeta: t } = licitacion;
  const a = licitacion.esAnalisisLicitacion ? (ficha.analisis?.campos as CamposLicitacion) : undefined;
  const plazo = ficha.plazo;
  const cierre = plazo && textoCierre(plazo);
  const cerrada = plazo?.diasHastaCierre != null && plazo.diasHastaCierre < 0;
  const hora = l.plazoOfertas?.hora ? ` a las ${l.plazoOfertas.hora}` : '';
  const sede = ficha.enlaces.find((e) => e.tipo === 'ficha')?.url;

  // Presupuesto: con cita si el análisis lo leyó; si no, el del anuncio (dato estructurado de la Plataforma).
  const presupuesto = a?.presupuestoBase.valor
    ? { ...citado(a.presupuestoBase), valor: `${a.presupuestoBase.valor}${/IVA/i.test(a.presupuestoBase.valor) ? '' : ' (sin IVA)'}` }
    : { valor: l.presupuestoSinIva ? `${euros(l.presupuestoSinIva)} (sin IVA, según el anuncio)` : null, cita: null, documento: null };
  const solvEco = a?.solvenciaEconomica.valor ? citado(a.solvenciaEconomica) : { valor: l.solvenciaEconomica[0] ? corto(l.solvenciaEconomica[0], 220) : null, cita: null, documento: null };
  const solvTec = a?.solvenciaTecnica.valor ? citado(a.solvenciaTecnica) : { valor: l.solvenciaTecnica[0] ? corto(l.solvenciaTecnica[0], 220) : null, cita: null, documento: null };
  const reserva = a?.reservaSocial.valor;

  return (
    <div>
      <header className="mb-6 max-w-3xl">
        <h1 className="text-2xl font-bold leading-snug tracking-tight sm:text-3xl [overflow-wrap:anywhere]">{ficha.tituloCorto}</h1>
        {ficha.tituloCorto !== ficha.titulo && <p className="mt-1 text-sm text-tinta-suave [overflow-wrap:anywhere]">Título oficial: {ficha.titulo}</p>}
        <p className="mt-1 text-tinta-suave">{ficha.organo}{l.organoCiudad && ` (${l.organoCiudad})`}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tinta-suave">
          <span className="rounded-full bg-marca-suave px-2 py-0.5 text-[11px] font-semibold text-marca-fuerte ring-1 ring-marca-borde">Licitación</span>
          <span>Publicada el {fecha(ficha.fechaPublicacion)}</span>
          <OrigenFuente fuente={ficha.fuente} url={sede} />
          {l.expediente && <span>Expediente {l.expediente}</span>}
          {l.tipoContrato && <span>{l.tipoContrato}</span>}
          {l.procedimiento && <span>Procedimiento {l.procedimiento.toLowerCase()}</span>}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <aside aria-label="Datos clave" className="order-first lg:sticky lg:top-6 lg:order-last">
          <div className="rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <dl className="divide-y divide-linea">
              <Dato nombre="Presupuesto base de licitación" valor={presupuesto.valor} cita={presupuesto.cita} documento={presupuesto.documento} resaltar={t.fueraDeEscala ? 'mal' : undefined} />
              {t.valorEstimado !== null && <Dato nombre="Valor estimado (con prórrogas)" valor={eurosEnteros(t.valorEstimado)} />}
              <Dato nombre="Plazo de ofertas" valor={cierre ?? (l.plazoOfertas ? `${fecha(l.plazoOfertas.fecha)}${hora}` : null)} cita={a?.plazo.cita} documento={a?.plazo.documento} resaltar={cerrada ? 'mal' : plazo?.diasHastaCierre != null && plazo.diasHastaCierre <= 5 ? 'aviso' : undefined} />
              <Dato nombre="Duración" valor={a?.duracion.valor ?? l.duracion} cita={a?.duracion.cita} documento={a?.duracion.documento} />
              <Dato nombre="Lotes" valor={t.lotes} cita={a?.lotes.cita} documento={a?.lotes.documento} />
              <Dato nombre="Solvencia económica" valor={solvEco.valor} cita={solvEco.cita} documento={solvEco.documento} />
              <Dato nombre="Solvencia técnica" valor={solvTec.valor} cita={solvTec.cita} documento={solvTec.documento} />
              {a?.clasificacion.valor && <Dato nombre="Clasificación empresarial" valor={a.clasificacion.valor} cita={a.clasificacion.cita} documento={a.clasificacion.documento} resaltar="aviso" />}
              <Dato nombre="Peso del precio" valor={t.ponderacionPrecio !== null ? `${t.ponderacionPrecio} puntos de 100${a?.ponderacionPrecio.valor ? '' : ' (según el anuncio)'}` : null} cita={a?.ponderacionPrecio.cita} documento={a?.ponderacionPrecio.documento} />
              <Dato nombre="¿Podemos presentarnos?" valor={reserva === 'si' ? 'No: reservado a otro tipo de entidad' : reserva === 'no' ? 'Sí, sin reserva' : null} cita={a?.reservaSocial.cita} documento={a?.reservaSocial.documento} resaltar={reserva === 'si' ? 'mal' : reserva === 'no' ? 'bien' : undefined} />
            </dl>
            {puedeEditar && <div className="border-t border-linea"><BotonesDecision id={ficha.id} decision={decision} alCambiar={setDecision} /></div>}
            <div className="mt-4 border-t border-linea pt-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-tinta-suave">Plataforma de Contratación</h3>
              <p className="mt-1.5"><a href={sede ?? ficha.url} target="_blank" rel="noreferrer" className="inline-flex items-baseline gap-1 text-sm text-marca-fuerte underline-offset-2 hover:underline">Ficha de la licitación<span aria-hidden="true">↗</span><span className="sr-only">(se abre en otra pestaña)</span></a></p>
            </div>
            <Enlaces licitacion={licitacion} />
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
          {t.fueraDeEscala && (
            <p className="mb-5 rounded-md bg-aviso-suave p-3 text-sm text-aviso ring-1 ring-aviso-borde">
              <strong>Probablemente fuera de escala.</strong> El presupuesto base ({eurosEnteros(t.presupuesto ?? 0)}{t.presupuestoDeLote ? ', el del lote más pequeño' : ''}) supera lo que la entidad puede asumir
              (solvencia, personal y ejecución para un contrato de ese tamaño).
            </p>
          )}

          {!a && (
            <section className={TARJETA}>
              <h2 className="text-lg font-semibold">Por qué pasó la criba</h2>
              <p className="mt-1.5">{t.porQue ?? ficha.criba?.motivo ?? <Desconocido />}</p>
              <p className="mt-3 text-sm text-tinta-suave">Aún sin analizar: no hay idea de oferta ni datos con cita de los pliegos. Los datos de arriba son los del anuncio de la Plataforma.</p>
            </section>
          )}
          {a && (
            <section className={TARJETA}>
              <h2 className="text-lg font-semibold">Idea de oferta</h2>
              <p className="mt-1.5 whitespace-pre-line">{a.ideaProyecto ?? <Desconocido />}</p>
              <h3 className="mt-5 text-sm font-semibold text-tinta-suave">Líneas de Reforesta con las que encaja</h3>
              {a.lineas.length === 0 ? <p className="mt-1 text-tinta-suave">Ninguna clara</p> : (
                <ul className="mt-1 space-y-2">
                  {a.lineas.map((x) => (
                    <li key={x.linea}>
                      <span className="font-semibold">{x.linea}</span>
                      {x.motivo && <span className="text-tinta-suave">: {x.motivo}</span>}
                      {x.cita && <Cita cita={x.cita} documento={x.documento} />}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="mt-5 text-sm font-semibold text-tinta-suave">Requisitos principales</h3>
              {a.requisitos.length === 0 ? <p className="mt-1"><Desconocido /></p> : (
                <ul className="mt-1 space-y-2">{a.requisitos.map((q, i) => <li key={i}>{q.valor}{q.cita && <Cita cita={q.cita} documento={q.documento} />}</li>)}</ul>
              )}
            </section>
          )}

          {l.criterios.length > 0 && (
            <section className={TARJETA} aria-label="Criterios de adjudicación">
              <h2 className="text-lg font-semibold">Criterios de adjudicación</h2>
              <p className="text-xs text-tinta-suave">Según el anuncio de la Plataforma.</p>
              <ul className="mt-2 divide-y divide-linea">
                {l.criterios.map((k, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="mr-2 rounded bg-fondo-suave px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-tinta-suave">{k.tipo === 'OBJ' ? 'automático' : k.tipo === 'SUBJ' ? 'juicio de valor' : k.tipo}</span>
                      {k.lote && <span className="text-tinta-suave">Lote {k.lote} · </span>}{corto(k.descripcion, 200)}
                    </span>
                    {k.peso !== null && <span className="shrink-0 font-semibold tabular-nums">{k.peso}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {l.lotes.length > 0 && (
            <section className={TARJETA} aria-label="Lotes">
              <h2 className="text-lg font-semibold">Lotes ({l.lotes.length})</h2>
              <ul className="mt-2 divide-y divide-linea">
                {l.lotes.map((x, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 [overflow-wrap:anywhere]">Lote {x.id ?? i + 1}: {x.nombre ?? 'sin nombre'}</span>
                    {x.presupuestoSinIva !== null && <span className="shrink-0 tabular-nums">{eurosEnteros(x.presupuestoSinIva)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <SeccionExperiencia experiencia={ficha.experiencia} />
          <SeccionPlazo plazo={ficha.plazo} />
          {ficha.criba && !ficha.criba.descarta && <p className="mb-5 text-sm text-tinta-suave"><span className="font-medium">Criba:</span> {ficha.criba.motivo}</p>}
          <SeccionPuntuacion puntuacion={ficha.puntuacion} />
          {puedeEditar && <Notas id={ficha.id} notas={notas} alCambiar={setNotas} />}
          {ficha.analisis && (
            <footer className="mt-4 space-y-1 text-xs text-tinta-suave">
              <p>Leído: {ficha.analisis.documentos.map((d) => d.titulo).join(' · ') || '—'}</p>
              {ficha.analisis.documentosConError.length > 0 && <p>No se pudieron leer los pliegos: {ficha.analisis.documentosConError.join(' · ')}</p>}
              {a && a.correcciones.length > 0 && <p>Quitado por no tener cita comprobable: {a.correcciones.length} dato(s).</p>}
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}
