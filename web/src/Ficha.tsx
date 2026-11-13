import { useEffect, useState } from 'react';
import { type CampoCitado, type Ficha as TFicha, leerFicha } from './api.ts';
import { SeccionPlazo } from './Plazo.tsx';
import { SeccionPuntuacion } from './Puntuacion.tsx';

const fecha = (dia: string) =>
  new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

const ETIQUETA_ENLACE: Record<TFicha['enlaces'][number]['tipo'], string> = {
  ficha: 'Ficha', bases: 'Bases', extracto: 'Extracto', sede: 'Sede electrónica', documento: 'Documento',
};

function Desconocido({ motivo }: { motivo?: string }) {
  return (
    <span title={motivo} className="inline-block rounded bg-stone-200 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-stone-600">
      desconocido
    </span>
  );
}

function Cita({ cita, documento }: { cita: string; documento: string | null }) {
  return (
    <blockquote className="mt-1 border-l-2 border-emerald-300 pl-3 text-sm italic text-stone-600 [overflow-wrap:anywhere]">
      «{cita}»{documento && <span className="not-italic text-stone-400"> — {documento}</span>}
    </blockquote>
  );
}

function Campo({ nombre, campo, formato }: { nombre: string; campo: CampoCitado; formato?: (v: string) => string }) {
  return (
    <div className="py-3">
      <dt className="text-sm font-medium text-stone-500">{nombre}</dt>
      <dd className="mt-0.5">
        {campo.valor === null ? (
          <Desconocido motivo={campo.motivo} />
        ) : (
          <>
            <span className="font-semibold">{formato ? formato(campo.valor) : campo.valor}</span>
            {campo.cita && <Cita cita={campo.cita} documento={campo.documento} />}
          </>
        )}
      </dd>
    </div>
  );
}

export function Ficha({ id }: { id: string }) {
  const [ficha, setFicha] = useState<TFicha | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    leerFicha(id).then(setFicha, (e: Error) => setError(e.message));
  }, [id]);

  const a = ficha?.analisis?.campos;
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <a href="/" className="text-sm text-emerald-700 hover:underline">← Esta semana</a>
      {error && <p className="mt-4 rounded-md bg-red-50 p-4 text-red-800">No se pudo cargar la ficha: {error}</p>}
      {!ficha && !error && <p className="mt-4 text-stone-500">Cargando…</p>}
      {ficha && (
        <>
          <header className="mt-3 mb-6">
            <h1 className="text-xl font-bold leading-snug sm:text-2xl [overflow-wrap:anywhere]">{ficha.titulo}</h1>
            <p className="mt-1 text-sm text-stone-600">{ficha.organo}</p>
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-stone-500">
              <span>{fecha(ficha.fechaPublicacion)}</span>
              <span className="uppercase">{ficha.fuente}</span>
              {ficha.tipo && <span>{ficha.tipo}</span>}
            </p>
            <nav className="mt-3 flex flex-wrap gap-2">
              {ficha.enlaces.map((e) => (
                <a key={e.url} href={e.url} target="_blank" rel="noreferrer" title={e.titulo}
                  className="rounded-full bg-white px-3 py-1 text-sm text-emerald-800 shadow-sm ring-1 ring-stone-200 hover:bg-emerald-50">
                  {ETIQUETA_ENLACE[e.tipo]}
                </a>
              ))}
            </nav>
          </header>

          {!ficha.enJuego && (
            <p className="mb-4 rounded-md bg-amber-50 p-4 text-sm text-amber-900">
              {ficha.descarte ? `Descartada por reglas: ${ficha.descarte.motivo}`
                : ficha.analisis?.descarta ? `Descartada en el análisis: ${ficha.analisis.motivo}`
                : ficha.criba?.descarta ? `Descartada en la criba: ${ficha.criba.motivo}`
                : `Pendiente de criba: ${ficha.condicion}`}
            </p>
          )}
          {ficha.criba && !ficha.criba.descarta && (
            <p className="mb-4 text-sm text-stone-600"><span className="font-medium">Criba:</span> {ficha.criba.motivo}</p>
          )}

          <SeccionPuntuacion puntuacion={ficha.puntuacion} />
          <SeccionPlazo plazo={ficha.plazo} />

          {!a && <p className="rounded-md bg-white p-4 text-stone-600 shadow-sm">Aún sin analizar.</p>}
          {a && (
            <section className="rounded-lg bg-white px-4 shadow-sm ring-1 ring-stone-200">
              <dl className="divide-y divide-stone-100">
                <Campo nombre="¿Pueden pedirla entidades sin ánimo de lucro?" campo={a.elegibilidadEsfl} formato={(v) => (v === 'si' ? 'Sí' : 'No')} />
                <Campo nombre="Importe máximo por proyecto" campo={a.importeMaximoProyecto} />
                <Campo nombre="Importe total" campo={a.importeTotal} />
                <Campo nombre="Plazo" campo={a.plazo} />
                <Campo nombre="Cofinanciación" campo={a.cofinanciacion} />
                <div className="py-3">
                  <dt className="text-sm font-medium text-stone-500">Requisitos principales</dt>
                  <dd className="mt-0.5">
                    {a.requisitos.length === 0 ? <Desconocido /> : (
                      <ul className="space-y-2">
                        {a.requisitos.map((q, i) => (
                          <li key={i}>{q.valor}{q.cita && <Cita cita={q.cita} documento={q.documento} />}</li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
                <div className="py-3">
                  <dt className="text-sm font-medium text-stone-500">Líneas con las que encaja</dt>
                  <dd className="mt-0.5">
                    {a.lineas.length === 0 ? <span className="text-stone-500">Ninguna clara</span> : (
                      <ul className="space-y-2">
                        {a.lineas.map((l) => (
                          <li key={l.linea}>
                            <span className="font-semibold">{l.linea}</span>
                            {l.motivo && <span className="text-stone-600">: {l.motivo}</span>}
                            {l.cita && <Cita cita={l.cita} documento={l.documento} />}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
                <div className="py-3">
                  <dt className="text-sm font-medium text-stone-500">Idea de proyecto</dt>
                  <dd className="mt-0.5 whitespace-pre-line">{a.ideaProyecto ?? <Desconocido />}</dd>
                </div>
              </dl>
            </section>
          )}
          {ficha.analisis && (
            <footer className="mt-4 space-y-1 text-xs text-stone-500">
              <p>Leído: {ficha.analisis.documentos.map((d) => d.titulo).join(' · ') || '—'}</p>
              {ficha.analisis.documentosConError.length > 0 && <p>No se pudieron leer: {ficha.analisis.documentosConError.join(' · ')}</p>}
              {a && a.correcciones.length > 0 && <p>Quitado por no tener cita comprobable: {a.correcciones.length} dato(s).</p>}
            </footer>
          )}
        </>
      )}
    </main>
  );
}
