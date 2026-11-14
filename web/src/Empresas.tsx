import { Fragment, useEffect, useId, useState } from 'react';
import { actualizarEmpresa, type Empresa, type EstadoEmpresa, leerEmpresas } from './api.ts';
import { ChipYaFinanciador } from './Experiencia.tsx';
import { useSesion } from './Sesion.tsx';

const ESTADOS: { valor: EstadoEmpresa; etiqueta: string }[] = [
  { valor: 'pendiente', etiqueta: 'Pendiente' },
  { valor: 'contactada', etiqueta: 'Contactada' },
  { valor: 'descartada', etiqueta: 'Descartada' },
];
/** Filas que se ven de entrada en cada tabla; el resto, tras «Ver las restantes». */
const LIMITE_FILAS = 12;
const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Madrid' });

/** Origen en una palabra: de dónde sale la señal más fuerte de la empresa. */
const ORIGEN: Record<number, { texto: string; clase: string }> = {
  3: { texto: 'DIA', clase: 'bg-marca-suave text-marca-fuerte' },
  2: { texto: 'Compensa', clase: 'bg-aviso-suave text-aviso' },
  1: { texto: 'Zona y sector', clase: 'bg-fondo-suave text-tinta-suave' },
};

type FiltroOrigen = 'todos' | 'dia_boe' | 'huella_carbono' | 'compra_absorcion';
const ORIGENES: { valor: FiltroOrigen; etiqueta: string }[] = [
  { valor: 'todos', etiqueta: 'Todos los orígenes' },
  { valor: 'dia_boe', etiqueta: 'DIA' },
  { valor: 'huella_carbono', etiqueta: 'Compensa huella' },
  { valor: 'compra_absorcion', etiqueta: 'Compra absorción' },
];
const tieneOrigen = (e: Empresa, o: FiltroOrigen) => o === 'todos' || e.senales.some((s) => s.tipo === o) || (e.senales.length === 0 && e.origen === o);

const CLASE_ESTADO: Record<EstadoEmpresa, string> = {
  pendiente: 'border-aviso-borde bg-aviso-suave text-aviso',
  contactada: 'border-marca-borde bg-marca-suave text-marca-fuerte',
  descartada: 'border-linea-fuerte bg-fondo-suave text-tinta-suave',
};

