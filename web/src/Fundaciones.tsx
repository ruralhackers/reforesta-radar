import { type FormEvent, useEffect, useState } from 'react';
import { activarFundacion, anadirFundacion, type FuenteVigilada, leerFundaciones, quitarFundacion } from './api.ts';
import { useSesion } from './Sesion.tsx';

const instante = (iso: string) => new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });

/** Fundaciones privadas y agregadores que el radar vigila: cuándo cambió cada página, el último error, y alta / baja / activación del equipo. */
export function Fundaciones() {
  const { puedeEditar } = useSesion();
  const [lista, setLista] = useState<FuenteVigilada[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [url, setUrl] = useState('');
  const [tipo, setTipo] = useState<'fundacion' | 'agregador' | 'premio'>('fundacion');
  const [ocupado, setOcupado] = useState(false);

  const recargar = () => leerFundaciones().then(setLista, (e: Error) => setError(e.message));
  useEffect(() => { void recargar(); }, []);

  async function accion(tarea: () => Promise<unknown>) {
    setOcupado(true);
    setError(null);
    try { await tarea(); await recargar(); } catch (e) { setError((e as Error).message); } finally { setOcupado(false); }
  }

  const alta = (ev: FormEvent) => {
    ev.preventDefault();
    void accion(async () => { await anadirFundacion({ nombre: nombre.trim(), url: url.trim(), tipo }); setNombre(''); setUrl(''); });
  };

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Fundaciones vigiladas</h1>
        <p className="mt-1 text-sm text-tinta-suave">
          Cada ejecución lee la página de convocatorias de estas fundaciones, agregadores y premios. Si su texto ha cambiado, se buscan convocatorias nuevas;
          si no, no se gasta nada. Lo que añadas o quites cuenta desde la siguiente ejecución del radar.
        </p>
      </header>

      {error && <p role="alert" className="mb-4 rounded-md bg-peligro-suave p-3 text-peligro">{error}</p>}

      {puedeEditar && <form onSubmit={alta} className="mb-6 rounded-lg bg-superficie p-4 shadow-sm ring-1 ring-linea">
        <h2 className="mb-2 font-semibold">Añadir una fuente</h2>
        <div className="flex flex-col gap-2">
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre (p. ej. Fundación X)" aria-label="Nombre" required className="rounded border border-linea-fuerte px-3 py-2 text-sm" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (la página de convocatorias)" aria-label="URL" type="url" required className="rounded border border-linea-fuerte px-3 py-2 text-sm" />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select value={tipo} onChange={(e) => setTipo(e.target.value as 'fundacion' | 'agregador' | 'premio')} aria-label="Tipo" className="rounded border border-linea-fuerte px-3 py-2 text-sm">
              <option value="fundacion">Fundación o empresa con convocatoria propia</option>
              <option value="agregador">Agregador de convocatorias</option>
              <option value="premio">Premios (convocatoria de premios)</option>
            </select>
            <button type="submit" disabled={ocupado || !nombre.trim() || !url.trim()} className="rounded bg-marca px-4 py-2 text-sm font-medium text-white disabled:opacity-50 sm:ml-auto">Añadir</button>
          </div>
        </div>
      </form>}

      {!lista && !error && <p className="text-tinta-suave">Cargando…</p>}
      {lista && lista.length === 0 && <p className="rounded-md bg-superficie p-4 text-tinta-suave shadow-sm">Todavía no se vigila ninguna fundación.</p>}
      {lista && lista.length > 0 && (
        <ul className="space-y-3">
          {lista.map((f) => (
            <li key={f.id} className={`rounded-lg bg-superficie p-4 shadow-sm ring-1 ring-linea ${f.activa ? '' : 'opacity-70'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold [overflow-wrap:anywhere]">
                    {f.nombre} <span className="ml-1 rounded-full bg-fondo-suave px-2 py-0.5 align-middle text-[11px] font-medium text-tinta-suave">{f.tipo === 'agregador' ? 'Agregador' : f.tipo === 'premio' ? 'Premio' : 'Fundación'}</span>
                  </p>
                  {f.url
                    ? <p className="mt-0.5 text-xs [overflow-wrap:anywhere]"><a href={f.url} target="_blank" rel="noreferrer" className="text-marca-fuerte hover:underline">{f.url}</a></p>
                    : <p className="mt-0.5 text-xs text-tinta-suave">Sin página de convocatorias conocida</p>}
                </div>
                <label className="flex shrink-0 items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.activa} disabled={ocupado || !puedeEditar || (!f.activa && !f.url)} onChange={(e) => void accion(() => activarFundacion(f.id, e.target.checked))} />
                  {f.activa ? 'Vigilada' : 'Pausada'}
                </label>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-tinta-suave sm:grid-cols-2">
                <div><dt className="inline font-medium">Último cambio: </dt><dd className="inline">{f.ultimoCambio ? instante(f.ultimoCambio) : 'aún no se ha leído'}</dd></div>
                <div><dt className="inline font-medium">Última revisión: </dt><dd className="inline">{f.ultimaRevision ? instante(f.ultimaRevision) : '—'}</dd></div>
              </dl>
              {f.ultimoError && <p role="alert" className="mt-2 rounded bg-peligro-suave px-2 py-1 text-xs text-peligro [overflow-wrap:anywhere]">Último error: {f.ultimoError}</p>}
              {f.notas && <p className="mt-2 text-xs text-tinta-suave [overflow-wrap:anywhere]">{f.notas}</p>}
              {puedeEditar && (
                <button type="button" disabled={ocupado} onClick={() => { if (window.confirm(`¿Quitar «${f.nombre}»? Las convocatorias ya encontradas se conservan.`)) void accion(() => quitarFundacion(f.id)); }} className="mt-2 text-xs text-peligro hover:underline disabled:opacity-50">
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
