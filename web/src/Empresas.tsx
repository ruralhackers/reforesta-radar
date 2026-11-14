import { useEffect, useState } from 'react';
import { actualizarEmpresa, type Empresa, type EstadoEmpresa, leerEmpresas } from './api.ts';
import { useSesion } from './Sesion.tsx';

const ESTADOS: { valor: EstadoEmpresa; etiqueta: string }[] = [
  { valor: 'pendiente', etiqueta: 'Pendiente' },
  { valor: 'contactada', etiqueta: 'Contactada' },
  { valor: 'descartada', etiqueta: 'Descartada' },
];
const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Madrid' });

function Tarjeta({ e, puedeEditar, alCambiar }: { e: Empresa; puedeEditar: boolean; alCambiar: (e: Empresa) => void }) {
  const [nota, setNota] = useState(e.nota ?? '');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abiertas, setAbiertas] = useState(false);

  async function guardar(cambios: { estado?: EstadoEmpresa; nota?: string }) {
    setOcupado(true);
    setError(null);
    try {
      const r = await actualizarEmpresa(e.id, cambios);
      alCambiar({ ...e, estado: r.estado, nota: r.nota });
      setNota(r.nota ?? '');
    } catch (x) { setError((x as Error).message); } finally { setOcupado(false); }
  }

  return (
    <li className={`rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200 ${e.estado === 'descartada' ? 'opacity-70' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-semibold [overflow-wrap:anywhere]">
          {e.nombre}
          {e.provincia && <span className="ml-2 rounded-full bg-stone-100 px-2 py-0.5 align-middle text-[11px] font-medium text-stone-600">{e.provincia}</span>}
        </p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${e.estado === 'contactada' ? 'bg-emerald-100 text-emerald-800' : e.estado === 'descartada' ? 'bg-stone-200 text-stone-600' : 'bg-amber-100 text-amber-800'}`}>
          {ESTADOS.find((s) => s.valor === e.estado)?.etiqueta}
        </span>
      </div>
      <p className="mt-1 text-sm [overflow-wrap:anywhere]">{e.motivo}</p>
      <blockquote className="mt-2 border-l-2 border-emerald-300 pl-3 text-sm italic text-stone-700 [overflow-wrap:anywhere]">«{e.cita}»</blockquote>
      <p className="mt-2 text-xs text-stone-600">
        Vista por primera vez el {fecha(e.primeraVezVista)} · <a href={e.enlace} target="_blank" rel="noreferrer" className="text-emerald-800 hover:underline">{e.origen === 'huella_carbono' ? 'Registro de huella de carbono (MITECO)' : 'Resolución en el BOE'}</a>
        {e.cif && <> · {e.cif}</>}
        {e.paginaRsc && <> · <a href={e.paginaRsc} target="_blank" rel="noreferrer" className="text-emerald-800 hover:underline">RSC</a></>}
      </p>
      {e.senales.length > 1 && (
        <div className="mt-2 text-xs">
          <button type="button" onClick={() => setAbiertas(!abiertas)} className="text-emerald-800 hover:underline">{abiertas ? 'Ocultar' : 'Ver'} las {e.senales.length} señales (DIA del BOE, registro de huella de carbono)</button>
          {abiertas && <ul className="mt-1 list-disc space-y-1 pl-5 text-stone-600">
            {e.senales.map((s) => <li key={s.boeId} className="[overflow-wrap:anywhere]"><a href={s.enlace} target="_blank" rel="noreferrer" className="text-emerald-800 hover:underline">{s.tipo === 'huella_carbono' ? 'Registro de huella de carbono' : fecha(s.fechaPublicacion)}</a> · {s.proyecto ?? s.motivo}</li>)}
          </ul>}
        </div>
      )}
      {puedeEditar && (
        <div className="mt-3 space-y-2 border-t border-stone-100 pt-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Estado">
            {ESTADOS.map((s) => (
              <button key={s.valor} type="button" disabled={ocupado || e.estado === s.valor} onClick={() => void guardar({ estado: s.valor })}
                className={`rounded border px-3 py-1 text-xs ${e.estado === s.valor ? 'border-emerald-700 bg-emerald-700 text-white' : 'border-stone-300 text-stone-700'} disabled:opacity-60`}>{s.etiqueta}</button>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <textarea value={nota} onChange={(ev) => setNota(ev.target.value)} rows={2} maxLength={2000} placeholder="Nota del equipo (quién la contactó, qué dijo…)" aria-label={`Nota sobre ${e.nombre}`} className="w-full rounded border border-stone-300 px-3 py-2 text-sm" />
            <button type="button" disabled={ocupado || nota.trim() === (e.nota ?? '')} onClick={() => void guardar({ nota })} className="self-start rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Guardar nota</button>
          </div>
          {error && <p role="alert" className="rounded bg-red-50 px-2 py-1 text-xs text-red-800">{error}</p>}
        </div>
      )}
    </li>
  );
}

/** Empresas obligadas por una DIA del BOE a restaurar o compensar, o del registro de huella de carbono del MITECO: las nuevas primero, con filtro por estado y, para el equipo, estado y nota. */
export function Empresas() {
  const { puedeEditar, cargada } = useSesion();
  const [lista, setLista] = useState<Empresa[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<EstadoEmpresa | 'todas'>('todas');

  // Con sesión de equipo se lee la versión con notas; sin ella, la pública.
  useEffect(() => {
    if (!cargada) return;
    leerEmpresas(puedeEditar).then(setLista, (e: Error) => setError(e.message));
  }, [cargada, puedeEditar]);

  const visibles = (lista ?? []).filter((e) => filtro === 'todas' || e.estado === filtro);
  const cambiar = (n: Empresa) => setLista((l) => l && l.map((e) => (e.id === n.id ? n : e)));

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700"><a href="/" className="hover:underline">Radar de convocatorias</a></p>
        <h1 className="text-2xl font-bold sm:text-3xl">Empresas</h1>
        <p className="mt-1 text-sm text-stone-600">
          Empresas que una declaración de impacto ambiental del BOE obliga a restaurar o compensar (hábitat, reforestación, aves…) o que compensan su huella de carbono en el registro del MITECO:
          posibles patrocinadoras de proyectos de restauración. Solo datos públicos de la empresa y de la fuente; no se guardan personas de contacto.
        </p>
      </header>

      {error && <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-red-800">{error}</p>}

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
        {(['todas', ...ESTADOS.map((s) => s.valor)] as const).map((v) => (
          <button key={v} type="button" onClick={() => setFiltro(v)} aria-pressed={filtro === v}
            className={`rounded-full border px-3 py-1 text-xs ${filtro === v ? 'border-emerald-700 bg-emerald-700 text-white' : 'border-stone-300 text-stone-700'}`}>
            {v === 'todas' ? 'Todas' : ESTADOS.find((s) => s.valor === v)!.etiqueta}
            {lista && <span className="ml-1 opacity-70">({v === 'todas' ? lista.length : lista.filter((e) => e.estado === v).length})</span>}
          </button>
        ))}
      </div>

      {!lista && !error && <p className="text-stone-500">Cargando…</p>}
      {lista && visibles.length === 0 && <p className="rounded-md bg-white p-4 text-stone-600 shadow-sm">{lista.length === 0 ? 'Todavía no se ha encontrado ninguna empresa.' : 'No hay empresas con ese estado.'}</p>}
      <ul className="space-y-3">
        {visibles.map((e) => <Tarjeta key={e.id} e={e} puedeEditar={puedeEditar} alCambiar={cambiar} />)}
      </ul>
    </main>
  );
}
