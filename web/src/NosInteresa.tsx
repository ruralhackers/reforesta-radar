import { useEffect, useState } from 'react';
import { type NosInteresa as TNosInteresa, leerNosInteresa, rutaFicha } from './api.ts';

const fecha = (dia: string) => new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

function Dias({ c }: { c: TNosInteresa }) {
  if (c.fechaCierre === null || c.diasHastaCierre === null) return <span className="text-stone-500">Plazo desconocido</span>;
  const d = c.diasHastaCierre;
  const texto = d < 0 ? 'Cerrada' : d === 0 ? 'Cierra hoy' : d === 1 ? 'Queda 1 día' : `Quedan ${d} días`;
  return <span className={d < 0 ? 'text-stone-500' : d <= 7 ? 'font-semibold text-red-700' : 'text-stone-700'}>{texto} · {fecha(c.fechaCierre)}</span>;
}

/** Las convocatorias marcadas "Nos interesa", por plazo. */
export function NosInteresa() {
  const [lista, setLista] = useState<TNosInteresa[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { leerNosInteresa().then(setLista, (e: Error) => setError(e.message)); }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <a href="/" className="text-sm text-emerald-700 hover:underline">← Esta semana</a>
      <h1 className="mt-3 text-2xl font-bold sm:text-3xl">Nos interesa</h1>
      <p className="mb-4 mt-1 text-sm text-stone-600">Ordenadas por plazo: la que cierra antes, primero; las de plazo desconocido, al final.</p>
      {error && <p className="rounded-md bg-red-50 p-4 text-red-800">No se pudo cargar la lista: {error}</p>}
      {!lista && !error && <p className="text-stone-500">Cargando…</p>}
      {lista && lista.length === 0 && <p className="rounded-md bg-white p-4 text-stone-600 shadow-sm">Todavía no habéis marcado ninguna.</p>}
      <ul className="space-y-3">
        {lista?.map((c) => (
          <li key={c.id} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
            <a href={rutaFicha(c.id)} className="font-semibold leading-snug text-emerald-800 hover:underline [overflow-wrap:anywhere]">{c.titulo}</a>
            <p className="mt-1 text-sm text-stone-600">{c.organo}</p>
            <p className="mt-2 text-sm"><Dias c={c} /></p>
          </li>
        ))}
      </ul>
    </main>
  );
}
