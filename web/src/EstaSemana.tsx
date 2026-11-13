import { useEffect, useState } from 'react';
import { type Semana, leerSemana, rutaFicha } from './api.ts';

const fecha = (dia: string) =>
  new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

const instante = (iso: string) =>
  new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });

export function EstaSemana() {
  const [semana, setSemana] = useState<Semana | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    leerSemana().then(setSemana, (e: Error) => setError(e.message));
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">Radar de convocatorias</p>
        <h1 className="text-2xl font-bold sm:text-3xl">Esta semana</h1>
        {semana && (
          <p className="mt-1 text-sm text-stone-600">
            Publicadas del {fecha(semana.desde)} al {fecha(semana.hasta)} · {semana.convocatorias.length} candidatas
          </p>
        )}
      </header>

      {error && <p className="rounded-md bg-red-50 p-4 text-red-800">No se pudo cargar la lista: {error}</p>}
      {!semana && !error && <p className="text-stone-500">Cargando…</p>}

      {semana && semana.convocatorias.length === 0 && (
        <p className="rounded-md bg-white p-4 text-stone-600 shadow-sm">No hay convocatorias candidatas esta semana.</p>
      )}

      <ul className="space-y-3">
        {semana?.convocatorias.map((c) => (
          <li key={c.id} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
            <a href={rutaFicha(c.id)} className="font-semibold leading-snug text-emerald-800 hover:underline [overflow-wrap:anywhere]">
              {c.titulo}
            </a>
            <p className="mt-1 text-sm text-stone-600">{c.organo}</p>
            <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-stone-500">
              <span>{fecha(c.fechaPublicacion)}</span>
              <a href={c.url} target="_blank" rel="noreferrer" className="uppercase hover:underline">{c.fuente}</a>
            </p>
          </li>
        ))}
      </ul>

      {semana?.ultimaEjecucion && (
        <footer className="mt-8 border-t border-stone-200 pt-4 text-xs text-stone-500">
          Última revisión: {instante(semana.ultimaEjecucion.inicio)}
          {semana.ultimaEjecucion.estado === 'con_errores' && ' · con errores en alguna fuente'}
        </footer>
      )}
    </main>
  );
}
