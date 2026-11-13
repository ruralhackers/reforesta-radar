import { type FormEvent, useEffect, useState } from 'react';
import { activarParecida, anadirParecida, leerParecidas, type Parecida, quitarParecida } from './api.ts';

const ORIGEN: Record<Parecida['origen'], string> = { calculada: 'calculada', semilla: 'de partida', manual: 'manual', derivada: 'de partida' };

/** Ajuste de las organizaciones parecidas: las desactivadas no aportan convocatorias en la siguiente ejecución. */
export function Parecidas() {
  const [lista, setLista] = useState<Parecida[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nif, setNif] = useState('');
  const [nombre, setNombre] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const recargar = () => leerParecidas().then(setLista, (e: Error) => setError(e.message));
  useEffect(() => { void recargar(); }, []);

  async function accion(tarea: () => Promise<unknown>) {
    setOcupado(true);
    setError(null);
    try { await tarea(); await recargar(); } catch (e) { setError((e as Error).message); } finally { setOcupado(false); }
  }

  const alta = (ev: FormEvent) => {
    ev.preventDefault();
    void accion(async () => { await anadirParecida(nif.trim(), nombre.trim()); setNif(''); setNombre(''); });
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700"><a href="/" className="hover:underline">Radar de convocatorias</a></p>
        <h1 className="text-2xl font-bold sm:text-3xl">Organizaciones parecidas</h1>
        <p className="mt-1 text-sm text-stone-600">
          Buscamos las convocatorias que ganan estas organizaciones desde 2022 y avisamos cuando sale una edición nueva. Desactiva las que no se
          parecen a Reforesta (p. ej. federaciones de caza) o añade otras por NIF. Los cambios cuentan desde la siguiente ejecución del radar.
        </p>
      </header>

      {error && <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-red-800">{error}</p>}

      <form onSubmit={alta} className="mb-6 rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
        <h2 className="mb-2 font-semibold">Añadir una organización</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={nif} onChange={(e) => setNif(e.target.value)} placeholder="NIF (p. ej. G78456118)" aria-label="NIF" required
            className="rounded border border-stone-300 px-3 py-2 text-sm sm:w-52" />
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre (opcional)" aria-label="Nombre"
            className="min-w-0 flex-1 rounded border border-stone-300 px-3 py-2 text-sm" />
          <button type="submit" disabled={ocupado || !nif.trim()} className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Añadir</button>
        </div>
      </form>

      {!lista && !error && <p className="text-stone-500">Cargando…</p>}
      {lista && lista.length === 0 && <p className="rounded-md bg-white p-4 text-stone-600 shadow-sm">Todavía no hay organizaciones parecidas.</p>}
      {lista && lista.length > 0 && (
        <ul className="space-y-3">
          {lista.map((p) => (
            <li key={p.nif} className={`rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200 ${p.activa ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold [overflow-wrap:anywhere]">{p.nombre}</p>
                  <p className="mt-0.5 text-xs text-stone-500">
                    {p.nif} · origen {ORIGEN[p.origen]} · {p.coincidencias} coincidencia{p.coincidencias === 1 ? '' : 's'} con Reforesta · {p.convocatorias} convocatoria{p.convocatorias === 1 ? '' : 's'} aportada{p.convocatorias === 1 ? '' : 's'}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-sm">
                  <input type="checkbox" checked={p.activa} disabled={ocupado} onChange={(e) => void accion(() => activarParecida(p.nif, e.target.checked))} />
                  {p.activa ? 'Activa' : 'Desactivada'}
                </label>
              </div>
              {p.origen === 'manual' && (
                <button type="button" disabled={ocupado} onClick={() => void accion(() => quitarParecida(p.nif))} className="mt-2 text-xs text-red-700 hover:underline disabled:opacity-50">
                  Quitar de la lista
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