function Fila({ e, puedeEditar, conEstado, alCambiar, columnas }: { e: Empresa; puedeEditar: boolean; conEstado: boolean; alCambiar: (e: Empresa) => void; columnas: number }) {
  const [abierta, setAbierta] = useState(false);
  const [nota, setNota] = useState(e.nota ?? '');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idDetalle = useId();
  const origen = ORIGEN[e.prioridad] ?? ORIGEN[1];

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
    <Fragment>
      <tr className={`border-t border-linea align-top ${e.estado === 'descartada' ? 'opacity-70' : ''} ${abierta ? 'bg-fondo-suave' : ''}`}>
        <td className="px-3 py-3">
          <button type="button" onClick={() => setAbierta(!abierta)} aria-expanded={abierta} aria-controls={idDetalle} className="flex items-start gap-2 text-left">
            <span aria-hidden="true" className={`mt-0.5 inline-block text-tinta-suave transition-transform ${abierta ? 'rotate-90' : ''}`}>▸</span>
            <span className="min-w-0">
              <span className="font-semibold text-tinta [overflow-wrap:anywhere]">{e.nombre}</span>
              <span className={`ml-2 rounded px-1.5 py-0.5 align-middle text-[11px] font-medium ${origen.clase}`}>{origen.texto}</span>
              <ChipYaFinanciador ya={e.yaFinanciador} />
              {e.prioridad < 3 && e.senales.some((s) => s.tipo === 'compra_absorcion') && <span className="ml-1 rounded bg-marca-suave px-1.5 py-0.5 align-middle text-[11px] font-medium text-marca-fuerte">Compra absorción</span>}
              <span className="mt-0.5 block text-sm font-normal text-tinta sm:hidden">{e.motivo}</span>
              {e.provincia && <span className="block text-xs font-normal text-tinta-suave sm:hidden">{e.provincia}</span>}
            </span>
          </button>
        </td>
        <td className="hidden px-3 py-3 text-sm sm:table-cell [overflow-wrap:anywhere]">{e.motivo}</td>
        <td className="hidden whitespace-nowrap px-3 py-3 text-sm sm:table-cell">{e.provincia ?? '—'}</td>
        {conEstado && (
          <td className="px-3 py-3">
            {puedeEditar && e.estado ? (
              <select
                value={e.estado} disabled={ocupado} aria-label={`Estado de ${e.nombre}`}
                onChange={(ev) => void guardar({ estado: ev.target.value as EstadoEmpresa })}
                className={`rounded-md border px-2 py-1 text-sm font-medium ${CLASE_ESTADO[e.estado]}`}
              >
                {ESTADOS.map((s) => <option key={s.valor} value={s.valor}>{s.etiqueta}</option>)}
              </select>
            ) : e.estado ? (
              <span className={`rounded-md border px-2 py-1 text-sm font-medium ${CLASE_ESTADO[e.estado]}`}>{ESTADOS.find((s) => s.valor === e.estado)?.etiqueta}</span>
            ) : null}
          </td>
        )}
      </tr>
      {abierta && (
        <tr id={idDetalle} className="bg-fondo-suave">
          <td colSpan={columnas} className="px-3 pb-4 pt-1">
            <blockquote className="border-l-2 border-marca-borde pl-3 text-sm italic text-tinta [overflow-wrap:anywhere]">«{e.cita}»</blockquote>
            <p className="mt-2 text-sm text-tinta-suave">
              Vista por primera vez el {fecha(e.primeraVezVista)} ·{' '}
              <a href={e.enlace} target="_blank" rel="noreferrer" className="text-marca-fuerte underline">{e.origen === 'dia_boe' ? 'Resolución en el BOE' : e.origen === 'compra_absorcion' ? 'Listado de compensaciones (MITECO)' : 'Registro de huella de carbono (MITECO)'}<span className="sr-only"> (se abre en otra pestaña)</span></a>
              {e.cif && <> · {e.cif}</>}
              {e.paginaRsc && <> · <a href={e.paginaRsc} target="_blank" rel="noreferrer" className="text-marca-fuerte underline">RSC</a></>}
            </p>
            {(e.senales.length > 1 || e.senales.some((s) => s.tipo === 'compra_absorcion')) && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-tinta-suave">
                {e.senales.map((s) => (
                  <li key={s.boeId} className="[overflow-wrap:anywhere]">
                    <a href={s.enlace} target="_blank" rel="noreferrer" className="text-marca-fuerte underline">{s.tipo === 'huella_carbono' ? 'Registro de huella de carbono' : s.tipo === 'compra_absorcion' ? 'Compra de absorciones' : fecha(s.fechaPublicacion)}</a>
                    {s.tipo === 'compra_absorcion' ? <> · {s.motivo}. Proyecto: {s.proyecto}</> : <> · {s.proyecto ?? s.motivo}</>}
                  </li>
                ))}
              </ul>
            )}
            {puedeEditar && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <textarea value={nota} onChange={(ev) => setNota(ev.target.value)} rows={2} maxLength={2000} placeholder="Nota del equipo (quién la contactó, qué dijo…)" aria-label={`Nota sobre ${e.nombre}`} className="w-full rounded-md border border-linea-fuerte bg-superficie px-3 py-2 text-sm" />
                <button type="button" disabled={ocupado || nota.trim() === (e.nota ?? '')} onClick={() => void guardar({ nota })} className="self-start rounded-md bg-marca px-4 py-2 text-sm font-medium text-white hover:bg-marca-fuerte disabled:opacity-50">Guardar nota</button>
              </div>
            )}
            {error && <p role="alert" className="mt-2 rounded bg-peligro-suave px-2 py-1 text-sm text-peligro">{error}</p>}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function Tabla({ lista, puedeEditar, conEstado, alCambiar, titulo }: { lista: Empresa[]; puedeEditar: boolean; conEstado: boolean; alCambiar: (e: Empresa) => void; titulo: string }) {
  const columnas = conEstado ? 4 : 3;
  const [todas, setTodas] = useState(false);
  const mostradas = todas ? lista : lista.slice(0, LIMITE_FILAS);
  return (
    <div className="overflow-hidden rounded-[var(--radio)] bg-superficie ring-1 ring-linea">
      <table className="w-full text-left">
        <caption className="sr-only">{titulo}</caption>
        <thead className="bg-fondo-suave text-xs uppercase tracking-wide text-tinta-suave">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Empresa</th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">Por qué</th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">Dónde</th>
            {conEstado && <th scope="col" className="px-3 py-2 font-medium">Estado</th>}
          </tr>
        </thead>
        <tbody>{mostradas.map((e) => <Fila key={e.id} e={e} puedeEditar={puedeEditar} conEstado={conEstado} alCambiar={alCambiar} columnas={columnas} />)}</tbody>
      </table>
      {lista.length > mostradas.length && (
        <button type="button" onClick={() => setTodas(true)} className="w-full border-t border-linea px-3 py-2.5 text-left text-sm font-medium text-marca-fuerte hover:bg-fondo-suave">▸ Ver las {lista.length - mostradas.length} restantes</button>
      )}
    </div>
  );
}

/** Empresas obligadas por una DIA del BOE a restaurar o compensar, o del registro de huella de carbono del MITECO: tabla tipo CRM, priorizada; la fila se despliega con la cita, el enlace y las notas. */
export function Empresas() {
  const { puedeEditar, cargada } = useSesion();
  const [lista, setLista] = useState<Empresa[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<EstadoEmpresa | 'todas'>('todas');
  const [ocultas, setOcultas] = useState(0);
  const [verBaja, setVerBaja] = useState(false);
  const [origenFiltro, setOrigenFiltro] = useState<FiltroOrigen>('todos');

  // Con sesión de equipo se lee la versión con notas; sin ella, la pública. Las de baja confianza solo si se piden.
  useEffect(() => {
    if (!cargada) return;
    leerEmpresas(puedeEditar, verBaja).then((r) => { setLista(r.empresas); setOcultas(r.ocultas); }, (e: Error) => setError(e.message));
  }, [cargada, puedeEditar, verBaja]);

  const visibles = (lista ?? []).filter((e) => (!puedeEditar || filtro === 'todas' || e.estado === filtro) && tieneOrigen(e, origenFiltro));
  const cambiar = (n: Empresa) => setLista((l) => l && l.map((e) => (e.id === n.id ? n : e)));
  const conEstado = (lista ?? []).some((e) => e.estado !== undefined);
  const dia = visibles.filter((e) => e.prioridad >= 3);
  const compensan = visibles.filter((e) => e.prioridad === 2);
  const baja = visibles.filter((e) => e.prioridad < 2);
  const comun = { puedeEditar, conEstado, alCambiar: cambiar };

  return (
    <div className="max-w-4xl">
      <header className="mb-6 max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Empresas</h1>
        <p className="mt-1 text-sm text-tinta-suave">
          Posibles patrocinadoras de proyectos de restauración, por prioridad: primero las que una declaración de impacto ambiental (DIA) del BOE obliga a restaurar o compensar,
          luego las que compensan su huella de carbono o compran créditos de absorción de proyectos forestales (registro del MITECO), sobre todo en los territorios del perfil o en los últimos dos años. Solo datos públicos de la empresa y de la fuente; no se guardan personas de contacto.
          Pulsa una fila para ver la cita y las notas.
        </p>
      </header>

      {error && <p role="alert" className="mb-4 rounded-md bg-peligro-suave p-3 text-peligro">{error}</p>}

      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filtrar por origen">
        {ORIGENES.map((o) => (
          <button key={o.valor} type="button" onClick={() => setOrigenFiltro(o.valor)} aria-pressed={origenFiltro === o.valor}
            className={`rounded-full border px-3 py-1 text-sm ${origenFiltro === o.valor ? 'border-marca bg-marca text-white' : 'border-linea-fuerte bg-superficie text-tinta hover:bg-fondo-suave'}`}>
            {o.etiqueta}
            {lista && <span className="ml-1 opacity-80">({lista.filter((e) => tieneOrigen(e, o.valor)).length})</span>}
          </button>
        ))}
      </div>

      {puedeEditar && <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar por estado">
        {(['todas', ...ESTADOS.map((s) => s.valor)] as const).map((v) => (
          <button key={v} type="button" onClick={() => setFiltro(v)} aria-pressed={filtro === v}
            className={`rounded-full border px-3 py-1 text-sm ${filtro === v ? 'border-marca bg-marca text-white' : 'border-linea-fuerte bg-superficie text-tinta hover:bg-fondo-suave'}`}>
            {v === 'todas' ? 'Todas' : ESTADOS.find((s) => s.valor === v)!.etiqueta}
            {lista && <span className="ml-1 opacity-80">({v === 'todas' ? lista.length : lista.filter((e) => e.estado === v).length})</span>}
          </button>
        ))}
      </div>}

      {!lista && !error && <p className="text-tinta-suave">Cargando…</p>}
      {lista && visibles.length === 0 && <p className="rounded-md bg-superficie p-4 text-tinta-suave ring-1 ring-linea">{lista.length === 0 ? 'Todavía no se ha encontrado ninguna empresa.' : 'No hay empresas con ese estado.'}</p>}

      {dia.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-semibold">Obligadas por una DIA <span className="text-sm font-normal text-tinta-suave">({dia.length})</span></h2>
          <Tabla lista={dia} titulo="Empresas obligadas por una DIA del BOE" {...comun} />
        </section>
      )}
      {compensan.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-semibold">Compensan su huella o compran absorciones <span className="text-sm font-normal text-tinta-suave">({compensan.length})</span></h2>
          <Tabla lista={compensan} titulo="Empresas que compensan su huella de carbono o compran créditos de absorción" {...comun} />
        </section>
      )}

      {ocultas > 0 && !verBaja && (
        <p className="mt-4 text-sm"><button type="button" onClick={() => setVerBaja(true)} className="rounded text-marca-fuerte underline">▸ Baja confianza: {ocultas} empresas más (grandes del sector y la zona, sin compensación conocida) · ver</button></p>
      )}
      {verBaja && baja.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-1 text-lg font-semibold">Baja confianza <span className="text-sm font-normal text-tinta-suave">({baja.length})</span></h2>
          <p className="mb-3 text-sm text-tinta-suave">Solo por tamaño, sector y zona; el registro no dice que compensen. Útiles si las de arriba no bastan.</p>
          <Tabla lista={baja} titulo="Empresas de baja confianza" {...comun} />
        </section>
      )}
    </div>
  );
}
