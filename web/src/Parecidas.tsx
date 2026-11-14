import { type FormEvent, useEffect, useState } from 'react';
import { useSesion } from './Sesion.tsx';
import { activarParecida, anadirParecida, leerParecidas, type Parecida, quitarParecida } from './api.ts';

const ORIGEN: Record<Parecida['origen'], string> = { calculada: 'calculada', semilla: 'de partida', manual: 'manual', derivada: 'de partida' };

/** Ajuste de las organizaciones parecidas: las desactivadas no aportan convocatorias en la siguiente ejecución. */
export function Parecidas() {
  const { puedeEditar } = useSesion();
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
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Organizaciones parecidas</h1>
        <p className="mt-1 text-sm text-tinta-suave">
          Buscamos las convocatorias que ganan estas organizaciones desde 2022 y avisamos cuando sale una edición nueva. Desactiva las que no se
          parecen a Reforesta (p. ej. federaciones de caza) o añade otras por NIF. Los cambios cuentan desde la siguiente ejecución del radar.
        </p>
      </header>

      {error && <p role="alert" className="mb-4 rounded-md bg-peligro-suave p-3 text-peligro">{error}</p>}

      {puedeEditar && <form onSubmit={alta} className="mb-6 rounded-lg bg-superficie p-4 shadow-sm ring-1 ring-linea">
        <h2 className="mb-2 font-semibold">Añadir una organización</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={nif} onChange={(e) => setNif(e.target.value)} placeholder="NIF (p. ej. G78456118)" aria-label="NIF" required
            className="rounded border border-linea-fuerte px-3 py-2 text-sm sm:w-52" />
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre (opcional)" aria-label="Nombre"
            className="min-w-0 flex-1 rounded border border-linea-fuerte px-3 py-2 text-sm" />
          <button type="submit" disabled={ocupado || !nif.trim()} className="rounded bg-marca px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Añadir</button>
        </div>
      </form>}

      {!lista && !error && <p className="text-tinta-suave">Cargando…</p>}
      {lista && lista.length === 0 && <p className="rounded-md bg-superficie p-4 text-tinta-suave shadow-sm">Todavía no hay organizaciones parecidas.</p>}
      {lista && lista.length > 0 && (
        <ul className="space-y-3">
          {lista.map((p) => (
            <li key={p.nif} className={`rounded-lg bg-superficie p-4 shadow-sm ring-1 ring-linea ${p.activa ? '' : 'opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold [overflow-wrap:anywhere]">{p.nombre}</p>
                  <p className="mt-0.5 text-xs text-tinta-suave">
                    {p.nif} · origen {ORIGEN[p.origen]} · {p.coincidencias} coincidencia{p.coincidencias === 1 ? '' : 's'} con Reforesta · {p.convocatorias} convocatoria{p.convocatorias === 1 ? '' : 's'} aportada{p.convocatorias === 1 ? '' : 's'}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-sm">
                  <input type="checkbox" checked={p.activa} disabled={ocupado || !puedeEditar} onChange={(e) => void accion(() => activarParecida(p.nif, e.target.checked))} />
                  {p.activa ? 'Activa' : 'Desactivada'}
                </label>
              </div>
              {puedeEditar && p.origen === 'manual' && (
                <button type="button" disabled={ocupado} onClick={() => void accion(() => quitarParecida(p.nif))} className="mt-2 text-xs text-peligro hover:underline disabled:opacity-50">
                  Quitar de la lista
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
